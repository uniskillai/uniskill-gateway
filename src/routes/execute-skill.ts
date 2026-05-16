/**
 * src/routes/execute-skill.ts
 * UniSkill Gateway 技能执行路由分发器 (规范化版)
 * 职责：鉴权、加载配置、获取机密信息、执行分发、异步计费。
 */

import { executeCliSkill } from "../skills/execute-cli";
import { executeSkill } from "../engine/executor"; // 保持对 HTTP/Native 引擎的引用
import { errorResponse, corsHeaders } from "../utils/response";
import { getProfile } from "../utils/billing";
import { checkRateLimit } from "../rateLimit"; // 🌟 修复：从正确模块导入

import { SkillParser } from "../engine/parser";
import { SkillKeys } from "../utils/skill-keys";

import type { Env } from "../index";
import type { 
  CliImplementation, 
  CliExecutionContext, 
  CliExecutionResult,

} from "../types/cli";

// ============================================================
// 接口定义：对接新版计费与 Manifest 模型
// ============================================================

interface SkillManifest {
  /** 技能逻辑标识符 (与系统中统一的 skill_name 为准) */
  skill_name: string;
  name: string;
  display_name?: string;
  implementation: any; // 动态实现块
  cost: {
    base_fee_cents: number;
    per_second_cents?: number;
  };
}

// ============================================================
// 核心路由 Handler (Cloudflare Worker fetch handler)
// ============================================================

export async function handleExecuteSkill(request: Request, env: Env, ctx: ExecutionContext, preAuthUid?: string): Promise<Response> {
  const startTime = Date.now();
  
  try {
    // 1. 身份验证 (Authentication & Authorization)
    let payer_id = preAuthUid;

    if (!payer_id) {
      // 仅支持本地签名模式鉴权
      const walletHeader = request.headers.get("X-USK-Wallet");
      if (walletHeader) {
        const { verifySignatureAuth } = await import("../utils/signature");
        payer_id = await verifySignatureAuth(request, env) || undefined;
      }
    }
    
    if (!payer_id) return errorResponse("Unauthorized: Signature required", 401);

    // 2. 解析请求负荷 (Payload Parsing)
    let body: any = {};
    try {
      body = await request.json();
    } catch { /* Allow empty body */ }
    
    // 🌟 规范化：按需兼容 skill_name || skill || skill_id，确保旧版请求不中断
    const skillName = body.skill_name || body.skill || body.skill_id;
    if (!skillName) return errorResponse("Missing skill_name", 400);

    const params = body.payload || body.params || body;

    // 3. 加载技能清单 (具备由系统逻辑定义的向下兼容能力)
    const manifest = await loadSkillManifest(env, skillName, payer_id);
    if (!manifest) return errorResponse(`Skill [${skillName}] not found`, 404);

    // 4. 配额与速率限制检查 (Pre-execution check)
    const profile = await getProfile(env.UNISKILL_KV, payer_id, env);
    const rlResult = await checkRateLimit(payer_id, profile.tier, env);
    if (!rlResult.isAllowed) return errorResponse(`Rate limit exceeded`, 429);

    // 5. 根据 Implementation 类型进行分发
    let executionResult: CliExecutionResult;
    const implementation = manifest.implementation;

    if (implementation && implementation.type === 'cli') {
      // 🚀 分支 A: CLI 运行时
      // 从 Vault 获取该用户授权的机密信息 (基于系统逻辑，通过 payer_id 隔离)
      const secrets = await fetchSecretsFromVault(env, payer_id, skillName);
      
      const cliCtx: CliExecutionContext = {
        skill_name: skillName, // 对齐全域命名规范
        payer_id,
        params: params as Record<string, string>,
        implementation: implementation as CliImplementation,
        secrets
      };

      executionResult = await executeCliSkill(
        cliCtx, 
        env.SANDBOX_NODE_URL || "", 
        env.SANDBOX_INTERNAL_TOKEN || ""
      );
    } else {
      // 🛠 分支 B: 传统 HTTP/Native 运行时 (保持向后兼容)
      try {
        const data = await executeSkill(implementation, params, env, {}, true);
        executionResult = {
          status: 'SUCCESS',
          result: data as Record<string, unknown>, // 类型断言以符合新结果接口
          duration_ms: Date.now() - startTime
        };
      } catch (err: any) {
        executionResult = {
          status: 'FAILED',
          message: err.message,
          result: { error: String(err) },
          duration_ms: Date.now() - startTime
        };
      }
    }

    // 6. 记账与扣费 (直连 Supabase RPC，同步执行以确保 Durable Object 上下文中也能可靠触发)
    // 注意：ctx.waitUntil 在 Durable Object 内部可能不可靠，因此改为 await 直接调用
    await enqueueBillingEvent(env, manifest, payer_id, executionResult);

    // 7. 返回增强型标准化响应
    const statusCode = executionResult.status === 'SUCCESS' ? 200 : 500;
    return new Response(JSON.stringify({
      ...executionResult,
      _uniskill: {
        request_id: request.headers.get("cf-ray") || crypto.randomUUID(),
        status: executionResult.status,
        duration_ms: executionResult.duration_ms
      }
    }), {
      status: statusCode,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-UniSkill-Status": executionResult.status
      }
    });

  } catch (error: any) {
    console.error(`[Gateway Controller Error]`, error);
    return errorResponse(error.message || "Internal Gateway Error", 500);
  }
}

// ============================================================
// 辅助函数：机密信息获取 (Vault 集成，基于 Payer ID)
// ============================================================

async function fetchSecretsFromVault(env: Env, payerId: string, skillName: string): Promise<Record<string, string>> {
  if (!env.VAULT_URL || !env.VAULT_TOKEN) return {};

  const url = `${env.VAULT_URL.replace(/\/$/, "")}/v1/secrets/${payerId}/${skillName}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.VAULT_TOKEN}`,
      "X-UniSkill-Payer-Id": payerId
    }
  });

  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Vault access failed: HTTP ${response.status}`);

  const data = await response.json() as { secrets: Record<string, string> };
  return data.secrets || {};
}

// ============================================================
// 辅助函数：直连 Supabase 计费 (不依赖消息队列)
// ============================================================

async function enqueueBillingEvent(env: Env, manifest: SkillManifest, payerId: string, result: CliExecutionResult) {
  const durationMs = result.duration_ms || 0;
  const costCredits = manifest.cost.base_fee_cents;

  const supabaseUrl = (env as any).SUPABASE_URL;
  const supabaseKey = (env as any).SUPABASE_SERVICE_ROLE_KEY || (env as any).SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[execute-skill] Missing Supabase credentials, billing skipped.');
    return;
  }

  // 直接使用 fetch 调用 Supabase RPC，绕过 JS 客户端库，
  // 并且不传 p_source_skill_uid，避免两个同名 RPC 重载产生 PGRST203 歧义错误
  const rpcPayload = {
    p_user_uid:         payerId,
    p_skill_name:       manifest.skill_name,
    p_payment_type:     'credits',
    p_request_id:       crypto.randomUUID(),
    p_cost:             costCredits,
    p_status_code:      result.status === 'SUCCESS' ? 200 : 500,
    p_execution_status: result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    p_error_message:    result.message || null,
    p_latency_ms:       durationMs,
    p_metadata:         { display_name: manifest.display_name },
    p_display_name:     manifest.display_name,
  };

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/record_skill_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify(rpcPayload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[execute-skill] Billing RPC HTTP ${resp.status}: ${errText}`);
    } else {
      console.log(`[execute-skill] Billing recorded: skill=${manifest.skill_name} user=...${payerId.slice(-6)} cost=${costCredits}`);
    }
  } catch (err) {
    console.error(`[execute-skill] Billing fetch failed:`, err);
  }
}

// ============================================================
// 辅助函数：加载清单与兼容性映射 (映射系统的真实 KV 定义)
// ============================================================

async function loadSkillManifest(env: Env, skillName: string, payerId: string): Promise<SkillManifest | null> {
  const kv = env.SKILLS_KV || env.UNISKILL_KV;
  
  // 查找顺序：私人 (uid:name) -> 官方 (official:name) -> 市场 (market:name)
  let raw: string | null = null;
  const searchPaths = [
    SkillKeys.private(payerId, skillName),
    SkillKeys.official(skillName),
    SkillKeys.market(skillName)
  ];

  for (const path of searchPaths) {
    raw = await kv.get(path);
    if (raw) break;
  }

  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    const spec = SkillParser.parse(raw); // 确保内部 spec 使用 Parser 提取的标准逻辑

    // 🌟 系统核心逻辑桥接：兼容各种命名变体，回退至 KV Key 中的名字
    return {
      skill_name: data.id || data.skill_name || data.name || skillName,
      name: data.name || skillName,
      display_name: data.display_name || data.meta?.name,
      implementation: spec.implementation || data.config || data.implementation,
      cost: {
        // 兼容旧版 credits_per_call 至基础费
        base_fee_cents: Number(data.cost?.base_fee_cents ?? data.credits_per_call ?? data.cost_per_call ?? 1),
        per_second_cents: Number(data.cost?.per_second_cents ?? 0)
      }
    };
  } catch {
    return null;
  }
}

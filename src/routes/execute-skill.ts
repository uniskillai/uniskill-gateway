/**
 * src/routes/execute-skill.ts
 * UniSkill Gateway 技能执行路由分发器 (规范化版)
 * 职责：鉴权、加载配置、获取机密信息、执行分发、异步计费。
 */

import { executeCliSkill } from "../skills/execute-cli";
import { executeSkill } from "../engine/executor"; // 保持对 HTTP/Native 引擎的引用
import { errorResponse, corsHeaders } from "../utils/response";
import { getUserUid, getProfile } from "../utils/billing";
import { checkRateLimit } from "../rateLimit"; // 🌟 修复：从正确模块导入
import { hashKey } from "../utils/auth";
import { SkillParser } from "../engine/parser";
import { SkillKeys } from "../utils/skill-keys";
import type { Env } from "../index";
import type { 
  CliImplementation, 
  CliExecutionContext, 
  CliExecutionResult,
  ExecutionStatus
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

interface BillingEvent {
  skill_name: string;
  payer_id: string;
  status: ExecutionStatus;
  base_fee_cents: number;
  infrastructure_fee_cents: number;
  duration_ms: number;
  timestamp: string;
  metadata?: any;
}

// ============================================================
// 核心路由 Handler (Cloudflare Worker fetch handler)
// ============================================================

export async function handleExecuteSkill(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const startTime = Date.now();
  
  try {
    // 1. 身份验证 (Authentication & Authorization)
    // 锁定 payer_id 来源，防止身份伪造
    const authHeader = request.headers.get("Authorization") || "";
    const rawKey = authHeader.replace("Bearer ", "").trim();
    if (!rawKey.startsWith("us-")) return errorResponse("Invalid Key Format", 401);
    
    const keyHash = await hashKey(rawKey);
    const payer_id = await getUserUid(env.UNISKILL_KV, keyHash, env);
    if (!payer_id) return errorResponse("Unauthorized", 401);

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
    const profile = await getProfile(env.UNISKILL_KV, payer_id, env, keyHash);
    const rlResult = await checkRateLimit(keyHash, profile.tier, env);
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

    // 6. 异步发送计费事件 (非阻塞，使用新版 BillingEvent 格式)
    ctx.waitUntil(enqueueBillingEvent(env, manifest, payer_id, executionResult));

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
// 辅助函数：计费队列分发 (基于规范化后的 Skill Name)
// ============================================================

async function enqueueBillingEvent(env: Env, manifest: SkillManifest, payerId: string, result: CliExecutionResult) {
  if (!env.BILLING_QUEUE) return;

  const durationSeconds = Math.ceil((result.duration_ms ?? 0) / 1000);
  const perSecondFee = manifest.cost.per_second_cents ?? 0;

  // 基础设施计费逻辑：仅成功时收取按秒能耗费，失败仅收基础费
  const infraFee = result.status === 'SUCCESS' ? perSecondFee * durationSeconds : 0;

  const event: BillingEvent = {
    skill_name: manifest.skill_name, // 对齐系统主键
    payer_id: payerId,
    status: result.status,
    base_fee_cents: manifest.cost.base_fee_cents,
    infrastructure_fee_cents: infraFee,
    duration_ms: result.duration_ms || 0,
    timestamp: new Date().toISOString(),
    metadata: {
      display_name: manifest.display_name,
      execution_status: result.status
    }
  };

  try {
    await env.BILLING_QUEUE.send(event);
  } catch (err) {
    console.error(`[execute-skill] Billing push failed:`, err);
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

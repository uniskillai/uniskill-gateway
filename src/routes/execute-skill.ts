// src/routes/execute-skill.ts
// Logic: Core engine for executing UniSkill tools with auth, billing, and formatters.

import { hashKey } from "../utils/auth";
import { SkillKeys } from "../utils/skill-keys";
import { executeSkill } from "../engine/executor";
import { errorResponse, corsHeaders, rateLimitResponse, successResponse } from "../utils/response";
import { getProfile, deductCredit, getUserUid } from "../utils/billing";
import { SkillParser } from "../engine/parser";
import { formatters } from "../formatters/index";
import { checkRateLimit } from "../rateLimit";
import type { Env } from "../index";
import { recordSkillCall } from "../utils/stats";
import { decryptSecret } from "../utils/security";

// Logic: Hardcoded native handlers that don't use the generic executor
const HARDCODED_NATIVE_SKILLS = new Set([
    "uniskill_weather",
    "uniskill_scrape",
    "uniskill_math",
    "uniskill_time",
    "uniskill_crypto_util",
    "uniskill_geo",
    "uniskill_github_tracker",
    "uniskill_smart_chart"
]);

export async function handleExecuteSkill(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Step 1: Extract 'key' from Header ──
    const authHeader = request.headers.get("Authorization") || "";
    const rawKey = authHeader.replace("Bearer ", "").trim();

    if (!rawKey.startsWith("us-")) {
        return errorResponse("Invalid Key Format", 401);
    }

    const keyHash = await hashKey(rawKey);

    // ── Step 2: Payload Parsing ──
    let body: any = {};
    try {
        body = await request.json();
    } catch {
        // Allowed to be empty
    }

    // Logic: Resolve skillName from path or body
    let skillName: string | undefined = body.skill_name || body.skill;
    
    // Fallback: Check if skillName is in the path (e.g. /v1/execute/uniskill_wiki)
    if (!skillName && path.startsWith("/v1/execute/") && path.split("/").length > 3) {
        skillName = path.split("/")[3];
    } 
    
    // If not in path, check the body (required for /v1/execute)
    if (!skillName) {
        return errorResponse("Missing skill_name in path or body", 400);
    }

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const params = body.payload || body.params || body;

    try {
        // ── Step 3: Identity & Billing Resolve ──
        // 逻辑：1. 锁定调用者 UID (计费对象)；2. 锁定目标 UID (私有技能命名空间)
        const callerUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        const targetUid = body.user_uid || callerUid; // 支持 MCP 路由解析出的 owner.skill
        
        const profile = await getProfile(env.UNISKILL_KV, callerUid, env, keyHash);
        
        const userTier = profile.tier;
        let currentCredits = profile.credits;

        // ── Step 4: Skill Configuration Lookup (Multi-Namespace) ──
        // 逻辑：优先级 Private (Target) > Official > Market
        let skillRaw: string | null = null;
        let finalSkillName = normalizedSkillName;
        let isPrivate = false;
        
        // 4a. Try Private (Using targetUid for potential cross-user MCP routing)
        if (targetUid && targetUid !== "public") {
            const pKeyRaw = SkillKeys.private(targetUid, skillName);
            const pKeyNorm = SkillKeys.private(targetUid, normalizedSkillName);
            skillRaw = await env.UNISKILL_KV.get(pKeyRaw) || await env.UNISKILL_KV.get(pKeyNorm);
            if (skillRaw) {
                finalSkillName = skillName;
                isPrivate = true;
                console.log(`[DEBUG] Found PRIVATE skill: ${skillName} in namespace ${targetUid}`);
            }
        }

        // 4b. Try Official
        if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedSkillName));
            finalSkillName = normalizedSkillName;
            if (skillRaw) console.log(`[DEBUG] Found OFFICIAL skill: ${normalizedSkillName}`);
        }

        // 4c. Try Market
        if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.market(normalizedSkillName));
            finalSkillName = normalizedSkillName;
            if (skillRaw) console.log(`[DEBUG] Found MARKET skill: ${normalizedSkillName}`);
        }

        if (!skillRaw) {
            console.error(`[DEBUG] Skill NOT FOUND in any registry: ${skillName}`);
            return errorResponse(`Skill [${skillName}] is not registered in any accessible registry.`, 400);
        }

        // ── Step 5: Parse & Verify ──
        const spec = SkillParser.parse(skillRaw);
        const unified = JSON.parse(skillRaw);
        
        const implementation = spec.implementation || (spec as any).config || unified.config;
        const creditsPerCall = Number(unified.credits_per_call ?? unified.meta?.cost ?? unified.cost_per_call ?? 1);
        const displayName = unified.display_name || unified.meta?.display_name || finalSkillName;
        const tags = unified.tags || unified.meta?.tags || [];

        // 重新判断是否强制路由至原生 Handler (Only if it's truly an Official/Native skill)
        // 🌟 核心修复：如果是私有技能，强制 bypass 官方硬编码逻辑
        const isActuallyHardcoded = !isPrivate && 
                                   HARDCODED_NATIVE_SKILLS.has(finalSkillName) && 
                                   (unified.source === 'official' || !unified.source);

        if (!implementation && !isActuallyHardcoded) {
            return errorResponse(`Implementation config missing for skill [${finalSkillName}]`, 500);
        }

        // ── Step 6: Rate Limit & Credits Check ──
        const rlResult = await checkRateLimit(keyHash, userTier, env);
        if (!rlResult.isAllowed) {
            return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }
        
        if (currentCredits === -1) currentCredits = 0;
        if (currentCredits < creditsPerCall) {
            return errorResponse(`Insufficient Credits. This skill costs ${creditsPerCall}, but you have ${currentCredits}.`, 402);
        }

        // ── Step 7: Execution ──
        let finalData: any;
        if (isActuallyHardcoded) {
            const syntheticRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify({ ...body, ...params }) // 🌟 严谨信封：保留西瓜，同时把种子铺在顶层
            });

            let nativeResponse: Response;
            if (normalizedSkillName === "uniskill_weather") {
                const { handleWeather } = await import("./weather");
                nativeResponse = await handleWeather(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_scrape") {
                const { handleScrape } = await import("./scrape");
                nativeResponse = await handleScrape(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_math") {
                const { handleMath } = await import("./math");
                nativeResponse = await handleMath(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_time") {
                const { handleTime } = await import("./time");
                nativeResponse = await handleTime(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_crypto_util") {
                const { handleCrypto } = await import("./crypto_util");
                nativeResponse = await handleCrypto(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_geo") {
                const { handleGeo } = await import("./geo");
                nativeResponse = await handleGeo(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_github_tracker") {
                const { handleGithubTracker } = await import("./github-tracker");
                nativeResponse = await handleGithubTracker(syntheticRequest, env);
            } else if (normalizedSkillName === "uniskill_smart_chart") {
                const { executeSmartChart } = await import("./uniskill-smart-chart");
                const result = await executeSmartChart(params, env);
                nativeResponse = new Response(JSON.stringify(result), {
                    status: 200,
                    headers: { "Content-Type": "application/json" }
                });
            } else {
                return errorResponse(`Native handler not found for: ${normalizedSkillName}`, 500);
            }

            if (!nativeResponse.ok) {
                return nativeResponse;
            }

            finalData = await nativeResponse.json();

            // 🔴 Apply dynamic plugin hook if configured
            const hookName = implementation?.plugin_hook || unified.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                const formatted = (formatters as any)[hookName](finalData);
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch { finalData = { result: formatted }; }
            }
        } else {
            // 🌟 核心增强：多级密钥加载 (Fetch Multi-level Secrets)
            let rawSecrets: Record<string, string> = {};

            // 🌟 辅助函数：将多种格式的 Secrets 统一合并到 Map 中
            const mergeSecrets = (target: Record<string, string>, raw: string | null) => {
                if (!raw) return target;
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        // 如果是数组格式 [{key, value}, ...] (控制台组件原始格式)
                        parsed.forEach((item: any) => {
                            if (item.key && item.value) target[item.key] = item.value;
                        });
                    } else if (typeof parsed === 'object') {
                        // 如果是对象格式 {key: value} (网关标准格式)
                        Object.assign(target, parsed);
                    }
                } catch (e) {
                    console.error("[Executor] JSON parse error for secrets:", e);
                }
                return target;
            };

            try {
                // 1. 加载用户全局密钥 (User-level)
                const userSecretsRaw = await env.UNISKILL_KV.get(SkillKeys.secrets(callerUid));
                mergeSecrets(rawSecrets, userSecretsRaw);
                
                // 2. 加载技能专属密钥 (Skill-level, has higher priority)
                const skillSecretsRaw = await env.UNISKILL_KV.get(SkillKeys.skillSecrets(callerUid, skillName!));
                mergeSecrets(rawSecrets, skillSecretsRaw);
            } catch (e) {
                console.error(`[Executor] Failed to load raw secrets for ${callerUid}:`, e);
            }

            // 🌟 核心增强：实时解密 (On-the-fly Decryption)
            const decryptedSecrets: Record<string, string> = {};
            for (const [key, val] of Object.entries(rawSecrets)) {
                try {
                    // 如果是加密格式（包含三个点号），执行解密；否则视为明文兼容
                    if (val && typeof val === 'string' && val.split('.').length === 3) {
                        decryptedSecrets[key] = decryptSecret(val, env.MASTER_ENCRYPTION_KEY);
                    } else {
                        decryptedSecrets[key] = val;
                    }
                } catch (e) {
                    console.error(`[Security] Failed to decrypt secret [${key}] for ${callerUid}:`, e);
                    decryptedSecrets[key] = `[DECRYPTION_FAILED_${key}]`;
                }
            }

            try {
                finalData = await executeSkill(implementation, params, env, decryptedSecrets, !isPrivate);
            } catch (execErr: any) {
                return errorResponse(execErr.message, 502);
            }

            const hookName = implementation.plugin_hook || unified.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                const formatted = (formatters as any)[hookName](finalData);
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch (pErr) {
                    finalData = { result: formatted };
                }
            }
        }

        // ── Step 7: Post-Execution Billing ──
        if (creditsPerCall > 0) {
            ctx.waitUntil(deductCredit(
                env.UNISKILL_KV,
                callerUid,
                currentCredits,
                creditsPerCall,
                env.VERCEL_WEBHOOK_URL,
                env.ADMIN_KEY,
                finalSkillName,
                keyHash
            ));
        }

        // ── Step 8: Final Response ──
        const remaining = Math.round((currentCredits - creditsPerCall) * 100) / 100;
        const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

        // ── Step 9: Record Statistics (Dynamic Metadata) ──
        ctx.waitUntil(recordSkillCall(
            env, 
            callerUid, 
            finalSkillName, 
            requestId, 
            creditsPerCall, 
            "credits", 
            "success",
            creditsPerCall,
            displayName,
            tags
        ));

        return successResponse({
            ...finalData,
            _uniskill: {
                credits_charged: creditsPerCall,
                remaining,
                request_id: requestId,
                version: "v1.1.0" 
            }
        }, 200);

    } catch (error: any) {
        console.error(`[Execution Flow Error]`, error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}


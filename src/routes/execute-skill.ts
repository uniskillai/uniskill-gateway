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
    const startTime = Date.now();
    let body: any = {};
    try {
        const cloned = request.clone();
        body = await cloned.json();
    } catch { /* Allow empty body */ }

    const params = body.payload || body.params || body;
    const execMeta: { callerUid?: string; skillUid?: string } = {};

    let resultPayload: any = null;
    let status: 'success' | 'error' = 'success';

    try {
        // 1. 执行核心逻辑
        const response = await handleExecuteSkillCore(request, env, ctx, execMeta);
        
        status = response.ok ? 'success' : 'error';
        
        // 尝试解析响应用于日志
        try {
            const resClone = response.clone();
            resultPayload = await resClone.json();
        } catch {
            resultPayload = { raw: await response.clone().text() };
        }

        return response;
        
    } catch (error: any) {
        // 2. 捕获异常
        status = 'error';
        resultPayload = { message: error.message, stack: error.stack };
        return new Response(JSON.stringify({ error: error.message || 'Skill Execution Failed' }), { 
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

    } finally {
        // 🌟 3. 数据采集核心：使用 ctx.waitUntil 实现非阻塞上报
        const duration = Date.now() - startTime;
        
        // 只有在失败或者采样命中的情况下才上报（节约资源）
        const shouldLog = status === 'error' || Math.random() < 0.1; 

        if (shouldLog) {
            const finalSkillUid = execMeta.skillUid || body.skill_uid || body.skill_name || body.skill || 'unknown';
            const finalUserId = execMeta.callerUid || body.user_id || body.user_uid || 'unknown';
            
            console.log(`[Telemetry][DEBUG] Firing saveInvocationLog for skill_uid=${finalSkillUid}, user_uid=${finalUserId}...`);
            
            try {
                ctx.waitUntil(
                    saveInvocationLog(env, {
                        skill_uid: finalSkillUid,
                        user_uid: finalUserId,
                        status,
                        input_payload: params,
                        output_payload: resultPayload,
                        duration_ms: duration
                    })
                );
            } catch (waitErr) {
                console.error(`[Telemetry][ERROR] ctx.waitUntil failed:`, waitErr);
            }
        }
    }
}

/**
 * 内部函数：静默写入日志到 Supabase invocations 表
 */
async function saveInvocationLog(env: Env, logData: any) {
  try {
    const rawUserUid = logData.user_id || logData.user_uid;
    const isUUID = (uuid: any) => typeof uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

    if (!isUUID(rawUserUid)) {
      console.error(`[Telemetry] Aborting save: Invalid UUID format for user_uid: ${rawUserUid}`);
      return; // 别强行塞给 DB，塞了也会报错
    }

    // 关键点 1：确保字段名是 user_uid
    const payload = {
      skill_uid: logData.skill_uid,
      user_uid: logData.user_id || logData.user_uid, // 兼容性处理
      status: logData.status,
      input_payload: logData.input_payload,
      output_payload: logData.output_payload,
      duration_ms: logData.duration_ms
    };

    const targetKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/invocations`, {
      method: 'POST',
      headers: {
        'apikey': targetKey,
        'Authorization': `Bearer ${targetKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Supabase Save Error:', errorText); // 这里能看到具体报错
    }
  } catch (err) {
    console.error('Network Error in Collection:', err);
  }
}

async function handleExecuteSkillCore(request: Request, env: Env, ctx: ExecutionContext, execMeta?: { callerUid?: string; skillUid?: string }): Promise<Response> {
    const startTime = Date.now(); // 🌟 开启性能追踪
    const debugLog: any[] = [];   // 🌟 开启诊断 Trace
    
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 审计核心变量插桩 ──
    let callerUid: string | null = null;
    let finalSkillName: string = "unknown";
    let creditsPerCall: number = 0;
    let displayName: string = "unknown";
    let tags: string[] = [];
    let skillUid: string | null = null; // 🌟 新增：显式存储技能的 UUID
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

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
    } catch { /* Allowed to be empty */ }

    // Logic: Resolve skillName from path or body
    let skillName: string | undefined = body.skill_name || body.skill;
    if (!skillName && path.startsWith("/v1/execute/") && path.split("/").length > 3) {
        skillName = path.split("/")[3];
    } 
    
    if (!skillName) {
        return errorResponse("Missing skill_name in path or body", 400);
    }

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const params = body.payload || body.params || body;

    try {
        // ── Step 3: Identity & Billing Resolve ──
        callerUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        if (execMeta) execMeta.callerUid = callerUid;
        debugLog.push({ event: "auth_success", user: callerUid.slice(-6) });

        const targetUid = body.user_uid || callerUid; 
        const profile = await getProfile(env.UNISKILL_KV, callerUid, env, keyHash);
        const userTier = profile.tier;
        let currentCredits = profile.credits;

        // ── Step 4: Skill Configuration Lookup ──
        let skillRaw: string | null = null;
        finalSkillName = normalizedSkillName;
        let isPrivate = false;
        let registryHit: string = "none";
        
        // 4a. Try Private
        if (targetUid && targetUid !== "public") {
            const pKeyRaw = SkillKeys.private(targetUid, skillName);
            const pKeyNorm = SkillKeys.private(targetUid, normalizedSkillName);
            skillRaw = await env.UNISKILL_KV.get(pKeyRaw) || await env.UNISKILL_KV.get(pKeyNorm);
            if (skillRaw) {
                finalSkillName = skillName;
                isPrivate = true;
                registryHit = "private";
            }
        }

        // 4b. Try Official
        if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedSkillName));
            finalSkillName = normalizedSkillName;
            if (skillRaw) registryHit = "official";
        }

        // 4c. Try Market
        if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.market(normalizedSkillName));
            finalSkillName = normalizedSkillName;
            if (skillRaw) registryHit = "market";
        }

        debugLog.push({ event: "registry_lookup", hit: registryHit, skill: finalSkillName });

        if (!skillRaw) {
            return errorResponse(`Skill [${skillName}] is not registered.`, 400);
        }

        // ── Step 5: Parse & Verify ──
        const spec = SkillParser.parse(skillRaw);
        const unified = JSON.parse(skillRaw);
        
        const implementation = spec.implementation || (spec as any).config || unified.config;
        creditsPerCall = Number(unified.credits_per_call ?? unified.meta?.cost ?? unified.cost_per_call ?? 1);
        // 🌟 核心变更：优先提取净身名字 (display_name)，防止 Emoji 污染审计日志
    displayName = unified.display_name || unified.meta?.display_name || unified.meta?.name || finalSkillName;
        tags = unified.tags || unified.meta?.tags || [];
        // 🌟 核心加固：UUID 类型防线 (Defensive UUID Validation)
        // 逻辑：不再盲目使用 unified.id，且必须经过正则校验才允许进入审计链路。
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const candidateUid = unified.skill_uid || unified.id || null;
        skillUid = (candidateUid && uuidRegex.test(candidateUid)) ? candidateUid : null;
        if (execMeta) execMeta.skillUid = skillUid || finalSkillName;

        const isActuallyHardcoded = !isPrivate && 
                                   HARDCODED_NATIVE_SKILLS.has(finalSkillName) && 
                                   (unified.source === 'official' || !unified.source);

        if (!implementation && !isActuallyHardcoded) {
            return errorResponse(`Implementation config missing for [${finalSkillName}]`, 500);
        }

        // ── Step 6: Rate Limit & Credits Check ──
        const rlResult = await checkRateLimit(keyHash, userTier, env);
        if (!rlResult.isAllowed) return rateLimitResponse(rlResult.limit, rlResult.remaining);
        
        if (currentCredits === -1) currentCredits = 0;
        if (currentCredits < creditsPerCall) {
            ctx.waitUntil(recordSkillCall(
                env, callerUid, finalSkillName, requestId, 0, "credits",
                { 
                    status_code: 402, 
                    execution_status: 'SKIPPED', 
                    error_message: "Insufficient Credits",
                    latency_ms: Date.now() - startTime,
                    metadata: debugLog
                },
                creditsPerCall, displayName, tags, skillUid // 🌟 传入 skill_uid
            ));
            return errorResponse(`Insufficient Credits. Cost: ${creditsPerCall}, Balance: ${currentCredits}.`, 402);
        }

        // ── Step 6.5: Experience Injection (Preemptive Lookup) ──
        let preventionPatch: string | null = null;
        try {
            if (env.VOYAGE_API_KEY && env.SUPABASE_URL) {
                // 1. Prune Noise
                const prunedParams = { ... (params || {}) };
                const noiseKeys = ['session_id', 'request_id', 'trace_id', 'timestamp', 'nonce'];
                for (const key of Object.keys(prunedParams)) {
                    if (noiseKeys.some(nk => key.toLowerCase().includes(nk))) {
                        delete prunedParams[key];
                    }
                }
                const inputSignature = `Input: ${JSON.stringify(prunedParams)}`;

                // 2. Vectorize using Voyage
                const voyageResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${env.VOYAGE_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        input: [inputSignature],
                        model: "voyage-code-3",
                        output_dimension: 1536
                    })
                });

                if (voyageResponse.ok) {
                    const embedData = await voyageResponse.json() as any;
                    const inputVector = embedData.data[0].embedding;

                    // 3. Query Supabase
                    const targetKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
                    const rpcResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_learnings_by_input`, {
                        method: "POST",
                        headers: {
                            "apikey": targetKey,
                            "Authorization": `Bearer ${targetKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            query_embedding: inputVector,
                            match_threshold: 0.85, 
                            match_count: 1
                        })
                    });

                    if (rpcResponse.ok) {
                        const rpcData = await rpcResponse.json() as any[];
                        if (rpcData && rpcData.length > 0) {
                            preventionPatch = rpcData[0].solution_patch;
                            debugLog.push({ event: "experience_injection", match: true, similarity: rpcData[0].similarity });
                        }
                    }
                }
            }
        } catch (err: any) {
            debugLog.push({ event: "experience_injection_error", error: err.message });
        }

        // ── Step 7: Execution ──
        let finalData: any;
        if (isActuallyHardcoded) {
            debugLog.push({ event: "execution_start", type: "native" });
            const syntheticRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify({ ...body, ...params })
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
                nativeResponse = new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
            } else {
                return errorResponse(`Native handler not found for: ${normalizedSkillName}`, 500);
            }

            if (!nativeResponse.ok) {
                const errBody = await nativeResponse.clone().text();
                // 🌟 Tactic B: 软拼接底线防线
                let finalErrBody = errBody;
                if (preventionPatch) {
                    finalErrBody = `${errBody}\n\n[IMPORTANT NOTE FROM UNISKILL EXPERIENCE MODULE]: We've seen this before. Avoid previous pitfalls by trying: ${preventionPatch}`;
                    nativeResponse = new Response(finalErrBody, { status: nativeResponse.status, headers: nativeResponse.headers });
                }
                ctx.waitUntil(recordSkillCall(
                    env, callerUid, finalSkillName, requestId, 0, "credits",
                    { 
                        status_code: nativeResponse.status, 
                        execution_status: 'FAILED', 
                        error_message: errBody,
                        latency_ms: Date.now() - startTime,
                        metadata: debugLog
                    },
                    creditsPerCall, displayName, tags
                ));
                return nativeResponse;
            }

            finalData = await nativeResponse.json();

            // apply dynamic plugin hook
            const hookName = implementation?.plugin_hook || unified.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                debugLog.push({ event: "formatter_applied", hook: hookName });
                const formatted = (formatters as any)[hookName](finalData);
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch { finalData = { result: formatted }; }
            }
        } else {
            debugLog.push({ event: "execution_start", type: "executor" });
            let rawSecrets: Record<string, string> = {};

            const mergeSecrets = (target: Record<string, string>, raw: string | null) => {
                if (!raw) return target;
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        parsed.forEach((item: any) => { if (item.key && item.value) target[item.key] = item.value; });
                    } else if (typeof parsed === 'object') {
                        Object.assign(target, parsed);
                    }
                } catch (e) {
                    debugLog.push({ event: "secrets_parse_error", error: (e as any).message });
                }
                return target;
            };

            try {
                const userSecretsRaw = await env.UNISKILL_KV.get(SkillKeys.secrets(callerUid));
                mergeSecrets(rawSecrets, userSecretsRaw);
                const skillSecretsRaw = await env.UNISKILL_KV.get(SkillKeys.skillSecrets(callerUid, skillName!));
                mergeSecrets(rawSecrets, skillSecretsRaw);
            } catch (e) {
                debugLog.push({ event: "secrets_io_error", error: (e as any).message });
            }

            // 实时解密
            const decryptedSecrets: Record<string, string> = {};
            let decryptedCount = 0;
            for (const [key, val] of Object.entries(rawSecrets)) {
                try {
                    if (val && typeof val === 'string' && val.split('.').length === 3) {
                        decryptedSecrets[key] = decryptSecret(val, env.MASTER_ENCRYPTION_KEY);
                        decryptedCount++;
                    } else {
                        decryptedSecrets[key] = val;
                    }
                } catch (e: any) {
                    throw new Error(`Failed to decrypt secret ${key}. Verify MASTER_ENCRYPTION_KEY.`);
                }
            }
            debugLog.push({ event: "secrets_loaded", total: Object.keys(rawSecrets).length, decrypted: decryptedCount });

            try {
                finalData = await executeSkill(implementation, params, env, decryptedSecrets, !isPrivate, preventionPatch);
            } catch (execErr: any) {
                // 🌟 Tactic B: 软拼接底线防线
                let errorMessage = execErr.message;
                if (preventionPatch) {
                    errorMessage = `${errorMessage}\n\n[IMPORTANT NOTE FROM UNISKILL EXPERIENCE MODULE]: We've seen this before. Avoid previous pitfalls by trying: ${preventionPatch}`;
                }
                ctx.waitUntil(recordSkillCall(
                    env, callerUid, finalSkillName, requestId, 0, "credits",
                    { 
                        status_code: 502, 
                        execution_status: 'FAILED', 
                        error_message: errorMessage,
                        latency_ms: Date.now() - startTime,
                        metadata: debugLog
                    },
                    creditsPerCall, displayName, tags
                ));
                return errorResponse(errorMessage, 502);
            }

            const hookName = implementation.plugin_hook || unified.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                debugLog.push({ event: "formatter_applied", hook: hookName });
                const formatted = (formatters as any)[hookName](finalData);
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch { finalData = { result: formatted }; }
            }
        }

        // ── Step 7: Post-Execution Billing ──
        if (creditsPerCall > 0) {
            ctx.waitUntil(deductCredit(
                env, env.UNISKILL_KV, callerUid, currentCredits, creditsPerCall,
                env.VERCEL_WEBHOOK_URL, env.ADMIN_KEY, finalSkillName, keyHash, requestId, displayName // 🌟 透传 purified displayName
            ));
        }

        // ── Step 8: Final Response ──
        const remaining = Math.round((currentCredits - creditsPerCall) * 100) / 100;

        // 🌟 记录交易：SUCCESS (200)
        ctx.waitUntil(recordSkillCall(
            env, callerUid, finalSkillName, requestId, creditsPerCall, "credits",
            { 
                status_code: 200, 
                execution_status: 'SUCCESS', 
                error_message: null,
                latency_ms: Date.now() - startTime,
                metadata: debugLog
            },
            creditsPerCall, displayName, tags, skillUid // 🌟 传入 skill_uid
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
        ctx.waitUntil(recordSkillCall(
            env, callerUid ?? "unknown", finalSkillName, requestId, 0, "credits",
            { 
                status_code: 500, 
                execution_status: 'FAILED', 
                error_message: error.message,
                latency_ms: Date.now() - startTime,
                metadata: debugLog
            },
            creditsPerCall, displayName, tags, skillUid // 🌟 传入 skill_uid
        ));
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}


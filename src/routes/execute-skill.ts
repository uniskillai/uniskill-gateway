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
    let skillName: string | undefined;
    
    // Check if skillName is in the path (e.g. /v1/execute/uniskill_wiki)
    if (path.startsWith("/v1/execute/") && path.split("/").length > 3) {
        skillName = path.split("/")[3];
    } 
    
    // If not in path, check the body (required for /v1/execute)
    if (!skillName) {
        skillName = body.skill_name || body.skillName || body.skill;
    }

    if (!skillName) {
        return errorResponse("Missing skill_name", 400);
    }

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const isHardcodedNative = HARDCODED_NATIVE_SKILLS.has(normalizedSkillName);

    const params = body.params || body;

    try {
        // ── Step 3: Skill Configuration Lookup (Mandatory KV Lookup) ──
        // Logic: All skills must be registered in KV (synced from Registry).
        let skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedSkillName));
        
        if (!skillRaw) {
            return errorResponse(`Skill [${normalizedSkillName}] is not registered in the system registry.`, 400);
        }

        // 3b. Parse the dynamic configuration
        const spec = SkillParser.parse(skillRaw);
        const unified = JSON.parse(skillRaw);
        
        const implementation = spec.implementation || (spec as any).config || unified.config;
        const creditsPerCall = Number(unified.credits_per_call ?? unified.meta?.cost ?? unified.cost_per_call ?? 1);
        const displayName = unified.display_name || unified.meta?.display_name || normalizedSkillName;
        const tags = unified.tags || unified.meta?.tags || [];

        if (!implementation && !isHardcodedNative) {
            return errorResponse(`Implementation config missing for skill [${normalizedSkillName}]`, 500);
        }

        // ── Step 4 & 5: Identity, Rate Limit & Billing Check ──
        const userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        const profile = await getProfile(env.UNISKILL_KV, userUid, env, keyHash);
        
        const userTier = profile.tier;
        let currentCredits = profile.credits;

        const rlResult = await checkRateLimit(keyHash, userTier, env);

        if (!rlResult.isAllowed) {
            return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }
        
        if (currentCredits === -1) currentCredits = 0;

        if (currentCredits < creditsPerCall) {
            return errorResponse(`Insufficient Credits. This skill costs ${creditsPerCall}, but you have ${currentCredits}.`, 402);
        }

        // ── Step 6: Execution (Native Handler or Generic Executor) ──
        let finalData: any;

        if (isHardcodedNative) {
            const syntheticRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify(params)
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
            try {
                finalData = await executeSkill(implementation, params, env);
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
                userUid,
                currentCredits,
                creditsPerCall,
                env.VERCEL_WEBHOOK_URL,
                env.ADMIN_KEY,
                normalizedSkillName,
                keyHash
            ));
        }

        // ── Step 8: Final Response ──
        const remaining = Math.round((currentCredits - creditsPerCall) * 100) / 100;
        const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

        // ── Step 9: Record Statistics (Dynamic Metadata) ──
        ctx.waitUntil(recordSkillCall(
            env, 
            userUid, 
            normalizedSkillName, 
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


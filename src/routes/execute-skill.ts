// src/routes/execute-skill.ts
// Logic: Core engine for executing UniSkill tools with auth, billing, and formatters.

import { hashKey } from "../utils/auth";
import { SkillKeys } from "../utils/skill-keys";
import { executeSkill } from "../engine/executor";
import { errorResponse, corsHeaders, rateLimitResponse, successResponse } from "../utils/response";
import { getCredits, deductCredit, getTier, getUserUid } from "../utils/billing";
import { SkillParser } from "../engine/parser";
import { formatters } from "../formatters/index";
import { checkRateLimit } from "../rateLimit";
import type { Env } from "../index";
import { recordSkillCall } from "../utils/stats";

const SYSTEM_SKILL_DEFAULTS: Record<string, { display_name: string, cost_per_call: number, tags: string[] }> = {
    "uniskill_weather": { display_name: "Global Weather", cost_per_call: 0, tags: ["weather", "wttr", "forecast"] },
    "uniskill_scrape": { display_name: "Web Scraper", cost_per_call: 10, tags: ["scrape", "extraction", "data"] },
    "uniskill_math": { display_name: "Math Engine", cost_per_call: 0.1, tags: ["math", "calculation", "native", "no-hallucination"] },
    "uniskill_time": { display_name: "Time & Timezone Engine", cost_per_call: 0, tags: ["time", "timezone", "native", "no-hallucination"] },
    "uniskill_crypto_util": { display_name: "Crypto & Encoding", cost_per_call: 0.1, tags: ["crypto", "hash", "base64", "uuid", "native"] },
    "uniskill_geo": { display_name: "Location & Map Engine", cost_per_call: 0.5, tags: ["geo", "map", "location", "timezone", "geocoding"] },
    "uniskill_news": { display_name: "Global News", cost_per_call: 5.0, tags: ["news", "summary", "headlines"] },
    "uniskill_search": { display_name: "Web Search", cost_per_call: 5.0, tags: ["search", "real-time", "tavily"] },
    "uniskill_wiki": { display_name: "Wikipedia Engine", cost_per_call: 1.0, tags: ["wikipedia", "encyclopedia", "knowledge"] },
    "uniskill_scholar": { display_name: "Semantic Scholar", cost_per_call: 1.0, tags: ["paper", "academic", "research", "semantic-scholar"] },
};

// Logic: Hardcoded native handlers that don't use the generic executor
const HARDCODED_NATIVE_SKILLS = new Set([
    "uniskill_weather",
    "uniskill_scrape",
    "uniskill_math",
    "uniskill_time",
    "uniskill_crypto_util",
    "uniskill_geo"
]);

async function fetchSkillConfig(skillId: string, env: Env) {
    const response = await fetch(`${env.WEB_DOMAIN}/api/internal/skill-config?id=${skillId}`, {
        method: "GET",
        headers: {
            "x-internal-secret": env.INTERNAL_API_SECRET
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch config for skill: ${skillId}`);
    }

    const data = await response.json() as any;
    return data; // Return full unified skill object
}

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
        skillName = body.skill_name || body.skillName;
    }

    if (!skillName) {
        return errorResponse("Missing skill_name", 400);
    }

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const systemDefaults = SYSTEM_SKILL_DEFAULTS[normalizedSkillName];
    const isHardcodedNative = HARDCODED_NATIVE_SKILLS.has(normalizedSkillName);

    const params = body.params || body;

    try {
        let implementation: any = null;
        let skillCost = 1; // Default fallback

        // ── Step 3: Skill Configuration & Cost Lookup ──
        // Logic: Always attempt to fetch config from KV/Registry first to get the latest costPerCall.
        
        // 3a. KV Read (Primary)
        let skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedSkillName));
        
        if (skillRaw) {
            // KV Hit: Parse the cached skill data
            const spec = SkillParser.parse(skillRaw);
            implementation = spec.implementation || (spec as any).config;

            try {
                if (skillRaw.trim().startsWith('{')) {
                    const unified = JSON.parse(skillRaw);
                    if (unified.meta && unified.meta.cost !== undefined) {
                        skillCost = Number(unified.meta.cost);
                    } else if (unified.cost_per_call !== undefined) {
                        skillCost = Number(unified.cost_per_call);
                    }
                }
            } catch (jsonErr) { }
        } else if (!isHardcodedNative) {
            // 3b. Registry API Fallback (Only for non-native skills if KV missed)
            console.log(`[DEBUG] KV miss for skill [${normalizedSkillName}], falling back to Registry API.`);
            try {
                const data = await fetchSkillConfig(normalizedSkillName, env);
                implementation = data.config || data.implementation;

                if (data.meta && data.meta.cost !== undefined) {
                    skillCost = Number(data.meta.cost);
                }
                
                // Write-back to KV
                if (implementation) {
                    ctx.waitUntil(
                        env.UNISKILL_KV.put(SkillKeys.official(normalizedSkillName), JSON.stringify(data), { expirationTtl: 3600 })
                    );
                }
            } catch (e) {
                console.warn(`[DEBUG] Registry API fetch failed for [${normalizedSkillName}]:`, e);
            }
        }

        // 3c. Final Pricing & Metadata Logic
        let resolvedDisplayName = systemDefaults?.display_name;
        let resolvedTags = systemDefaults?.tags;

        if (implementation) {
            // Update pricing from implementation
            if (implementation.meta?.cost !== undefined) {
                skillCost = Number(implementation.meta.cost);
            } else if (implementation.cost_per_call !== undefined) {
                skillCost = Number(implementation.cost_per_call);
            }

            // Update metadata for consistency (Shadow Consistency)
            // Logic: prefer .md file metadata over hardcoded defaults
            if (implementation.display_name) resolvedDisplayName = implementation.display_name;
            if (implementation.tags) resolvedTags = implementation.tags;
        } else if (systemDefaults) {
            // Seed pricing for native skills if metadata is missing from DB/KV
            skillCost = systemDefaults.cost_per_call;
        }

        if (!implementation && !isHardcodedNative) {
            return errorResponse(`Skill [${normalizedSkillName}] Not Found`, 404);
        }

        // ── Step 4: Rate Limit Check ──
        const userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        const userTier = await getTier(env.UNISKILL_KV, userUid, env);
        const rlResult = await checkRateLimit(keyHash, userTier, env);

        if (!rlResult.isAllowed) {
            return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }

        // ── Step 5: Identity & Billing Check ──
        let currentCredits = await getCredits(env.UNISKILL_KV, userUid, env, keyHash);
        if (currentCredits === -1) currentCredits = 0;

        if (currentCredits < skillCost) {
            return errorResponse(`Insufficient Credits. This skill costs ${skillCost}, but you have ${currentCredits}.`, 402);
        }

        // ── Step 6: Execution (Native Handler or Generic Executor) ──
        let finalData: any;

        if (isHardcodedNative) {
            // Logic: Route to the dedicated native handler (bypasses MD endpoint lookup)
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
            } else {
                return errorResponse(`Native handler not found for: ${normalizedSkillName}`, 500);
            }

            if (!nativeResponse.ok) {
                return nativeResponse; // Pass through native errors
            }

            finalData = await nativeResponse.json();
        } else {
            // Logic: Generic executor for non-native skills
            try {
                finalData = await executeSkill(implementation, params, env);
            } catch (execErr: any) {
                return errorResponse(execErr.message, 502); // Bad Gateway for upstream errors
            }

            // 🔴 核心逻辑：检查该技能是否配置了 plugin_hook，执行清洗器
            const hookName = implementation.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                const formatted = (formatters as any)[hookName](finalData);
                // Logic: Formatters return strings, but we need an object for successResponse
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch (pErr) {
                    finalData = { result: formatted }; // Fallback if not JSON
                }
            }
        }

        // ── Step 7: Post-Execution Billing ──
        if (skillCost > 0) {
            ctx.waitUntil(deductCredit(
                env.UNISKILL_KV,
                userUid,
                currentCredits,
                skillCost,
                env.VERCEL_WEBHOOK_URL,
                env.ADMIN_KEY,
                normalizedSkillName,
                keyHash
            ));
        }

        // ── Step 8: Final Response with Metadata ──
        const remaining = Math.round((currentCredits - skillCost) * 100) / 100;
        const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

        // ── Step 9: Record Statistics (Async) ──
        ctx.waitUntil(recordSkillCall(
            env, 
            userUid, 
            normalizedSkillName, 
            requestId, 
            skillCost, 
            "credits", 
            "success",
            skillCost,
            resolvedDisplayName,
            resolvedTags
        ));

        return successResponse({
            ...finalData,
            _uniskill: {
                cost: skillCost,
                remaining,
                request_id: requestId,
                version: "v1.0.0" 
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


// src/routes/execute-skill.ts
// Logic: Core engine for executing UniSkill tools with auth, billing, and formatters.

import { hashKey } from "../utils/auth";
import { SkillKeys } from "../utils/skill-keys";
import { executeSkill } from "../engine/executor";
import { errorResponse, corsHeaders, rateLimitResponse, successResponse, buildUniskillMeta } from "../utils/response";
import { getCredits, deductCredit, getTier } from "../utils/billing";
import { SkillParser } from "../engine/parser";
import { formatters } from "../formatters/index";
import { checkRateLimit } from "../rateLimit";
import type { Env } from "../index";

const NATIVE_SKILL_COSTS: Record<string, number> = {
    "uniskill_weather": 0,
    "uniskill_scrape": 10,
    "uniskill_math": 0.1,
    "uniskill_time": 0,
    "uniskill_crypto_util": 0.1,
};

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
        skillName = body.skillName;
    }

    if (!skillName) {
        return errorResponse("Missing skillName", 400);
    }

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const isNativeSkill = normalizedSkillName in NATIVE_SKILL_COSTS;

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
                    } else if (unified.costPerCall !== undefined) {
                        skillCost = Number(unified.costPerCall);
                    }
                }
            } catch (jsonErr) { }
        } else if (!isNativeSkill) {
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

        // 3c. Final Pricing Logic & Fallbacks
        if (implementation) {
            if (implementation.meta?.cost !== undefined) {
                skillCost = Number(implementation.meta.cost);
            } else if (implementation.costPerCall !== undefined) {
                skillCost = Number(implementation.costPerCall);
            }
        } else if (isNativeSkill) {
            // Hardcoded fallback for native skills if metadata is missing
            skillCost = NATIVE_SKILL_COSTS[normalizedSkillName];
        }

        if (!implementation && !isNativeSkill) {
            return errorResponse(`Skill [${normalizedSkillName}] Not Found`, 404);
        }

        // ── Step 4: Rate Limit Check ──
        const userTier = await getTier(env.UNISKILL_KV, keyHash);
        const rlResult = await checkRateLimit(keyHash, userTier, env);

        if (!rlResult.isAllowed) {
            return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }

        // ── Step 5: Billing Check ──
        let currentCredits = await getCredits(env.UNISKILL_KV, keyHash);
        if (currentCredits === -1) currentCredits = 0;

        if (currentCredits < skillCost) {
            return errorResponse(`Insufficient Credits. This skill costs ${skillCost}, but you have ${currentCredits}.`, 402);
        }

        // ── Step 6: Execution (Native Handler or Generic Executor) ──
        let finalData: any;

        if (isNativeSkill) {
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
            } else {
                return errorResponse(`Native handler not found for: ${normalizedSkillName}`, 500);
            }

            if (!nativeResponse.ok) {
                return nativeResponse; // Pass through native errors
            }

            finalData = await nativeResponse.json();
        } else {
            // Logic: Generic executor for non-native skills
            finalData = await executeSkill(implementation, params, env);

            // 🔴 核心逻辑：检查该技能是否配置了 plugin_hook，执行清洗器
            const hookName = implementation.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                finalData = (formatters as any)[hookName](finalData);
            }
        }

        // ── Step 7: Post-Execution Billing ──
        if (skillCost > 0) {
            ctx.waitUntil(deductCredit(
                env.UNISKILL_KV,
                keyHash,
                currentCredits,
                skillCost,
                env.VERCEL_WEBHOOK_URL,
                env.ADMIN_KEY,
                normalizedSkillName
            ));
        }

        // ── Step 8: Final Response with Metadata ──
        const remaining = Math.round((currentCredits - skillCost) * 100) / 100;
        return successResponse({
            ...finalData,
            _uniskill: buildUniskillMeta(skillCost, remaining, request)
        }, 200);

    } catch (error: any) {
        console.error(`[Execution Flow Error]`, error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}


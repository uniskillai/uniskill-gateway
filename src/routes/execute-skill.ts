// src/routes/execute-skill.ts
// Logic: Core engine for executing UniSkill tools with auth, billing, and formatters.

import { hashKey } from "../utils/auth";
import { SkillKeys } from "../utils/skill-keys";
import { executeSkill } from "../engine/executor";
import { corsHeaders, rateLimitResponse } from "../utils/response";
import { getCredits, deductCredit, getTier } from "../utils/billing";
import { SkillParser } from "../engine/parser";
import { formatters } from "../formatters/index";
import { checkRateLimit } from "../rateLimit";
import type { Env } from "../index";

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
        return new Response("Invalid Key Format", { status: 401, headers: corsHeaders });
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
    let skillName = path.startsWith("/v1/execute/") ? path.split("/")[3] : path.split("/")[2];

    if (!skillName) {
        skillName = body.skillName;
    }

    if (!skillName) {
        return new Response("Missing skillName", { status: 400, headers: corsHeaders });
    }

    // Logic: Short-circuit for skills with native gateway handlers (bypass generic executor)
    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    if (normalizedSkillName === "uniskill_weather") {
        // Body is already consumed above; re-create a synthetic request with the parsed body
        const syntheticRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(body.params || body)
        });
        const { handleWeather } = await import("./weather");
        return handleWeather(syntheticRequest, env);
    }

    const params = body.params || body;

    try {
        // ── Step 3: Resolve Skill Implementation and Cost ──
        // Logic: KV is the primary read source (edge-local, low latency).
        //        Registry API is the fallback (network I/O, used only on KV miss).
        //        On Registry hit, write back to KV for future caching.
        let implementation: any;
        let skillCost = 1; // Default fallback

        // ── 3a: KV Read (Primary) ──
        let skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));
        if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
        }
        // Normalize short names: "search" -> "uniskill_search"
        if (!skillRaw && !skillName.startsWith("uniskill_")) {
            const normalizedName = `uniskill_${skillName}`;
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedName));
            if (skillRaw) skillName = normalizedName;
        }

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
        } else {
            // ── 3b: Registry API Fallback (on KV miss) ──
            console.log(`[DEBUG] KV miss for skill [${skillName}], falling back to Registry API.`);
            try {
                const data = await fetchSkillConfig(skillName, env);
                implementation = data.config || data.implementation;

                if (data.meta && data.meta.cost !== undefined) {
                    skillCost = Number(data.meta.cost);
                }

                // Write-back to KV to warm the cache for the next request
                if (implementation) {
                    ctx.waitUntil(
                        env.UNISKILL_KV.put(SkillKeys.official(skillName), JSON.stringify(data), { expirationTtl: 3600 })
                    );
                }
            } catch (e) {
                console.warn(`[DEBUG] Registry API fetch also failed for [${skillName}]:`, e);
            }
        }

        if (!implementation) {
            return new Response(`Skill [${skillName}] Not Found`, { status: 404, headers: corsHeaders });
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

        // Fallback checks just in case the cost wasn't found in meta
        if (implementation && implementation.meta?.cost !== undefined) {
            skillCost = Number(implementation.meta.cost);
        } else if (implementation && implementation.costPerCall !== undefined) {
            skillCost = Number(implementation.costPerCall);
        }

        if (currentCredits < skillCost) {
            return new Response(`Insufficient Credits. This skill costs ${skillCost}, but you have ${currentCredits}.`, { status: 402, headers: corsHeaders });
        }

        // ── Step 6: Internal Execution ──
        // 逻辑：调用底层的执行器去跑第三方 API (或者是未来进一步调用 basic-connector)
        const rawData = await executeSkill(implementation, params, env);
        let finalData = rawData;

        // 🔴 核心逻辑：检查该技能是否配置了 plugin_hook，执行清洗器
        const hookName = implementation.plugin_hook;
        if (hookName && (formatters as any)[hookName]) {
            finalData = (formatters as any)[hookName](rawData);
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
                skillName
            ));
        }

        return new Response(typeof finalData === 'string' ? finalData : JSON.stringify(finalData), {
            status: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "X-RateLimit-Limit": rlResult.limit.toString(),
                "X-RateLimit-Remaining": rlResult.remaining.toString(),
            }
        });

    } catch (error: any) {
        console.error(`[Execution Flow Error]`, error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}

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
    return data.config || data.implementation;
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
    // e.g. /v1/execute/uniskill_search -> index 3 is "uniskill_search"
    //      /v1/search -> (Legacy, let's keep backward compat for now by fallback to body or path[2])
    let skillName = path.startsWith("/v1/execute/") ? path.split("/")[3] : path.split("/")[2];

    if (!skillName) {
        skillName = body.skillName;
    }

    if (!skillName) {
        return new Response("Missing skillName", { status: 400, headers: corsHeaders });
    }

    const params = body.params || body;

    try {
        // ── Step 3: Resolve Skill Implementation (Dynamic or KV) ──
        let implementation: any;

        try {
            console.log(`[DEBUG] Attempting dynamic config fetch for: ${skillName}`);
            implementation = await fetchSkillConfig(skillName, env);
        } catch (e) {
            console.warn(`[DEBUG] Dynamic config fetch failed, falling back to KV:`, e);

            let skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));
            if (!skillRaw) {
                skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
            }
            if (!skillRaw && !skillName.startsWith("uniskill_")) {
                const normalizedName = `uniskill_${skillName}`;
                skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedName));
                if (skillRaw) skillName = normalizedName;
            }

            if (!skillRaw) return new Response(`Skill [${skillName}] Not Found`, { status: 404, headers: corsHeaders });

            const spec = SkillParser.parse(skillRaw);
            implementation = spec.implementation || (spec as any).config;
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

        let skillCost = 1;
        if (skillName === "uniskill_search" || skillName === "uniskill_news" || skillName === "news") {
            skillCost = 10;
        } else if (skillName === "uniskill_scrape" || skillName === "scrape") {
            skillCost = 20;
        } else if (skillName === "uniskill_weather" || skillName === "weather") {
            skillCost = 0;
        } else if (implementation.meta?.cost !== undefined) {
            skillCost = Number(implementation.meta.cost);
        } else if (implementation.costPerCall !== undefined) {
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

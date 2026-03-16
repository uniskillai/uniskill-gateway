// src/routes/execute-skill.ts
// Logic: Core engine for executing UniSkill tools with auth, billing, and formatters.

import { hashKey } from "../utils/auth";
import { SkillKeys } from "../utils/skill-keys";
import { executeSkill } from "../engine/executor";
import { errorResponse, rateLimitResponse, successResponse } from "../utils/response";
import { getCredits, deductCredit, getTier, getUserUid } from "../utils/billing";
import { SkillParser } from "../engine/parser";
import { formatters } from "../formatters/index";
import { checkRateLimit } from "../rateLimit";
import type { Env } from "../index";
import { recordSkillCall } from "../utils/stats";

const SYSTEM_SKILL_DEFAULTS: Record<string, { display_name: string, credits_per_call: number, usd_per_call: number, tags: string[] }> = {
    "uniskill_weather": { display_name: "Global Weather", credits_per_call: 0, usd_per_call: 0, tags: ["weather", "wttr", "forecast"] },
    "uniskill_scrape": { display_name: "Web Scraper", credits_per_call: 10, usd_per_call: 0.1, tags: ["scrape", "extraction", "data"] },
    "uniskill_math": { display_name: "Math Engine", credits_per_call: 0.1, usd_per_call: 0.001, tags: ["math", "calculation", "native", "no-hallucination"] },
    "uniskill_time": { display_name: "Time & Timezone Engine", credits_per_call: 0, usd_per_call: 0, tags: ["time", "timezone", "native", "no-hallucination"] },
    "uniskill_crypto_util": { display_name: "Crypto & Encoding", credits_per_call: 0.1, usd_per_call: 0.001, tags: ["crypto", "hash", "base64", "uuid", "native"] },
    "uniskill_geo": { display_name: "Location & Map Engine", credits_per_call: 0.5, usd_per_call: 0.005, tags: ["geo", "map", "location", "timezone", "geocoding"] },
    "uniskill_news": { display_name: "Global News", credits_per_call: 5.0, usd_per_call: 0.05, tags: ["news", "summary", "headlines"] },
    "uniskill_search": { display_name: "Web Search", credits_per_call: 5.0, usd_per_call: 0.05, tags: ["search", "real-time", "tavily"] },
    "uniskill_wiki": { display_name: "Wikipedia Engine", credits_per_call: 1.0, usd_per_call: 0.01, tags: ["wikipedia", "encyclopedia", "knowledge"] },
    "uniskill_scholar": { display_name: "Semantic Scholar", credits_per_call: 1.0, usd_per_call: 0.01, tags: ["paper", "academic", "research", "semantic-scholar"] },
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

    // ── Step 1: Identity Detection & Auth ──
    const authHeader = request.headers.get("Authorization") || "";
    const rawKey = authHeader.replace("Bearer ", "").trim();
    const agentWallet = request.headers.get("X-Agent-Wallet");
    const nvmSignature = request.headers.get("X-NVM-Signature");
    const nvmTimestamp = request.headers.get("X-NVM-Timestamp");

    let userUid: string | null = null;
    let paymentType: 'CREDITS' | 'USD' = 'CREDITS';
    let activeAgentWallet: string | null = null;
    let keyHash: string | null = null;

    if (rawKey.startsWith("us-")) {
        // Human Path (UniSkill Key)
        keyHash = await hashKey(rawKey);
        userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        if (!userUid) return errorResponse("Invalid User Session", 401);
        paymentType = 'CREDITS';
    } else if (agentWallet) {
        // Agent Path (Wallet)
        activeAgentWallet = agentWallet;
        paymentType = 'USD';
    } else {
        return errorResponse("Missing Authorization (Key or Wallet)", 401);
    }

    // ── Step 2: Payload Parsing ──
    let body: any = {};
    try {
        body = await request.json();
    } catch {
        // Allowed to be empty
    }

    // Logic: Resolve skillName from path or body
    let skillName: string | undefined;
    if (path.startsWith("/v1/execute/") && path.split("/").length > 3) {
        skillName = path.split("/")[3];
    } else {
        skillName = body.skill_name || body.skillName;
    }

    if (!skillName) return errorResponse("Missing skill_name", 400);

    const normalizedSkillName = skillName.startsWith("uniskill_") ? skillName : `uniskill_${skillName}`;
    const systemDefaults = SYSTEM_SKILL_DEFAULTS[normalizedSkillName];
    const isHardcodedNative = HARDCODED_NATIVE_SKILLS.has(normalizedSkillName);

    const params = body.params || body;

    try {
        let implementation: any = null;
        let skillCost = 0;
        let settlementAsset: string | undefined;
        let resolvedDisplayName = normalizedSkillName;
        let resolvedTags: string[] = [];

        // ── Step 3: Skill Configuration & Cost Lookup ──
        let skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedSkillName));
        let skillSpec: any = null;

        if (skillRaw) {
            try {
                skillSpec = JSON.parse(skillRaw);
                // Handle both legacy (md content) and unified (JSON) formats
                if (typeof skillSpec === 'string') {
                    skillSpec = SkillParser.parse(skillSpec);
                }
            } catch (e) {
                skillSpec = SkillParser.parse(skillRaw);
            }
        } 
        
        if (!skillSpec && !isHardcodedNative) {
            // Registry API Fallback
            try {
                skillSpec = await fetchSkillConfig(normalizedSkillName, env);
                // Cache it back to KV
                ctx.waitUntil(env.UNISKILL_KV.put(SkillKeys.official(normalizedSkillName), JSON.stringify(skillSpec), { expirationTtl: 3600 }));
            } catch (e) {
                return errorResponse(`Skill [${normalizedSkillName}] Not Found`, 404);
            }
        }

        // Fill metadata and pricing
        if (isHardcodedNative && systemDefaults) {
            resolvedDisplayName = systemDefaults.display_name;
            resolvedTags = systemDefaults.tags;
            // Native pricing strategy
            if (paymentType === 'CREDITS') {
                skillCost = systemDefaults.credits_per_call;
            } else {
                skillCost = (systemDefaults as any).usd_per_call || 0.01; // Default native USD cost
            }
        }

        if (skillSpec) {
            implementation = skillSpec.implementation || skillSpec.config;
            resolvedDisplayName = skillSpec.display_name || skillSpec.meta?.display_name || resolvedDisplayName;
            resolvedTags = skillSpec.tags || skillSpec.meta?.tags || resolvedTags;

            // Dual Pricing Selection
            if (paymentType === 'CREDITS') {
                skillCost = Number(skillSpec.credits_per_call ?? skillSpec.cost_per_call ?? skillSpec.meta?.cost ?? skillCost);
            } else {
                // Agent path: enforce minimum USD price of 0.001 (no free rides)
                const rawUsdCost = Number(skillSpec.usd_per_call ?? 0);
                skillCost = Math.max(rawUsdCost, 0.001);
                settlementAsset = env.DEFAULT_SETTLEMENT_ASSET || 'USDC';
            }
        }

        // ── Step 4: Rate Limit Check (Humans only for now) ──
        if (keyHash) {
            const userTier = await getTier(env.UNISKILL_KV, keyHash);
            const rlResult = await checkRateLimit(keyHash, userTier, env);
            if (!rlResult.isAllowed) return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }

        // ── Step 5: Pre-execution Balance Check ──
        let currentCredits = 0;
        if (paymentType === 'CREDITS' && keyHash) {
            currentCredits = await getCredits(env.UNISKILL_KV, keyHash);
            if (currentCredits === -1) currentCredits = 0;
            if (currentCredits < skillCost) {
                return errorResponse(`Insufficient Credits. Cost: ${skillCost} CR, Balance: ${currentCredits} CR`, 402);
            }
        } else if (paymentType === 'USD' && activeAgentWallet) {
            if (!nvmSignature || !nvmTimestamp) {
                return errorResponse("Missing X-NVM-Signature or X-NVM-Timestamp", 401);
            }

            // ── Default Defense 1: Replay Attack Prevention (5 Minutes TTL) ──
            let requestTime = new Date(nvmTimestamp).getTime();
            // Handle Unix timestamp (seconds) if ISO parsing fails
            if (isNaN(requestTime) && /^\d+$/.test(nvmTimestamp)) {
                requestTime = parseInt(nvmTimestamp, 10) * 1000;
            }

            const now = Date.now();
            if (isNaN(requestTime) || Math.abs(now - requestTime) > 5 * 60 * 1000) {
                return errorResponse("Signature expired or timestamp invalid. Prevented replay attack.", 401);
            }

            const { verifyNeverminedBalance } = await import("../utils/nevermined");
            const nvmCheck = await verifyNeverminedBalance(env, {
                agentAddress: activeAgentWallet,
                signature: nvmSignature,
                timestamp: nvmTimestamp,
                costUsd: skillCost,
                skillId: normalizedSkillName
            });
            if (!nvmCheck.isAllowed) {
                return errorResponse(`Nevermined Pre-flight Failed: ${nvmCheck.message}`, 402);
            }
        }

        // ── Step 6: Execution ──
        let finalData: any;
        if (isHardcodedNative) {
            const syntheticRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify(params)
            });

            let nativeResponse: Response;
            // Note: Dynamic imports to keep the route handler lightweight
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

            if (!nativeResponse.ok) return nativeResponse;
            finalData = await nativeResponse.json();
        } else {
            try {
                finalData = await executeSkill(implementation, params, env);
            } catch (execErr: any) {
                return errorResponse(execErr.message, 502);
            }

            // Apply Formatters
            const hookName = implementation.plugin_hook;
            if (hookName && (formatters as any)[hookName]) {
                const formatted = (formatters as any)[hookName](finalData);
                try {
                    finalData = typeof formatted === 'string' ? JSON.parse(formatted) : formatted;
                } catch { finalData = { result: formatted }; }
            }
        }

        // ── Step 7: Post-Execution Billing (AWAIT for Web3) ──
        // Note on Defense 2 (Failure Handling): 
        // If execution above failed (e.g. !nativeResponse.ok or execErr caught), it returns early.
        // Step 7 is NEVER reached on failure, guaranteeing Agent tokens are not deducted.

        let executionStatus = "success";

        if (paymentType === 'CREDITS' && keyHash && skillCost > 0) {
            ctx.waitUntil(deductCredit(
                env.UNISKILL_KV,
                keyHash,
                currentCredits,
                skillCost,
                env.VERCEL_WEBHOOK_URL,
                env.ADMIN_KEY,
                normalizedSkillName
            ));
        } else if (paymentType === 'USD' && activeAgentWallet && skillCost > 0) {
            // Defense 3: Deterministic Settlement (Block & Sync with AWAIT)
            const { settleNeverminedPayment } = await import("../utils/nevermined");
            const settlementSuccess = await settleNeverminedPayment(env, {
                agentAddress: activeAgentWallet,
                signature: nvmSignature!,
                timestamp: nvmTimestamp!,
                costUsd: skillCost,
                skillId: normalizedSkillName,
                isSuccess: true
            });
            
            if (!settlementSuccess) {
                console.error(`[NVM] ✔ Execution Success BUT ❌ Billing Failed for ${activeAgentWallet}`);
                executionStatus = "payment_failed_after_execution";
            }
        }

        // ── Step 8: Persistence & Logging (Background Task) ──
        // Safely queues Supabase logging matching the true settlement state
        const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
        ctx.waitUntil(recordSkillCall(
            env, 
            userUid, 
            normalizedSkillName, 
            requestId, 
            skillCost, 
            paymentType, 
            executionStatus,
            skillCost,
            resolvedDisplayName,
            resolvedTags,
            settlementAsset,
            activeAgentWallet
        ));

        // ── Step 9: Final Response ──
        const remaining = paymentType === 'CREDITS' ? Math.round((currentCredits - skillCost) * 100) / 100 : currentCredits;

        return successResponse({
            ...finalData,
            _uniskill: {
                cost: skillCost,
                payment_type: paymentType,
                settlement_asset: settlementAsset,
                agent_wallet: activeAgentWallet,
                remaining,
                request_id: requestId,
                version: "v1.2.0" 
            }
        }, 200);

    } catch (error: any) {
        console.error(`[Execution Error]`, error);
        return errorResponse(error.message, 500);
    }
}


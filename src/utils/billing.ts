// ============================================================
// src/utils/billing.ts
// 计费工具：负责 KV 中信用额度的查询与扣减，以及回写 Supabase
// ============================================================

import { SkillKeys } from "./skill-keys";

import { fetchUserDataFromDB, fetchUserDataByUid } from "../db";

/**
 * In-Memory cache for reducing KV read latency.
 * TTL is kept short (60s) for consistency.
 */
const MEM_CACHE: Record<string, { val: any, expiry: number }> = {};
const CACHE_TTL = 60000; // 60 seconds

function setCache(key: string, val: any) {
    MEM_CACHE[key] = { val, expiry: Date.now() + CACHE_TTL };
}

function getCache(key: string) {
    const item = MEM_CACHE[key];
    if (item && item.expiry > Date.now()) return item.val;
    return null;
}

/**
 * Reads the current credit balance for a user from KV.
 * Logic: Two-stage fallback (UID -> Hash Migration -> DB)
 */
export async function getCredits(kv: KVNamespace, uid: string, env: any, keyHash?: string): Promise<number> {
    const cacheKey = `credits:${uid}`;
    const cached = getCache(cacheKey);
    if (cached !== null) return cached;

    // 1. Try UID-based key (Stable)
    let raw = await kv.get(SkillKeys.credits(uid));
    
    // 2. Automatic Migration: Try old Hash-based key if UID miss
    if (raw === null && keyHash) {
        raw = await kv.get(`user:credits:${keyHash}`); // Manual legacy lookup
        if (raw !== null) {
            console.log(`[Migration] Moving credits from hash to uid for ${uid}`);
            await kv.put(SkillKeys.credits(uid), raw);
            // Optionally delete old key later
        }
    }

    // 3. DB Fallback
    if (raw === null) {
        console.log(`[Billing] KV miss for credits (uid: ${uid}), hitting DB.`);
        const userData = await fetchUserDataByUid(uid, env);
        raw = String(userData.credits);
        await kv.put(SkillKeys.credits(uid), raw, { expirationTtl: 86400 });
    }

    const credits = parseFloat(raw);
    const finalCredits = isNaN(credits) ? 0 : credits;
    
    setCache(cacheKey, finalCredits);
    return finalCredits;
}

/**
 * Retrieves the stable User UID for a key hash.
 * Stage 1 of Two-Stage Routing: Mapping Hash to stable Identity.
 */
export async function getUserUid(kv: KVNamespace, keyHash: string, env: any): Promise<string> {
    const cacheKey = `uid:${keyHash}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Try KV (Hash -> UID Mapping)
    let uid = await kv.get(SkillKeys.userUid(keyHash));
    if (uid) {
        setCache(cacheKey, uid);
        return uid;
    }

    // 2. Fallback to Supabase (Source of Truth)
    console.log(`[Identity] KV miss for UID map (hash: ...${keyHash.slice(-6)}), hitting DB.`);
    const userData = await fetchUserDataFromDB(keyHash, env);
    uid = userData.user_uid;

    // 3. Write-back to KV for future requests
    if (uid && uid !== "anonymous") {
        await kv.put(SkillKeys.userUid(keyHash), uid, { expirationTtl: 86400 * 30 }); // Mapping is long-lived
        setCache(cacheKey, uid);
    }

    return uid;
}

/**
 * Reads the current subscription tier for a user from KV.
 */
export async function getTier(kv: KVNamespace, uid: string, env: any): Promise<string> {
    const cacheKey = `tier:${uid}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    let raw = await kv.get(SkillKeys.tier(uid));

    if (raw === null) {
        const userData = await fetchUserDataByUid(uid, env);
        raw = userData.tier || "FREE";
        await kv.put(SkillKeys.tier(uid), raw, { expirationTtl: 86400 });
    }

    setCache(cacheKey, raw);
    return raw;
}

/**
 * Pushes the new credit balance back to Supabase via the Vercel Webhook.
 * Maintains keyHash for backward compatibility with uniskill-web.
 */
async function syncToSupabase(
    webhookUrl: string,
    adminKey: string,
    keyHash: string,
    newBalance: number,
    skillName: string,
    credits: number
): Promise<void> {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminKey}`,
            },
            body: JSON.stringify({ hash: keyHash, newBalance, skillName, amount: -credits }),
        });
        if (!res.ok) {
            console.error(`[Sync] Webhook returned ${res.status}: ${await res.text()}`);
        }
    } catch (err) {
        console.error("[Sync] Failed to reach Vercel Webhook:", err);
    }
}

/**
 * Deducts `cost` credits from the user's balance.
 */
export async function deductCredit(
    kv: KVNamespace,
    uid: string,
    currentCredits: number,
    creditsPerCall = 1,
    webhookUrl?: string,
    adminKey?: string,
    skillName = "unknown",
    keyHash?: string // Required for DB sync if webhook relies on it
): Promise<void> {
    const newBalance = Math.round((currentCredits - creditsPerCall) * 100) / 100;

    // Step 1: 写回 KV（使用稳定 UID Key）
    await kv.put(SkillKeys.credits(uid), String(newBalance));
    
    // Refresh In-Memory Cache
    setCache(`credits:${uid}`, newBalance);

    // Step 2: 异步回写 Supabase (使用 Hash 以匹配现有 Web 端逻辑)
    if (webhookUrl && adminKey && keyHash) {
        await syncToSupabase(webhookUrl, adminKey, keyHash, newBalance, skillName, creditsPerCall);
    }
}

// ============================================================
// src/utils/billing.ts
// 计费工具：负责 KV 中信用额度的查询与扣减，以及回写 Supabase
// ============================================================

import { SkillKeys } from "./skill-keys";

import { fetchUserDataFromDB } from "../db";

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
 * Reads the current credit balance for a key hash from KV.
 */
export async function getCredits(kv: KVNamespace, keyHash: string): Promise<number> {
    const cacheKey = `credits:${keyHash}`;
    const cached = getCache(cacheKey);
    if (cached !== null) return cached;

    const raw = await kv.get(SkillKeys.credits(keyHash));
    if (raw === null) return -1;
    const credits = parseFloat(raw);
    const finalCredits = isNaN(credits) ? 0 : credits;
    
    setCache(cacheKey, finalCredits);
    return finalCredits;
}

/**
 * Retrieves the stable User UID for a key hash.
 * Logic: KV first, then DB fallback + Write-back.
 */
export async function getUserUid(kv: KVNamespace, keyHash: string, env: any): Promise<string> {
    const cacheKey = `uid:${keyHash}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Try KV
    let uid = await kv.get(SkillKeys.userUid(keyHash));
    if (uid) {
        setCache(cacheKey, uid);
        return uid;
    }

    // 2. Fallback to Supabase
    console.log(`[Identity] KV miss for UID (hash: ...${keyHash.slice(-6)}), hitting DB.`);
    const userData = await fetchUserDataFromDB(keyHash, env);
    uid = userData.user_uid;

    // 3. Write-back to KV for future requests
    if (uid && uid !== "anonymous") {
        await kv.put(SkillKeys.userUid(keyHash), uid, { expirationTtl: 86400 * 7 }); // Cache for 7 days
        setCache(cacheKey, uid);
    }

    return uid;
}

/**
 * Reads the current subscription tier for a key hash from KV.
 * KV schema: tier:{hash}
 * Default: FREE
 */
export async function getTier(kv: KVNamespace, keyHash: string): Promise<string> {
    const raw = await kv.get(SkillKeys.tier(keyHash));
    return raw || "FREE";
}

/**
 * Pushes the new credit balance back to Supabase via the Vercel Webhook.
 */
async function syncToSupabase(
    webhookUrl: string,
    adminKey: string,
    keyHash: string,
    newBalance: number,
    skillName: string,
    cost: number
): Promise<void> {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // Logic: UniSkill Web expects Authorization: Bearer <ADMIN_KEY>
                "Authorization": `Bearer ${adminKey}`,
            },
            body: JSON.stringify({ hash: keyHash, newBalance, skillName, amount: -cost }),
        });
        if (!res.ok) {
            console.error(`[Sync] Webhook returned ${res.status}: ${await res.text()}`);
        } else {
            console.log(`[Sync] Supabase updated → ...${keyHash.slice(-6)} balance=${newBalance} skill=${skillName}`);
        }
    } catch (err) {
        console.error("[Sync] Failed to reach Vercel Webhook:", err);
    }
}

/**
 * Deducts `cost` credits from the key hash's balance,
 * persists it to KV, then syncs the new balance to Supabase.
 */
export async function deductCredit(
    kv: KVNamespace,
    keyHash: string,
    currentCredits: number,
    cost = 1,
    webhookUrl?: string,
    adminKey?: string,
    skillName = "unknown"
): Promise<void> {
    const newBalance = Math.round((currentCredits - cost) * 100) / 100;

    // Step 1: 写回 KV（使用标准 Key）
    await kv.put(SkillKeys.credits(keyHash), String(newBalance));
    
    // Refresh In-Memory Cache immediately
    setCache(`credits:${keyHash}`, newBalance);

    // Step 2: 异步回写 Supabase
    if (webhookUrl && adminKey) {
        await syncToSupabase(webhookUrl, adminKey, keyHash, newBalance, skillName, cost);
    } else {
        console.warn("[Sync] VERCEL_WEBHOOK_URL or ADMIN_KEY not set. Skipping Supabase sync.");
    }
}

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

export function setCache(key: string, val: any) {
    MEM_CACHE[key] = { val, expiry: Date.now() + CACHE_TTL };
}

function getCache(key: string) {
    const item = MEM_CACHE[key];
    if (item && item.expiry > Date.now()) return item.val;
    return null;
}

export interface UserProfile {
    credits: number;
    tier: string;
    username: string;
    updated_at: number;
}

/**
 * Reads the unified user profile from KV.
 * Logic: Self-healing Migration (Profile -> Legacy Keys -> DB)
 */
export async function getProfile(kv: KVNamespace, uid: string, env: any, keyHash?: string): Promise<UserProfile> {
    const cacheKey = `profile:${uid}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Try the new unified profile key
    let raw = await kv.get(SkillKeys.profile(uid));
    if (raw) {
        try {
            const profile = JSON.parse(raw) as UserProfile;
            setCache(cacheKey, profile);
            return profile;
        } catch (e) {
            console.error(`[Billing] Failed to parse profile for ${uid}:`, e);
        }
    }

    // 2. Self-healing Migration: Concurrent read legacy keys
    console.log(`[Migration] Profile miss for ${uid}, starting self-healing...`);
    const [oldCreditsVal, oldTier] = await Promise.all([
        kv.get(SkillKeys.credits(uid)),
        kv.get(SkillKeys.tier(uid))
    ]);

    let oldCredits = oldCreditsVal;
    if (oldCredits === null && keyHash) {
        // Even older: Try Hash-based key
        oldCredits = await kv.get(`user:credits:${keyHash}`);
        if (oldCredits !== null) {
            console.log(`[Migration] Found very legacy hash-based credits for ${uid}`);
        }
    }

    let profile: UserProfile;

    if (oldCredits !== null || oldTier !== null) {
        // 🌟 修复：legacy 迁移也从 DB 查真实用户名，不再写死 "user"
        let migratedUsername = "user";
        try {
            const userData = await fetchUserDataByUid(uid, env);
            if (userData?.username) migratedUsername = userData.username;
        } catch (e) {
            console.warn(`[Migration] Could not fetch username from DB for ${uid}, falling back to "user".`);
        }
        profile = {
            credits: oldCredits ? parseFloat(oldCredits) : 0,
            tier: oldTier || "FREE",
            username: migratedUsername,
            updated_at: Date.now()
        };
        console.log(`[Migration] Migrated legacy data to profile for ${uid}, username=${migratedUsername}`);
    } else {
        // 3. Fallback to DB (Source of Truth)
        console.log(`[Billing] KV miss for ${uid}, hitting DB.`);
        const userData = await fetchUserDataByUid(uid, env);
        profile = {
            credits: userData.credits || 0,
            tier: userData.tier || "FREE",
            username: userData.username || "user",
            updated_at: Date.now()
        };
    }

    // 4. Immediate Write-back (Self-healing)
    await kv.put(SkillKeys.profile(uid), JSON.stringify(profile));
    setCache(cacheKey, profile);
    
    return profile;
}

/**
 * Reads the current credit balance for a user.
 */
export async function getCredits(kv: KVNamespace, uid: string, env: any, keyHash?: string): Promise<number> {
    const profile = await getProfile(kv, uid, env, keyHash);
    return profile.credits;
}

/**
 * Retrieves the stable User UID for a key hash.
 * Stage 1 of Two-Stage Routing: Mapping Hash to stable Identity.
 */
export async function getUserUid(kv: KVNamespace, keyHash: string, env: any): Promise<string> {
    const cacheKey = `uid:${keyHash}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    // 1. Try New format: auth:hash:{hash}
    let uid = await kv.get(SkillKeys.authHash(keyHash));
    if (uid) {
        setCache(cacheKey, uid);
        return uid;
    }

    // 2. Self-healing Migration: Try Legacy format: user:uid:{hash}
    uid = await kv.get(SkillKeys.userUid(keyHash));
    if (uid) {
        console.log(`[Migration] Moving auth hash mapping for ${keyHash.slice(-6)} to new format (Self-healing).`);
        // Atomic self-healing: write new, delete old
        await kv.put(SkillKeys.authHash(keyHash), uid, { expirationTtl: 86400 * 30 });
        await kv.delete(SkillKeys.userUid(keyHash));
        
        setCache(cacheKey, uid);
        return uid;
    }

    // 3. Fallback to Supabase (Source of Truth)
    console.log(`[Identity] KV miss for UID map (hash: ...${keyHash.slice(-6)}), hitting DB.`);
    const userData = await fetchUserDataFromDB(keyHash, env);
    uid = userData.user_uid;
    const username = userData.username || "anonymous";

    // 4. Write-back to KV for future requests (New format)
    if (uid && uid !== "anonymous") {
        await kv.put(SkillKeys.authHash(keyHash), uid, { expirationTtl: 86400 * 30 }); // Mapping is long-lived
        setCache(cacheKey, uid);
        
        // Also ensure profile exists in KV with username
        const profile = await getProfile(kv, uid, env, keyHash);
        if (profile.username !== username) {
            profile.username = username;
            await kv.put(SkillKeys.profile(uid), JSON.stringify(profile));
            setCache(`profile:${uid}`, profile);
        }
    }

    return uid;
}

/**
 * Retrieves the username for a given UID, aiming for KV first.
 */
export async function getUsername(kv: KVNamespace, uid: string, env: any): Promise<string> {
    const profile = await getProfile(kv, uid, env);
    return profile.username || "user";
}

/**
 * Reads the current subscription tier for a user.
 */
export async function getTier(kv: KVNamespace, uid: string, env: any): Promise<string> {
    const profile = await getProfile(kv, uid, env);
    return profile.tier;
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
    skillName?: string,
    credits?: number,
    requestId?: string      // 🌟 新增：追踪 ID
): Promise<void> {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${adminKey}`,
            },
            body: JSON.stringify({ 
                hash: keyHash, 
                newBalance, 
                skillName, 
                amount: -(credits ?? 0),
                request_id: requestId // 🌟 透传给 Webhook
            }),
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
    env: any,      // 🌟 新增 env 参数，用于回库查询
    kv: KVNamespace,
    uid: string,
    currentCredits: number,
    creditsPerCall = 1,
    webhookUrl?: string,
    adminKey?: string,
    _skillName = "unknown",
    keyHash?: string,
    requestId?: string // 🌟 新增：追踪 ID
): Promise<void> {
    const newBalance = Math.round((currentCredits - creditsPerCall) * 100) / 100;

    // Step 1: Read existing profile to preserve Tier
    const profile = await getProfile(kv, uid, env); // 🌟 使用实时的 env 确保 DB 连通性
    profile.credits = newBalance;
    profile.updated_at = Date.now();

    // Step 2: Write back the consolidated JSON
    await kv.put(SkillKeys.profile(uid), JSON.stringify(profile));
    
    // Refresh In-Memory Cache
    setCache(`profile:${uid}`, profile);
    setCache(`credits:${uid}`, newBalance); // Backwards compatibility for raw cache lookups if any

    // Step 3: Async write-back to Supabase
    if (webhookUrl && adminKey && keyHash) {
        await syncToSupabase(webhookUrl, adminKey, keyHash, newBalance, _skillName, creditsPerCall, requestId);
    }
}

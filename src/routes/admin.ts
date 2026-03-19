// ============================================================
// src/routes/admin.ts
// 管理端签发接口：供受信任的后端（如 Vercel）调用，生成 Key 并注入信用
// ============================================================

import { GATEWAY_VERSION } from "../utils/response.ts";
import { getCredits, setCache } from "../utils/billing.ts";
import type { Env } from "../index.ts";

// 默认签发的初始信用点数
const DEFAULT_INITIAL_CREDITS = 50;

import { SkillKeys } from "../utils/skill-keys.ts";

/**
 * Handles POST /v1/admin/provision
 * DEPRECATED: Use /v1/admin/sync_cache instead.
 * Called by a trusted backend (e.g. Vercel) to create a new UniSkill API key.
 */
export async function handleProvision(request: Request, env: Env): Promise<Response> {
    // ... (鉴权已在入口 index.ts 完成)

    // ── Step 2: 解析请求体 ───────────────────────────────
    let initialCredits = DEFAULT_INITIAL_CREDITS;
    let keyHash: string | undefined = undefined;
    let userUid: string | undefined = undefined;
    let userTier = "FREE";

    try {
        const body = await request.json() as any;
        initialCredits = Number(body.credits ?? DEFAULT_INITIAL_CREDITS);
        keyHash = body.key_hash || body.hash;
        userUid = body.user_uid || body.uid;
        if (body.tier) userTier = body.tier.toUpperCase();
    } catch { /* ignore */ }

    if (!keyHash || !userUid) {
        return new Response(
            JSON.stringify({ success: false, error: "Missing required fields: key_hash or user_uid" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    // ── Step 3: 写入 KV（核心：哈希解耦与 UID 绑定）───────────────
    
    // 1. 建立 Hash -> UID 的映射
    await env.UNISKILL_KV.put(SkillKeys.userUid(keyHash), userUid);

    // 2. 将业务状态（积分、等级）严格绑定到真实的 User UID
    await env.UNISKILL_KV.put(SkillKeys.credits(userUid), String(initialCredits));
    await env.UNISKILL_KV.put(SkillKeys.tier(userUid), userTier);

    // ── Step 6: 返回结果 ────────────
    return new Response(
        JSON.stringify({
            success: true,
            user_uid: userUid,
            key_hash: keyHash,
            initial_credits: initialCredits,
            tier: userTier,
            _uniskill: {
                request_id: request.headers.get("cf-ray") ?? crypto.randomUUID(),
                version: GATEWAY_VERSION,
            },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
    );
}

/**
 * Handles POST /v1/admin/sync_cache
 * NEW: The single source of truth (Next.js/Supabase) pushes the final state to the gateway.
 * Purpose: Update KV and In-Memory cache without touching the DB from the edge.
 */
export async function handleSyncCache(request: Request, env: Env): Promise<Response> {
    
    let userUid: string | undefined = undefined;
    let totalCredits: number | undefined = undefined;
    let newTier: string | undefined = undefined;
    let oldKeyHash: string | undefined = undefined;
    let keyHash: string | undefined = undefined;

    try {
        const body = await request.json() as any;
        userUid = body.user_uid || body.uid;
        // 支持多种命名方式，优先使用 total_credits
        totalCredits = body.total_credits ?? body.new_credits ?? body.credits;
        newTier = body.new_tier || body.tier;
        keyHash = body.key_hash || body.hash;
        oldKeyHash = body.old_key_hash || body.old_hash;
    } catch { /* ignore */ }

    if (!userUid) {
        return new Response(
            JSON.stringify({ success: false, error: "Missing required field: user_uid" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    // 1. [物理销毁] 如果提供了旧 Hash，立即从 KV 中抹除映射
    if (oldKeyHash) {
        console.log(`[Admin] Revoking old key mapping: ${oldKeyHash}`);
        await env.UNISKILL_KV.delete(SkillKeys.userUid(oldKeyHash));
    }

    // 2. [建立新映射] 建立 Hash -> UID 的映射 (用于注册或重置场景)
    if (keyHash) {
        await env.UNISKILL_KV.put(SkillKeys.userUid(keyHash), userUid);
    }
    
    // 2. [幂等盲写] 更新积分 (Update KV Credits)
    if (totalCredits !== undefined) {
        await env.UNISKILL_KV.put(SkillKeys.credits(userUid), String(totalCredits));
        setCache(`credits:${userUid}`, totalCredits); 
    }
    
    // 3. [幂等盲写] 更新等级 (Update KV Tier)
    if (newTier) {
        const tierStr = newTier.toUpperCase();
        await env.UNISKILL_KV.put(SkillKeys.tier(userUid), tierStr);
        setCache(`tier:${userUid}`, tierStr);
    }

    console.log(`[Admin] Sync Cache successful for ${userUid}: TotalCredits=${totalCredits}, Tier=${newTier || "unchanged"}, HashSync=${!!keyHash}`);

    return new Response(
        JSON.stringify({
            success: true,
            user_uid: userUid,
            synced: {
                total_credits: totalCredits,
                tier: newTier
            },
            _uniskill: {
                request_id: request.headers.get("cf-ray") ?? crypto.randomUUID(),
                version: GATEWAY_VERSION,
            },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
    );
}

/**
 * Handles POST /v1/admin/topup
 * DEPRECATED: Use /v1/admin/sync_cache instead.
 * Called when a purchase is successful to add credits and update tier.
 */
export async function handleTopup(request: Request, env: Env): Promise<Response> {
    
    let userUid: string | undefined = undefined;
    let creditsToAdd = 0;
    let newTier: string | undefined = undefined;

    try {
        const body = await request.json() as any;
        userUid = body.user_uid || body.uid;
        creditsToAdd = Number(body.credits_to_add || 0);
        newTier = body.tier?.toUpperCase();
    } catch { /* ignore */ }

    if (!userUid) {
        return new Response(
            JSON.stringify({ success: false, error: "Missing required field: user_uid" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    // 1. 获取当前积分 (Get current credits with fallback)
    const currentCredits = await getCredits(env.UNISKILL_KV, userUid, env);
    const newBalance = currentCredits + creditsToAdd;

    // 2. 更新 KV (Update KV)
    await env.UNISKILL_KV.put(SkillKeys.credits(userUid), String(newBalance));
    setCache(`credits:${userUid}`, newBalance); // 更新内存缓存 (Update memory cache)

    if (newTier) {
        await env.UNISKILL_KV.put(SkillKeys.tier(userUid), newTier);
        setCache(`tier:${userUid}`, newTier); // 更新等级缓存 (Update tier cache)
    }

    console.log(`[Admin] Top-up (Legacy) successful for ${userUid}: +${creditsToAdd} credits, New Balance: ${newBalance}, Tier: ${newTier || "unchanged"}`);

    return new Response(
        JSON.stringify({
            success: true,
            user_uid: userUid,
            new_balance: newBalance,
            tier: newTier,
            _uniskill: {
                request_id: request.headers.get("cf-ray") ?? crypto.randomUUID(),
                version: GATEWAY_VERSION,
            },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
    );
}

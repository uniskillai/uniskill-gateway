// ============================================================
// src/routes/admin.ts
// 管理端签发接口：供受信任的后端（如 Vercel）调用，生成 Key 并注入信用
// ============================================================

import { hashKey } from "../utils/auth.ts";
import { GATEWAY_VERSION } from "../utils/response.ts";
import type { Env } from "../index.ts";

// 默认签发的初始信用点数
const DEFAULT_INITIAL_CREDITS = 50;

// ── Step 1: 鉴权已在 index.ts 统一处理 ───────────────────
import { SkillKeys } from "../utils/skill-keys.ts";

/**
 * Handles POST /v1/admin/provision
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
    await env.UNISKILL_KV.put(`user:uid:${keyHash}`, userUid);

    // 2. 将业务状态（积分、等级）严格绑定到真实的 User UID
    await env.UNISKILL_KV.put(`user:credits:${userUid}`, String(initialCredits));
    await env.UNISKILL_KV.put(`tier:${userUid}`, userTier);

    // ── Step 6: 返回原始 Key（仅此一次）和元数据 ────────────
    return new Response(
        JSON.stringify({
            success: true,
            raw_key: rawKey,        // 仅返回给前端一次，绝不二次存储
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

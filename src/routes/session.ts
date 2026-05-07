// src/routes/session.ts
// Session Key 注册与吊销路由
// 由 Next.js 后端（携带 ADMIN_KEY）调用，普通用户不可直接访问

import { errorResponse, successResponse } from "../utils/response";
import type { Env } from "../index";

const SESSION_KEY_PREFIX = "session:key:";

// Session 数据结构
interface SessionRecord {
    userUid:       string;  // 关联的用户 UID
    walletAddress: string;  // 签发此 Session 的 MPC 主钱包地址（用于溯源）
    expiresAt:     number;  // 过期时间（Unix 毫秒）
    createdAt:     number;  // 创建时间（Unix 毫秒）
    label?:        string;  // 可选的标签，如 "Claude Desktop"
}

/**
 * POST /v1/session/register
 * 注册一个 Session Key，将其与用户 UID 绑定
 *
 * 请求体：
 *   sessionPubKey  — Session Key 的 Ethereum 地址（secp256k1 公钥派生）
 *   userUid        — 用户 UID（来自 Supabase profiles）
 *   walletAddress  — 签发此 Session 的 MPC 主钱包地址
 *   expiresAt      — 过期时间（Unix 毫秒）
 *   label?         — 可选标签（如 "Claude Desktop"）
 *
 * 安全：此路由已在 index.ts 入口处校验 ADMIN_KEY
 */
export async function handleRegisterSession(request: Request, env: Env): Promise<Response> {
    let body: any;
    try {
        body = await request.json();
    } catch {
        return errorResponse("Invalid JSON body", 400);
    }

    const sessionPubKey  = (body.sessionPubKey  as string | undefined)?.toLowerCase()?.trim();
    const userUid        = (body.userUid        || body.user_uid) as string | undefined;
    const walletAddress  = (body.walletAddress  as string | undefined)?.toLowerCase()?.trim();
    const expiresAt      = Number(body.expiresAt);
    const label          = (body.label as string | undefined) || "Local Agent";

    // ── 参数校验 ───────────────────────────────────────────────────────
    if (!sessionPubKey || !sessionPubKey.startsWith("0x") || sessionPubKey.length !== 42) {
        return errorResponse("Invalid sessionPubKey: must be a 42-char 0x Ethereum address", 400);
    }
    if (!userUid) {
        return errorResponse("Missing required field: userUid", 400);
    }
    if (!walletAddress || !walletAddress.startsWith("0x")) {
        return errorResponse("Invalid walletAddress", 400);
    }
    if (isNaN(expiresAt) || expiresAt < Date.now()) {
        return errorResponse("expiresAt must be a future Unix timestamp in milliseconds", 400);
    }

    // ── 存入 KV（带 TTL 自动过期）────────────────────────────────────
    const record: SessionRecord = {
        userUid,
        walletAddress,
        expiresAt,
        createdAt: Date.now(),
        label,
    };

    // KV TTL: 过期后多保留 1 天，便于排障；KV 本身会自动清理
    const ttlSeconds = Math.ceil((expiresAt - Date.now()) / 1000) + 86400;

    await env.UNISKILL_KV.put(
        `${SESSION_KEY_PREFIX}${sessionPubKey}`,
        JSON.stringify(record),
        { expirationTtl: ttlSeconds }
    );

    console.log(`[Session] Registered: sessionPubKey=${sessionPubKey} userUid=${userUid} label="${label}"`);

    return successResponse({
        registered:    true,
        sessionPubKey,
        userUid,
        walletAddress,
        expiresAt,
        label,
    });
}

/**
 * DELETE /v1/session/revoke
 * 立即吊销一个 Session Key（从 KV 删除）
 *
 * 请求体：
 *   sessionPubKey — 要吊销的 Session Key Ethereum 地址
 *
 * 安全：此路由已在 index.ts 入口处校验 ADMIN_KEY
 */
export async function handleRevokeSession(request: Request, env: Env): Promise<Response> {
    let body: any;
    try {
        body = await request.json();
    } catch {
        return errorResponse("Invalid JSON body", 400);
    }

    const sessionPubKey = (body.sessionPubKey as string | undefined)?.toLowerCase()?.trim();

    if (!sessionPubKey) {
        return errorResponse("Missing required field: sessionPubKey", 400);
    }

    const kvKey = `${SESSION_KEY_PREFIX}${sessionPubKey}`;

    // 检查是否存在
    const existing = await env.UNISKILL_KV.get(kvKey);
    if (!existing) {
        return errorResponse("Session key not found or already revoked", 404);
    }

    await env.UNISKILL_KV.delete(kvKey);
    console.log(`[Session] Revoked: sessionPubKey=${sessionPubKey}`);

    return successResponse({ revoked: true, sessionPubKey });
}

/**
 * GET /v1/session/status
 * 查询一个 Session Key 的当前状态
 * Query param: ?key={sessionPubKey}
 *
 * 安全：此路由已在 index.ts 入口处校验 ADMIN_KEY
 */
export async function handleSessionStatus(request: Request, env: Env): Promise<Response> {
    const url           = new URL(request.url);
    const sessionPubKey = url.searchParams.get("key")?.toLowerCase();

    if (!sessionPubKey) {
        return errorResponse("Missing query param: key", 400);
    }

    const sessionRaw = await env.UNISKILL_KV.get(`${SESSION_KEY_PREFIX}${sessionPubKey}`);
    if (!sessionRaw) {
        return successResponse({ exists: false, sessionPubKey });
    }

    const session = JSON.parse(sessionRaw) as SessionRecord;
    const isExpired = session.expiresAt < Date.now();

    return successResponse({
        exists:        true,
        isExpired,
        sessionPubKey,
        userUid:       session.userUid,
        walletAddress: session.walletAddress,
        expiresAt:     session.expiresAt,
        createdAt:     session.createdAt,
        label:         session.label,
    });
}

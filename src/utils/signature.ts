// src/utils/signature.ts
// EIP-191 签名验证工具 — 本地签名模式的请求鉴权核心
// EIP-191 signature verification for Cloudflare Workers (pure JS, no WASM)
//
// 依赖：@noble/curves、@noble/hashes（需在 gateway 目录执行 npm install）

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// ── 常量 ─────────────────────────────────────────────────────────────────
/** 请求时间戳的允许漂移窗口（±5 分钟） */
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// ── 内部工具 ──────────────────────────────────────────────────────────────

/**
 * 将 Uint8Array 转为小写十六进制字符串（CF Workers 没有 Buffer）
 */
function toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * EIP-191 personal_sign 哈希
 * 格式: "\x19Ethereum Signed Message:\n{byteLength}{message}"
 */
function hashPersonalMessage(message: string): Uint8Array {
    const msgBytes = new TextEncoder().encode(message);
    const prefix   = new TextEncoder().encode(
        `\x19Ethereum Signed Message:\n${msgBytes.length}`
    );
    const combined = new Uint8Array(prefix.length + msgBytes.length);
    combined.set(prefix, 0);
    combined.set(msgBytes, prefix.length);
    return keccak_256(combined);
}

// ── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 从 EIP-191 签名中恢复 Ethereum 地址
 * @param message      原始明文消息（签名前的字符串）
 * @param hexSignature 65 字节十六进制签名（含或不含 0x 前缀）
 * @returns 恢复出的小写 Ethereum 地址（0x 前缀），失败返回 null
 */
export function recoverEthAddress(message: string, hexSignature: string): string | null {
    try {
        const sig = hexSignature.startsWith("0x") ? hexSignature.slice(2) : hexSignature;
        if (sig.length !== 130) {
            console.warn("[Signature] Invalid signature length:", sig.length);
            return null;
        }

        const rsHex     = sig.slice(0, 128);       // r(64) + s(64)
        const v         = parseInt(sig.slice(128, 130), 16);
        // EIP-155: v=27 → recoveryId=0, v=28 → recoveryId=1
        const recoveryId = v >= 27 ? v - 27 : v;
        if (recoveryId !== 0 && recoveryId !== 1) return null;

        const msgHash  = hashPersonalMessage(message);
        const sigObj   = secp256k1.Signature.fromCompact(rsHex).addRecoveryBit(recoveryId);
        const pubKey   = sigObj.recoverPublicKey(msgHash);

        // Uncompressed public key: 04 || x(32) || y(32) = 65 bytes
        const pubKeyBytes = pubKey.toRawBytes(false);
        // Keccak-256 of x||y (skip the 04 prefix byte)
        const pubKeyHash  = keccak_256(pubKeyBytes.slice(1));
        // Last 20 bytes = address
        const address     = "0x" + toHex(pubKeyHash.slice(-20));
        return address.toLowerCase();
    } catch (e) {
        console.error("[Signature] Recovery failed:", e);
        return null;
    }
}

/**
 * 构造规范请求字符串（双端必须完全一致）
 * 格式: "USK-v1:{METHOD}:{PATH}:{NONCE}:{TIMESTAMP}"
 */
export function buildCanonical(
    method:    string,
    path:      string,
    nonce:     string,
    timestamp: string
): string {
    return `USK-v1:${method.toUpperCase()}:${path}:${nonce}:${timestamp}`;
}

/**
 * 从请求头验证签名模式鉴权，成功返回 userUid，失败返回 null
 *
 * 读取的请求头：
 *   X-USK-Wallet    — Session Key 的 Ethereum 地址
 *   X-USK-Signature — EIP-191 签名（65 字节 hex）
 *   X-USK-Nonce     — 随机 UUID（防重放）
 *   X-USK-Timestamp — Unix 毫秒时间戳
 */
export async function verifySignatureAuth(request: Request, env: any): Promise<string | null> {
    const wallet    = request.headers.get("X-USK-Wallet");
    const signature = request.headers.get("X-USK-Signature");
    const nonce     = request.headers.get("X-USK-Nonce");
    const timestamp = request.headers.get("X-USK-Timestamp");

    if (!wallet || !signature || !nonce || !timestamp) return null;

    // ── 1. 时间戳窗口校验 ────────────────────────────────────────────────
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_WINDOW_MS) {
        console.warn("[Signature] Timestamp out of window:", timestamp);
        return null;
    }

    // ── 2. 重建规范字符串并验证签名 ──────────────────────────────────────
    const url       = new URL(request.url);
    const pathWithSearch = url.pathname + url.search;
    const canonical = buildCanonical(request.method, pathWithSearch, nonce, timestamp);
    const recovered = recoverEthAddress(canonical, signature);

    if (!recovered || recovered !== wallet.toLowerCase()) {
        console.warn("[Signature] Address mismatch. Claimed:", wallet, "Recovered:", recovered);
        return null;
    }

    // ── 3. KV 查询：验证 Session Key 已注册且未过期 ───────────────────────
    const kvKey     = `session:key:${wallet.toLowerCase()}`;
    const sessionRaw = await env.UNISKILL_KV.get(kvKey);
    if (!sessionRaw) {
        console.warn("[Signature] Session key not registered:", wallet);
        return null;
    }

    const session = JSON.parse(sessionRaw) as {
        userUid:       string;
        walletAddress: string;
        expiresAt:     number;
        createdAt:     number;
    };

    if (session.expiresAt < Date.now()) {
        console.warn("[Signature] Session key expired:", wallet);
        return null;
    }

    return session.userUid;
}

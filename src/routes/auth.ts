// src/routes/auth.ts
// Logic: Explicit route for verifying API keys from CLI / connect.sh scripts

import { hashKey } from "../utils/auth";
import { getCredits, getTier, getUserUid } from "../utils/billing";
import { errorResponse, successResponse } from "../utils/response";
import type { Env } from "../index";

export async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
    // 逻辑：提取 Authorization: Bearer <KEY>
    const authHeader = request.headers.get("Authorization") || "";
    const rawKey = authHeader.replace("Bearer ", "").trim();

    // 逻辑：基础格式校验
    if (!rawKey.startsWith("us-")) {
        return errorResponse("Invalid Key Format", 401);
    }

    // 逻辑：加密哈希匹配
    const keyHash = await hashKey(rawKey);

    // 逻辑：获取稳定的用户 UID（一级路由）
    const uid = await getUserUid(env.UNISKILL_KV, keyHash, env);
    if (!uid || uid === "anonymous") {
        return errorResponse("Unauthorized: Key not found or inactive", 401);
    }

    // 逻辑：在 KV 中查询该用户实时的额度
    const credits = await getCredits(env.UNISKILL_KV, uid, env, keyHash);
    
    // 逻辑：返回用户的 Tier（等级）
    const tier = await getTier(env.UNISKILL_KV, uid, env);

    return successResponse({
        valid: true,
        credits: credits,
        tier: tier
    });
}

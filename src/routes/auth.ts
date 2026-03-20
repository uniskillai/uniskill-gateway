import { hashKey } from "../utils/auth";
import { getProfile, getUserUid } from "../utils/billing";
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

    // 逻辑：从合并后的 Profile 中获取实时状态（只需一次 KV 读取）
    const profile = await getProfile(env.UNISKILL_KV, uid, env, keyHash);

    return successResponse({
        valid: true,
        credits: profile.credits,
        tier: profile.tier
    });
}

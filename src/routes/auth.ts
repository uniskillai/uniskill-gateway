// src/routes/auth.ts
// Logic: Explicit route for verifying API keys from CLI / connect.sh scripts

import { hashKey } from "../utils/auth";
import { getCredits, getTier } from "../utils/billing";
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

    // 逻辑：在 KV 中查询该 Key 是否有实质记录（信誉 / 额度）
    // 如果返回 -1，说明 KV 中完全没有该用户的注册信息，这是一个伪造的 Key
    const credits = await getCredits(env.UNISKILL_KV, keyHash);
    if (credits === -1) {
        return errorResponse("Unauthorized: Key not found or inactive", 401);
    }

    // 逻辑：如果合法，顺带返回用户的 Tier（等级）和当前额度，未来可扩展给极客端展示
    const tier = await getTier(env.UNISKILL_KV, keyHash);

    return successResponse({
        valid: true,
        credits: credits,
        tier: tier
    });
}

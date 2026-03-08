// ============================================================
// src/utils/response.ts
// 统一响应工具：标准化 JSON 错误与成功响应构建
// ============================================================

// 网关版本号——升级时修改此处即可全局生效
export const GATEWAY_VERSION = "v1.0.0";

// 逻辑：集中管理 CORS 响应头，确保前端 Fetch 不会被浏览器拦截
export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const JSON_HEADERS = {
    ...corsHeaders,
    "Content-Type": "application/json"
};

/**
 * Builds a standardised JSON error response.
 */
export function errorResponse(message: string, status: number): Response {
    return new Response(
        JSON.stringify({ success: false, error: message }),
        { status, headers: JSON_HEADERS }
    );
}

/**
 * Builds a standardized 429 Too Many Requests response.
 */
export function rateLimitResponse(limit: number, remaining: number): Response {
    return new Response(
        JSON.stringify({
            success: false,
            error: "Too Many Requests",
            message: `Rate limit exceeded. Your tier limit is ${limit} RPM.`,
        }),
        {
            status: 429,
            headers: {
                ...JSON_HEADERS,
                "X-RateLimit-Limit": limit.toString(),
                "X-RateLimit-Remaining": remaining.toString(),
            }
        }
    );
}

/**
 * Builds a standardised JSON success response, merging extra data.
 */
export function successResponse(data: Record<string, unknown>, status = 200): Response {
    return new Response(
        JSON.stringify({ success: true, ...data }),
        { status, headers: JSON_HEADERS }
    );
}

/**
 * Builds the standard _uniskill metadata block appended to every successful skill response.
 *
 * @param cost      Credits consumed by this request
 * @param remaining Credits left after deduction
 * @param request   Original Request — used to extract CF-Ray header as request_id
 */
export function buildUniskillMeta(
    cost: number,
    remaining: number,
    request: Request
): Record<string, unknown> {
    // CF-Ray 是 Cloudflare 为每个请求生成的唯一 ID，格式如 "89abcdef12345678-SIN"
    // 本地开发时无此头，回落到随机 UUID
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();

    return {
        cost,
        remaining,
        request_id: requestId,
        version: GATEWAY_VERSION,
    };
}

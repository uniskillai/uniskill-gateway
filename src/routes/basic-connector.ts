// ============================================================
// src/routes/basic-connector.ts
// Logic: Transparent proxy for AI Agents with real-time credit deduction
// 逻辑：AI Agent 的透明代理，支持实时积分扣除
// ============================================================

import { getCredits, deductCredit, getTier } from "../utils/billing.ts";
import { hashKey } from "../utils/auth.ts";
import { errorResponse, buildUniskillMeta, corsHeaders, rateLimitResponse } from "../utils/response.ts";
import type { Env } from "../index.ts";
import { checkRateLimit } from "../rateLimit.ts";

/**
 * Logic: Cost per successful proxy request (1 credit)
 * 逻辑：每次成功代理请求的积分消耗（1 点）
 */
const BASIC_CONNECTOR_COST = 1;

/**
 * Logic: Handle the 'Basic Connector' logic
 * Flow: Auth -> Request Validation -> Proxy Execution -> Async Billing -> Response
 * * 逻辑：处理“基础连接器”逻辑
 * 流程：验证 -> 请求校验 -> 执行代理 -> 异步扣费 -> 返回响应
 */
export async function handleBasicConnector(
    request: Request,
    env: Env,
    key: string,
    ctx: ExecutionContext
): Promise<Response> {

    // ── Step 1: Security & Balance Check ──────────────────
    // 逻辑：对 Key 进行哈希处理并检查 KV 中的积分余额
    const keyHash = await hashKey(key);
    const currentCredits = await getCredits(env.UNISKILL_KV, keyHash);

    if (currentCredits === -1) {
        return errorResponse("Invalid API key.", 401);
    }
    if (currentCredits < BASIC_CONNECTOR_COST) {
        return errorResponse("Insufficient credits. Your current balance is lower than the required cost.", 402);
    }

    // ── Step 1.5: Rate Limit Check ───────────────────────
    const userTier = await getTier(env.UNISKILL_KV, keyHash);
    const rlResult = await checkRateLimit(keyHash, userTier, env);

    if (!rlResult.isAllowed) {
        return rateLimitResponse(rlResult.limit, rlResult.remaining);
    }

    // ── Step 2: Payload Parsing ────────────────────────────
    // 逻辑：解析并验证目标 URL
    let requestPayload: any;
    try {
        requestPayload = await request.json();
    } catch {
        return errorResponse("Invalid JSON body in request.", 400);
    }

    const { url: targetUrl, method, headers: targetHeaders, data: targetData } = requestPayload;

    if (!targetUrl || typeof targetUrl !== "string") {
        return errorResponse('Missing or invalid "url" field.', 400);
    }

    // ── Step 3: Proxy Execution ───────────────────────────
    // 逻辑：向目标 URL 发起代理请求
    let proxyResponse: Response;
    try {
        proxyResponse = await fetch(targetUrl, {
            method: method || "GET",
            headers: targetHeaders || {},
            body: (method && method !== "GET" && targetData) ? JSON.stringify(targetData) : null,
        });
    } catch (error: any) {
        // 逻辑：网络层错误不扣除积分
        return errorResponse(`Gateway Timeout: Failed to reach target [${targetUrl}]. Error: ${error.message}`, 504);
    }

    // ── Step 4: Async Billing (Low Latency) ───────────────
    // 逻辑：使用 ctx.waitUntil 在后台异步更新积分，确保用户感知不到延迟
    const remainingBalance = currentCredits - BASIC_CONNECTOR_COST;
    ctx.waitUntil(deductCredit(
        env.UNISKILL_KV,
        keyHash,
        currentCredits,
        BASIC_CONNECTOR_COST,
        env.VERCEL_WEBHOOK_URL,
        env.ADMIN_KEY,
        "Basic Connector Operation"
    ));

    // ── Step 5: Optimized Transparent Response ────────────
    // 逻辑：透传原始响应内容，并注入 UniSkill 基础设施元数据头
    const responseHeaders = new Headers(proxyResponse.headers);
    const metaData = buildUniskillMeta(BASIC_CONNECTOR_COST, remainingBalance, request);

    // 逻辑：设置符合国际化标准的自定义 Header 标签
    responseHeaders.set("X-UniSkill-Status", "Success");
    responseHeaders.set("X-UniSkill-Consumed", BASIC_CONNECTOR_COST.toString());
    responseHeaders.set("X-UniSkill-Balance", remainingBalance.toString());
    responseHeaders.set("X-UniSkill-Request-ID", String(metaData.request_id));
    responseHeaders.set("X-RateLimit-Limit", rlResult.limit.toString());
    responseHeaders.set("X-RateLimit-Remaining", rlResult.remaining.toString());

    // ── Logic: Add deep diagnostics for upstream issues ──
    // 逻辑：标记错误来源，告知工具调用者这是 UniSkill 的问题还是上游供应商的问题
    if (proxyResponse.status >= 400) {
        responseHeaders.set("X-UniSkill-Error-Source", "Upstream-Provider");
        responseHeaders.set("X-UniSkill-Upstream-Status", proxyResponse.status.toString());
    } else {
        responseHeaders.set("X-UniSkill-Error-Source", "None");
    }

    // 🛡️ 状态码保护逻辑：拦截第三方 API 的 402 状态码，避免 LLM 误报 UniSkill 欠费
    if (proxyResponse.status === 402) {
        // 逻辑：剥离上游可能导致解析崩溃的传输头 (如 Content-Length, Content-Encoding)
        // 只保留我们自己注入的 UniSkill 诊断头与 CORS 跨域头
        const safeHeaders = new Headers();
        Object.entries(corsHeaders).forEach(([k, v]) => safeHeaders.set(k, v));
        safeHeaders.set("Content-Type", "application/json");
        safeHeaders.set("X-UniSkill-Status", "Upstream-Error");
        safeHeaders.set("X-UniSkill-Error-Source", "Upstream-Provider");
        safeHeaders.set("X-UniSkill-Upstream-Status", "402");
        safeHeaders.set("X-UniSkill-Consumed", BASIC_CONNECTOR_COST.toString());
        safeHeaders.set("X-UniSkill-Balance", remainingBalance.toString());
        safeHeaders.set("X-UniSkill-Request-ID", String(metaData.request_id));
        safeHeaders.set("X-RateLimit-Limit", rlResult.limit.toString());
        safeHeaders.set("X-RateLimit-Remaining", rlResult.remaining.toString());

        return new Response(JSON.stringify({
            success: false,
            error: "Upstream Service Error",
            message: "The third-party API returned a billing error (402). This is NOT a UniSkill balance issue. Please check the 'url' target provider's credits.",
            _uniskill: metaData
        }), {
            status: 502, // 将上游 402 包装为 502 Gateway Error
            headers: safeHeaders // 👈 使用干净、安全的头部
        });
    }

    // 如果不是 402，则安全透传原始 Body 和原始 Headers
    return new Response(proxyResponse.body, {
        status: proxyResponse.status,
        headers: responseHeaders,
    });
}

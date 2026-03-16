// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Serverless-friendly SSE Engine using KV as a Message Broker

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
import { handleExecuteSkill } from "./execute-skill";

/**
 * 逻辑：网关级数据防腐层 - 强制将任何奇葩数据转化为 MCP 兼容的纯文本
 */
function formatToolResponse(rawData: any): string {
    // 1. 判空防雷
    if (rawData === null || rawData === undefined) {
        return "Execution successful, but no content was returned by the upstream API.";
    }

    // 2. 如果已经是字符串，直接放行
    if (typeof rawData === "string") {
        return rawData;
    }

    // 3. 如果是标准 JSON 对象或数组，极其优雅地序列化
    if (typeof rawData === "object") {
        try {
            // 限制深度或直接美化输出
            return JSON.stringify(rawData, null, 2);
        } catch (e) {
            return `[Warning: Unserializable Object] ${String(rawData)}`;
        }
    }

    // 4. 其他类型（数字、布尔值等）强转字符串
    return String(rawData);
}

// ============================================================================
// 🟢 通道 1: SSE 握手与监听端点 (GET)
// ============================================================================
export async function handleMCPSse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const sessionId = crypto.randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            console.log(`[MCP] 🔗 SSE Connection opened: ${sessionId}`);

            // 1. 告诉 Agent 去哪里发 POST
            const postEndpoint = `/v1/mcp/message?sessionId=${sessionId}`;
            const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
            controller.enqueue(encoder.encode(initMessage));

            // 2. 开启极客轮询模式 (每 500ms 去 KV 里看一眼有没有人发消息)
            let isConnected = true;

            // 如果连接断开，停止轮询
            request.signal.addEventListener("abort", () => {
                isConnected = false;
                console.log(`[MCP] ❌ Client aborted SSE: ${sessionId}`);
            });

            while (isConnected) {
                try {
                    const msgKey = `mcp_msg:${sessionId}`;
                    const payloadStr = await env.UNISKILL_KV.get(msgKey);

                    if (payloadStr) {
                        console.log(`[MCP] 📬 SSE detected new message for ${sessionId}`);
                        const payload = JSON.parse(payloadStr);
                        const { id, method, params } = payload;
                        let result: any = {};

                        // --- 🛠️ 业务逻辑执行区 ---
                        if (method === "tools/list") {
                            const kvList = await env.UNISKILL_KV.list({ prefix: "skill:official:" });
                            const mcpTools = [];
                            for (const key of kvList.keys) {
                                const skillStr = await env.UNISKILL_KV.get(key.name);
                                if (skillStr) {
                                    const skill = JSON.parse(skillStr);
                                    mcpTools.push({
                                        name: skill.id,
                                        description: skill.meta?.description || "A UniSkill tool.",
                                        inputSchema: skill.meta?.parameters || { type: "object", properties: {} }
                                    });
                                }
                            }
                            result = { tools: mcpTools };
                        }
                        else if (method === "tools/call") {
                            const toolName = params.name;
                            const toolArguments = params.arguments;

                            // 优先级：1. POST 消息自带的验证头 2. GET 握手的验证头
                            const msgAuth = payload.authHeader;
                            const handshakeAuth = request.headers.get("Authorization") || "";
                            const authHeader = msgAuth || handshakeAuth;

                            let finalOutput = "";
                            try {
                                // Logic: ALL skills (including weather, scrape) go through handleExecuteSkill
                                // This ensures Auth → Rate Limit → Billing → Execution is always applied.
                                const executeUrl = new URL(request.url);
                                executeUrl.pathname = `/v1/execute/${toolName}`;

                                const internalRequest = new Request(executeUrl.toString(), {
                                    method: "POST",
                                    headers: {
                                        "Authorization": authHeader,
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify(toolArguments || {})
                                });

                                const response = await handleExecuteSkill(internalRequest, env, ctx);
                                const resultRaw = await response.text();

                                try {
                                    const parsed = JSON.parse(resultRaw);
                                    finalOutput = formatToolResponse(parsed);
                                } catch {
                                    finalOutput = formatToolResponse(resultRaw);
                                }
                            } catch (apiError: any) {
                                finalOutput = `[Tool Execution Failed] Upstream API Error: ${apiError.message || "Unknown error"}`;
                            }

                            result = {
                                content: [{ type: "text", text: finalOutput }]
                            };
                        }
                        else if (method === "initialize") {
                            result = {
                                protocolVersion: "2024-11-05",
                                capabilities: {},
                                serverInfo: { name: "UniSkill-Gateway", version: "1.0.0" }
                            };
                        }

                        // 把执行结果顺着 SSE 流推给 Agent
                        const responsePayload = { jsonrpc: "2.0", id: id, result: result };
                        const sseMessage = `event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`;
                        controller.enqueue(encoder.encode(sseMessage));

                        // 阅后即焚
                        await env.UNISKILL_KV.delete(msgKey);
                    }
                } catch (e: any) {
                    console.error("SSE Polling error:", e);
                    // 即使出错也尝试给对端一个错误响应，防止挂起
                }

                await new Promise(resolve => setTimeout(resolve, 500));
            }
        },
        cancel() {
            console.log(`[MCP] ❌ SSE Stream canceled by network: ${sessionId}`);
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        }
    });
}

// ============================================================================
// 🔴 通道 2: 指令接收端点 (POST)
// ============================================================================
export async function handleMCPMessage(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
        return errorResponse("Missing sessionId.", 400);
    }

    let payload: any;
    try {
        payload = await request.json();
    } catch {
        return errorResponse("Invalid JSON-RPC payload.", 400);
    }

    console.log(`[MCP] ✍️ POST received, writing to KV Broker for session ${sessionId}`);

    // 把当前请求的 Authorization 头也装进锦囊，传给监听者
    const authHeader = request.headers.get("Authorization");
    const brokerPayload = { ...payload, authHeader };

    // 将指令写进 KV 传达室！设置 5 分钟过期，防止垃圾数据堆积
    await env.UNISKILL_KV.put(`mcp_msg:${sessionId}`, JSON.stringify(brokerPayload), { expirationTtl: 300 });

    return new Response("Accepted", { status: 202 });
}

// ============================================================================
// 🔵 通道 3: M2M 专用执行入口 (Web3 计费 + 任务分发)
// ============================================================================
export async function handleM2MCall(_request: Request, env: Env): Promise<Response> {
    // 逻辑：该端点是为“野生 Agent”准备的付费执行入口。
    // 未来在这里集成 Nevermined SDK 或 Stripe Web3 Payment 扣费逻辑。
    
    return new Response(JSON.stringify({
        success: true,
        message: "M2M Execution Engine reached.",
        environment: env.ENVIRONMENT,
        m2m_enabled: env.ENABLE_M2M_PAYMENTS,
        note: "Web3/Nevermined billing integration is in progress on feat/web3-payment branch."
    }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}

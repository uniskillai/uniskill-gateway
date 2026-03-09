// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Serverless-friendly SSE Engine using KV as a Message Broker

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
import { handleExecuteSkill } from "./execute-skill";

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

                            // 构造内部伪造请求调用核心执行器
                            // 使用当前 GET 请求的验证头（如果存在）
                            const authHeader = request.headers.get("Authorization") || "";
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
                            const resultText = await response.text();

                            result = {
                                content: [{ type: "text", text: resultText }]
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

    // 将指令写进 KV 传达室！设置 5 分钟过期，防止垃圾数据堆积
    await env.UNISKILL_KV.put(`mcp_msg:${sessionId}`, JSON.stringify(payload), { expirationTtl: 300 });

    return new Response("Accepted", { status: 202 });
}

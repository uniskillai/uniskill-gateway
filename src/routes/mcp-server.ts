// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Hardcore SSE-based MCP (Model Context Protocol) Engine for Cloudflare Workers

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
import { handleExecuteSkill } from "./execute-skill";

// 逻辑：全局内存字典，用于在 Serverless 环境中暂存 SSE 管道
// 注意：该 Map 在运行时可能会因为 Isolate 重启而丢失。对于单用户 Agent 网关这是可接受的折中方案。
const mcpSessions = new Map<string, ReadableStreamDefaultController>();

/**
 * 通道 1: SSE 握手端点 (Agent 发起 GET 请求时调用)
 * 职责：建立长连接，并下发 endpoint 事件通知 Agent 消息接收地址
 */
export async function handleMCPSse(request: Request, _env: Env): Promise<Response> {
    const sessionId = crypto.randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            mcpSessions.set(sessionId, controller);
            console.log(`[MCP] 🔗 SSE Connection opened: ${sessionId}`);

            // 【核心协议】MCP 强制要求：刚连上必须下发一个 endpoint 事件
            const postEndpoint = `/v1/mcp/message?sessionId=${sessionId}`;
            const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
            controller.enqueue(encoder.encode(initMessage));
        },
        cancel() {
            console.log(`[MCP] ❌ SSE Connection closed: ${sessionId}`);
            mcpSessions.delete(sessionId);
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

/**
 * 通道 2: 指令接收端点 (Agent 发起 POST 请求时调用)
 * 职责：接收 JSON-RPC 消息，处理业务逻辑，并将结果通过 SSE 流推回
 */
export async function handleMCPMessage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId || !mcpSessions.has(sessionId)) {
        return errorResponse("Session not found or disconnected. Please reconnect SSE.", 404);
    }

    const sseController = mcpSessions.get(sessionId)!;
    let payload: any;

    try {
        payload = await request.json();
    } catch {
        return errorResponse("Invalid JSON-RPC payload.", 400);
    }

    const { id, method, params } = payload;
    const encoder = new TextEncoder();

    console.log(`[MCP] 📩 Received command [${method}] on session ${sessionId}`);

    // 使用 ctx.waitUntil 确保异步任务在 Worker 响应后继续运行
    ctx.waitUntil((async () => {
        try {
            let result: any = {};

            if (method === "tools/list") {
                console.log(`[MCP] Fetching Tool List from KV...`);
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
                console.log(`[MCP] Executing Tool via SSE Internal logic: ${toolName}`);

                // 构造内部伪造请求调用核心执行器
                // 注意：这里需要继承原始请求的 Authorization 头
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
            else {
                // 处理 initialize 等其他基础握手消息 (Mock 响应)
                if (method === "initialize") {
                    result = {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        serverInfo: { name: "UniSkill-Gateway", version: "1.0.0" }
                    };
                } else {
                    throw new Error(`Method not supported: ${method}`);
                }
            }

            const responsePayload = { jsonrpc: "2.0", id: id, result: result };
            const sseMessage = `event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`;
            sseController.enqueue(encoder.encode(sseMessage));

        } catch (error: any) {
            console.error(`[MCP Error] ${error.message}`);
            const errorPayload = { jsonrpc: "2.0", id: id, error: { code: -32000, message: error.message } };
            sseController.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(errorPayload)}\n\n`));
        }
    })());

    return new Response("Accepted", { status: 202 });
}


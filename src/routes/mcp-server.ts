// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Serverless-friendly SSE Engine using KV as a Message Broker

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
import { handleExecuteSkill } from "./execute-skill";

/**
 * 逻辑：网关级数据防腐层 - 强制将任何奇葩数据转化为 MCP 兼容的纯文本
 * (Logic: Gateway-level anti-corruption layer - coerces outputs to MCP-compliant text)
 */
function formatToolResponse(rawData: any): string {
    if (rawData === null || rawData === undefined) {
        return "Execution successful, but no content was returned by the upstream API.";
    }
    if (typeof rawData === "string") {
        return rawData;
    }
    if (typeof rawData === "object") {
        try {
            return JSON.stringify(rawData, null, 2);
        } catch (e) {
            return `[Warning: Unserializable Object] ${String(rawData)}`;
        }
    }
    return String(rawData);
}

// ============================================================================
// 🚨 静态技能字典 (Fallback Registry)
// 逻辑：在 KV 动态元数据或缓存未命中时，使用静态字典兜底保命。
// (Logic: Static fallback registry used when KV cache misses or fails)
// ============================================================================
const FALLBACK_TOOLS = [
    {
        name: "uniskill_search",
        description: "Perform real-time web searches using the Tavily engine.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    },
    {
        name: "uniskill_news",
        description: "Fetch global news headlines and summaries.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    },
    {
        name: "uniskill_scrape",
        description: "Scrape and extract text content from any webpage URL.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    },
    {
        name: "uniskill_weather",
        description: "Get current weather forecast for a location.",
        inputSchema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }
    },
    {
        name: "uniskill_math",
        description: "A native math calculation engine with no hallucination.",
        inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }
    },
    {
        name: "uniskill_time",
        description: "Get current time and convert between timezones.",
        inputSchema: { type: "object", properties: { timezone: { type: "string" } }, required: [] }
    },
    {
        name: "uniskill_crypto_util",
        description: "Perform crypto hashing, UUID generation, and Base64 encoding.",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["hash", "uuid", "base64"] }, data: { type: "string" } }, required: ["action"] }
    },
    {
        name: "uniskill_geo",
        description: "Location and map geocoding engine.",
        inputSchema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }
    },
    {
        name: "uniskill_wiki",
        description: "Search and read Wikipedia articles.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    },
    {
        name: "uniskill_github_tracker",
        description: "Monitors GitHub trends to track emerging open-source tools, growth velocity, and author backgrounds.",
        inputSchema: { 
            type: "object", 
            properties: { 
                timeWindow: { type: "string", enum: ["daily", "weekly", "monthly"], description: "The timeframe to analyze." },
                language: { type: "string", description: "Target programming language." },
                topic: { type: "string", description: "Specific domain tag (e.g., web3, machine-learning)." }
            },
            required: ["timeWindow"] 
        }
    },
    {
        name: "uniskill_smart_chart",
        description: "A headless rendering engine that converts structured JSON data into high-quality, shareable chart image URLs (PNG). Perfect for visualizing trends, stock prices, or any tabular data.",
        inputSchema: {
            type: "object",
            properties: {
                chartType: { type: "string", enum: ["bar", "line", "pie", "doughnut", "radar"], description: "The type of chart to generate." },
                title: { type: "string", description: "The main title displayed at the top of the chart." },
                labels: { type: "array", items: { type: "string" }, description: "X-axis categories." },
                datasets: { 
                    type: "array", 
                    items: { 
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            data: { type: "array", items: { type: "number" } },
                            backgroundColor: { type: "string" },
                            borderColor: { type: "string" }
                        }
                    },
                    description: "Data objects containing label and data arrays."
                },
                theme: { type: "string", enum: ["light", "dark"], description: "Color theme. Defaults to light." }
            },
            required: ["chartType", "labels", "datasets"]
        }
    }
];

// ============================================================================
// 🟢 通道 1: SSE 握手与监听端点 (GET)
// ============================================================================
export async function handleMCPSse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const sessionId = crypto.randomUUID();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            console.log(`[MCP] 🔗 SSE Connection opened: ${sessionId}`);

            const postEndpoint = `/v1/mcp/messages?sessionId=${sessionId}`;
            const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
            controller.enqueue(encoder.encode(initMessage));

            let isConnected = true;
            
            // 记录连接建立时间，用于监听全局热更新广播
            // (Track last broadcast time to implement hot-reload listeners)
            let lastBroadcastTime = Date.now();

            request.signal.addEventListener("abort", () => {
                isConnected = false;
                console.log(`[MCP] ❌ Client aborted SSE: ${sessionId}`);
            });

            while (isConnected) {
                try {
                    // ----------------------------------------------------------------
                    // 🚀 核心一：监听全局“技能库更新”广播 (Hot-Reload Broadcast Listener)
                    // ----------------------------------------------------------------
                    const globalUpdateSignal = await env.UNISKILL_KV.get("mcp_broadcast:tools_changed");
                    if (globalUpdateSignal && parseInt(globalUpdateSignal) > lastBroadcastTime) {
                        console.log(`[MCP] 📢 Broadcasting tool list change to session ${sessionId}`);
                        
                        // 触发 Agent 静默重载技能列表
                        const notification = {
                            jsonrpc: "2.0",
                            method: "notifications/tools/list_changed"
                        };
                        const sseMessage = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
                        controller.enqueue(encoder.encode(sseMessage));
                        
                        lastBroadcastTime = Date.now();
                    }

                    // ----------------------------------------------------------------
                    // 🚀 核心二：指令轮询与极速缓存读取 (Message Polling & O(1) Cache)
                    // ----------------------------------------------------------------
                    const msgKey = `mcp_msg:${sessionId}`;
                    const payloadStr = await env.UNISKILL_KV.get(msgKey);

                    if (payloadStr) {
                        const payload = JSON.parse(payloadStr);
                        const { id, method, params } = payload;
                        
                        try {
                            let result: any = {};

                            // --- 🛠️ 业务逻辑执行区 (Business Logic Execution) ---
                            if (method === "tools/list") {
                                // 极致性能优化：O(1) 预编译缓存读取，将 14s 延迟降至 50ms!
                                const cachedToolsStr = await env.UNISKILL_KV.get("mcp_registry:tools_cache");

                                if (cachedToolsStr) {
                                    const dynamicTools = JSON.parse(cachedToolsStr);
                                    console.log(`[MCP] ⚡ Cache HIT: Loaded ${dynamicTools.length} tools in O(1) time.`);
                                    result = { tools: dynamicTools };
                                } else {
                                    console.warn("[MCP] ⚠️ Cache MISS: 'mcp_registry:tools_cache' not found. Using FALLBACK_TOOLS.");
                                    result = { tools: FALLBACK_TOOLS };
                                }
                            }
                            else if (method === "tools/call") {
                                const toolName = params.name;
                                const toolArguments = params.arguments;

                                const msgAuth = payload.authHeader;
                                const handshakeAuth = request.headers.get("Authorization") || "";
                                const authHeader = msgAuth || handshakeAuth;

                                let finalOutput = "";
                                try {
                                    const executeUrl = new URL(request.url);
                                    executeUrl.pathname = `/v1/execute`;

                                    const internalRequest = new Request(executeUrl.toString(), {
                                        method: "POST",
                                        headers: {
                                            "Authorization": authHeader,
                                            "Content-Type": "application/json"
                                        },
                                        body: JSON.stringify({
                                            skill: toolName,
                                            params: toolArguments || {}
                                        })
                                    });

                                    const response = await handleExecuteSkill(internalRequest, env, ctx);
                                    
                                    if (!response.ok) {
                                        finalOutput = `[Error] Gateway rejected the request with status: ${response.status}. Message: ${await response.text()}`;
                                    } else {
                                        const resultRaw = await response.text();
                                        try {
                                            const parsed = JSON.parse(resultRaw);
                                            finalOutput = formatToolResponse(parsed);
                                        } catch {
                                            finalOutput = formatToolResponse(resultRaw);
                                        }
                                    }
                                } catch (apiError: any) {
                                    finalOutput = `[Tool Execution Failed] Upstream API Error: ${apiError.message || "Unknown error"}`;
                                }

                                result = {
                                    content: [{ type: "text", text: finalOutput }]
                                };
                            }
                            else if (method === "initialize") {
                                // 🚀 核心三：必须在此向客户端声明支持热更新！(Declare listChanged capability)
                                result = {
                                    protocolVersion: "2024-11-05",
                                    capabilities: {
                                        tools: {
                                            listChanged: true // 告诉 Agent：我有热更新能力！
                                        }
                                    },
                                    serverInfo: { name: "UniSkill-Gateway", version: "2.0.0" }
                                };
                            }

                            // 把执行结果顺着 SSE 流推给 Agent
                            if (id !== undefined) {
                                const responsePayload = { jsonrpc: "2.0", id: id, result: result };
                                const sseMessage = `event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`;
                                controller.enqueue(encoder.encode(sseMessage));
                            }
                        } catch (innerError: any) {
                            console.error(`[MCP] Error processing message ${id}:`, innerError);
                            if (id !== undefined) {
                                const errorPayload = { 
                                    jsonrpc: "2.0", 
                                    id: id, 
                                    error: { 
                                        code: -32603, 
                                        message: "Internal Error: " + (innerError.message || "Unknown error") 
                                    } 
                                };
                                const sseMessage = `event: message\ndata: ${JSON.stringify(errorPayload)}\n\n`;
                                controller.enqueue(encoder.encode(sseMessage));
                            }
                        }

                        // 阅后即焚
                        await env.UNISKILL_KV.delete(msgKey);
                    }
                } catch (e: any) {
                    console.error("SSE Loop error:", e);
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
export async function handleMCPMessages(request: Request, env: Env): Promise<Response> {
    let incomingPayload: any;
    try {
        const url = new URL(request.url);
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
            return errorResponse("Missing sessionId.", 400);
        }

        try {
            incomingPayload = await request.clone().json();
        } catch {
            return errorResponse("Invalid JSON payload.", 400);
        }

        console.log(`[MCP] ✍️ POST received, writing to KV Broker for session ${sessionId}`);

        const authHeader = request.headers.get("Authorization");
        const brokerPayload = { ...incomingPayload, authHeader };

        await env.UNISKILL_KV.put(`mcp_msg:${sessionId}`, JSON.stringify(brokerPayload), { expirationTtl: 300 });

        return new Response("Accepted", { status: 202 });

    } catch (error: any) {
        console.error("[MCP] Critical error in handleMCPMessages:", error);

        // 斩断卡死：强制返回标准的 JSON-RPC 错误响应
        return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: incomingPayload?.id || null,
            error: {
                code: -32603,
                message: "Internal Error: " + error.message
            }
        }), {
            status: 200, // JSON-RPC 错误通常返回 200，错误信息在 Body 中
            headers: { "Content-Type": "application/json" }
        });
    }
}

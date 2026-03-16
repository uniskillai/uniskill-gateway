// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Serverless-friendly SSE Engine using KV as a Message Broker

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
import { handleExecuteSkill } from "./execute-skill";

/**
 * 逻辑：网关级数据防腐层 - 强制将任何奇葩数据转化为 MCP 兼容的纯文本
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
// 逻辑：在 KV 动态元数据完全跑通前，先用这个静态字典兜底，确保 10 个技能都能被 Agent 发现。
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

            const postEndpoint = `/v1/mcp/message?sessionId=${sessionId}`;
            const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
            controller.enqueue(encoder.encode(initMessage));

            let isConnected = true;

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

                        // --- 🛠️ 业务逻辑执行区 (Business Logic Execution) ---
                        if (method === "tools/list") {
                            try {
                                // 1. 并发尝试从 KV 动态拉取所有"官方"与"社区"技能
                                // (Concurrently fetch both official and community/market skills to bypass KV single-prefix limit)
                                const [officialList, marketList] = await Promise.all([
                                    env.UNISKILL_KV.list({ prefix: "skill:official:" }),
                                    env.UNISKILL_KV.list({ prefix: "skill:market:" }) // 未来社区创作者的技能前缀
                                ]);

                                // 合并所有的键 (Merge all detected keys)
                                const allKeys = [...officialList.keys, ...marketList.keys];
                                const dynamicTools = [];

                                // 2. 高性能并发读取所有技能的具体内容 (High-performance concurrent value fetching)
                                // 避免在 for 循环里一个个 await 导致网关响应变慢
                                const skillPromises = allKeys.map(key => env.UNISKILL_KV.get(key.name));
                                const skillStrings = await Promise.all(skillPromises);

                                for (let i = 0; i < allKeys.length; i++) {
                                    const skillStr = skillStrings[i];
                                    if (skillStr) {
                                        try {
                                            const skill = JSON.parse(skillStr);
                                            
                                            // 1. 终极兼容：优先读取 skill_name，兼容 id, name，甚至去 meta 里找
                                            // (Ultimate compatibility: check skill_name, id, name, and meta object)
                                            const rawName = skill.skill_name || skill.id || skill.name || skill.meta?.skill_name || allKeys[i].name.replace(/^skill:(official|market):/, "");

                                            // 2. 核心防雷：强制 MCP 命名规范消毒 (仅允许字母、数字、下划线、横杠)
                                            // (Core Safeguard: Force MCP Regex Compliance)
                                            let safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);
                                            
                                            if (!safeName) safeName = `uniskill_tool_${i}`;

                                            // 强制组装
                                            dynamicTools.push({
                                                name: safeName, 
                                                description: skill.meta?.description || skill.display_name || `UniSkill Tool: ${safeName}`,
                                                inputSchema: {
                                                    type: "object",
                                                    properties: skill.meta?.parameters?.properties || {},
                                                    required: skill.meta?.parameters?.required || []
                                                }
                                            });
                                        } catch (parseError) {
                                            console.error(`[MCP] ⚠️ Failed to parse skill JSON for key: ${allKeys[i].name}`, parseError);
                                        }
                                    }
                                }

                                // 3. 决策与降级 (Decision & Fallback)
                                if (dynamicTools.length > 0) {
                                    // 完美情况：KV 正常，返回动态技能列表 (包括官方与社区)
                                    console.log(`[MCP] 🟢 Successfully loaded ${dynamicTools.length} dynamic tools from KV.`);
                                    result = { tools: dynamicTools };
                                } else {
                                    // 异常情况：KV 里没数据，安全降级使用静态兜底列表
                                    console.warn("[MCP] ⚠️ KV returned 0 tools. Falling back to FALLBACK_TOOLS.");
                                    result = { tools: FALLBACK_TOOLS };
                                }

                            } catch (err) {
                                // 彻底崩溃兜底：连读 KV 都报错了，依然返回静态列表保命
                                console.error("[MCP] ❌ Critical error loading from KV. Using fallback:", err);
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
                                executeUrl.pathname = `/v1/execute`; // 注意：确保与您的 execute-skill.ts 路由匹配

                                const internalRequest = new Request(executeUrl.toString(), {
                                    method: "POST",
                                    headers: {
                                        "Authorization": authHeader,
                                        "Content-Type": "application/json"
                                    },
                                    // 必须将请求组装成网关能懂的格式 (skill + params)
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

                            // 严格遵守 MCP 的返回格式
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

    const authHeader = request.headers.get("Authorization");
    const brokerPayload = { ...payload, authHeader };

    await env.UNISKILL_KV.put(`mcp_msg:${sessionId}`, JSON.stringify(brokerPayload), { expirationTtl: 300 });

    return new Response("Accepted", { status: 202 });
}

// src/durable_objects/MCPSession.ts
// Logic: Stateful MCP session manager for Cloudflare Durable Objects
// 职责：在内存中维护 SSE 流，确保消息推送的一致性，防止分布式孤岛导致的卡死。

import { handleExecuteSkill } from "../routes/execute-skill";
import { SkillParser } from "../engine/parser";

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

export class MCPSession {
  private ctx: DurableObjectState;
  private env: any; // Will be properly typed
  private controller: ReadableStreamDefaultController | null = null;
  private storedAuthHeader: string = ""; // 🌟 核心状态：持久化存储握手时的鉴权信息

  constructor(ctx: DurableObjectState, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // ── 通道 A: SSE 建立 (GET) ──────────────────
    if (request.method === "GET") {
      console.log(`[DO] 🔗 New SSE Connection establishing...`);
      // 🌟 核心修复：在握手阶段锁定身份 (Lock identity during handshake)
      this.storedAuthHeader = request.headers.get("Authorization") || "";

      const stream = new ReadableStream({
        start: (controller) => {
          this.controller = controller;
          
          // 发送初始 endpoint 事件，告知客户端后续消息应 POST 到本 DO 实例
          // (Logic: Notify client of the stateful POST endpoint tied to this DO instance)
          const postEndpoint = `/v1/mcp/messages?session_id=${this.ctx.id.toString()}`;
          const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
          controller.enqueue(new TextEncoder().encode(initMessage));

          // 🌟 10 秒心跳机制：防止连接挂起并强制刷新缓冲区 (10s heartbeat to prevent hanging and flush buffer)
          const heartbeatTimer = setInterval(() => {
              if (this.controller) {
                  try {
                      this.controller.enqueue(new TextEncoder().encode(":\n\n")); // SSE 注释心跳 (SSE comment heartbeat)
                  } catch (e) {
                      clearInterval(heartbeatTimer);
                  }
              } else {
                  clearInterval(heartbeatTimer);
              }
          }, 10000);
          
          // 在 ctx.waitUntil 中记录计时器，防止 DO 被意外回收 (Wait until helper can track timers if needed)
        },
        cancel: () => {
          this.controller = null;
          console.log(`[DO] ❌ SSE stream canceled.`);
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

    // ── 通道 B: 消息推送 (POST) ──────────────────
    if (request.method === "POST") {
      const payload: any = await request.json();
      const requestId = payload.id;

      // ⚠️ 斩断卡死逻辑：使用 Promise.race 实现 15 秒超时拦截
      try {
        await Promise.race([
          this.processMessage(payload, request),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Request Timeout after 15s")), 15000)
          )
        ]);
        return new Response("Accepted", { status: 202 });
      } catch (error: any) {
        console.error(`[DO] ❌ Message processing failed: ${error.message}`);
        
        // 返回标准格式的 JSON-RPC 错误提示
        if (this.controller) {
          const errorPayload = {
            jsonrpc: "2.0",
            id: requestId || null,
            error: {
              code: -32603,
              message: "Internal Error: " + error.message
            }
          };
          const sseMessage = `event: message\ndata: ${JSON.stringify(errorPayload)}\n\n`;
          this.controller.enqueue(new TextEncoder().encode(sseMessage));
        }

        return new Response("Internal Error", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  /**
   * 核心逻辑：处理接收到的 MCP 消息并推送到 SSE 控制器
   */
  private async processMessage(payload: any, originalRequest: Request) {
    if (!this.controller) {
      throw new Error("No active SSE connection found for this session.");
    }

    const { id, method, params } = payload;
    let result: any = {};

    // --- 🛠️ 业务逻辑执行区 (Business Logic Execution) ---
    if (method === "tools/list") {
        try {
            // 🌟 核心修复：使用 Map 去重 (Use Map to deduplicate tools)
            const publicToolMap = new Map();

            // 🌟 核心：归一化处理函数 (Normalization helper to unify prefixes)
            const normalizeCoreName = (name: string) => name.startsWith("uniskill_") ? name : `uniskill_${name}`;

            // 1. 安全加载兜底工具 (Safely load fallback base tools)
            if (typeof FALLBACK_TOOLS !== 'undefined' && Array.isArray(FALLBACK_TOOLS)) {
                FALLBACK_TOOLS.forEach(tool => {
                    if (tool && tool.name) {
                        const normName = normalizeCoreName(tool.name);
                        publicToolMap.set(normName, { ...tool, name: normName });
                    }
                });
            }

            // 2. 尝试拉取全球 KV 缓存并覆盖兜底 (Fetch KV cache and override fallbacks safely)
            try {
                const cachedToolsStr = await this.env.UNISKILL_KV.get("mcp_registry:tools_cache");
                if (cachedToolsStr) {
                    const cachedTools = JSON.parse(cachedToolsStr); 
                    if (Array.isArray(cachedTools)) {
                        cachedTools.forEach(tool => {
                            if (tool && tool.name) {
                                const normName = normalizeCoreName(tool.name);
                                // 🌟 核心：高优先级通过归一化键名覆盖 (High priority override via normalized key)
                                publicToolMap.set(normName, { ...tool, name: normName });
                            }
                        });
                    }
                }
            } catch (kvErr) {
                console.warn("[DO] Failed to fetch or parse public tools from KV:", kvErr);
                // 即使 KV 挂了，也不要中断，继续往下走 (Don't throw, continue execution)
            }

            let allTools = Array.from(publicToolMap.values());

            // 3. 隔离处理私有工具 (Isolate private tools fetching)
            try {
                // 安全获取 authHeader (Safely get authHeader, avoid undefined crashes)
                // 🌟 核心逻辑：保留会话全生命周期身份感知 (Keep session-wide identity awareness)
                const authHeader = payload?.authHeader || originalRequest.headers.get("Authorization") || this.storedAuthHeader || "";
                const rawKey = authHeader.replace("Bearer ", "").trim();
                
                if (rawKey.startsWith("us-")) {
                    const { hashKey } = await import("../utils/auth");
                    const keyHash = await hashKey(rawKey);
                    const { getUserUid } = await import("../utils/billing");
                    const userUid = await getUserUid(this.env.UNISKILL_KV, keyHash, this.env);

                    if (userUid) {
                        const list = await this.env.UNISKILL_KV.list({ prefix: `skill:private:${userUid}:` });
                        const fetchPromises = list.keys.map(async (key: any) => {
                            const raw = await this.env.UNISKILL_KV.get(key.name);
                            if (!raw) return null;

                            try {
                                // 1. 尝试作为大一统 JSON 解析 (Try parsing as Unified JSON)
                                try {
                                    const toolRaw = JSON.parse(raw);
                                    const baseName = toolRaw.id || key.name.split(':').pop();
                                    return {
                                        name: `${userUid}__${baseName}`, 
                                        description: toolRaw.meta?.description || toolRaw.description || "Private tool",
                                        inputSchema: toolRaw.config?.parameters || toolRaw.meta?.parameters || toolRaw.parameters || { type: "object", properties: {} }
                                    };
                                } catch (jsonErr) {
                                    // 2. 回退：作为原始 Markdown 解析 (Fallback to Markdown parsing)
                                    const toolSpec = SkillParser.parse(raw);
                                    const baseName = toolSpec.name || key.name.split(':').pop();
                                    return {
                                        name: `${userUid}__${baseName}`,
                                        description: toolSpec.description || "Private tool (parsed from Markdown)",
                                        inputSchema: toolSpec.parameters || { type: "object", properties: {} }
                                    };
                                }
                            } catch (parseErr) {
                                return null; // 忽略单个私有工具解析错误 (Ignore individual private tool parse error)
                            }
                        });
                        
                        const privateTools = (await Promise.all(fetchPromises)).filter(Boolean);
                        
                        // 合并私有工具 (Merge private tools)
                        for (const pt of privateTools) {
                            const ptName = (pt as any).name;
                            const index = allTools.findIndex(t => t.name === ptName);
                            if (index !== -1) {
                                allTools[index] = pt;
                            } else {
                                allTools.push(pt);
                            }
                        }
                    }
                }
            } catch (authErr) {
                console.error("[DO] Private tools auth/fetch error. Skipping private tools.", authErr);
                // 鉴权或私有库读取失败，直接忽略，保证公共工具能返回 (If auth fails, just skip so public tools can still be returned)
            }

            // 最终赋值 (Final assignment)
            result = { tools: allTools };

        } catch (err) {
            console.error("[DO] Critical error in tools/list. Falling back to basics.", err);
            // 终极保命兜底，确保长连接一定能收到回包 (Ultimate fallback to ensure SSE response is sent)
            result = { tools: typeof FALLBACK_TOOLS !== 'undefined' ? FALLBACK_TOOLS : [] }; 
        }
    }
    else if (method === "tools/call") {
        const toolName = params.name; // e.g., "uniskill__weather" or "owner_uid__skill_name"
        const toolArguments = params.arguments || {};
        // 🌟 核心修复：补全会话身份感应 (Fix: Ensure session identity persistence)
        const authHeader = payload.authHeader || originalRequest.headers.get("Authorization") || this.storedAuthHeader || "";

        // 🌟 1. 智能拆解命名空间 (Parse namespace intelligently using double underscore)
        const nameParts = toolName.split('__');
        const isPrivate = nameParts.length > 1;
        const actualSkillName = isPrivate ? nameParts[1] : toolName;
        const ownerUid = isPrivate ? nameParts[0] : "public";

        let finalOutput = "";
        let isError = false;

        try {
            const executeUrl = new URL(originalRequest.url);
            executeUrl.pathname = `/v1/execute`;

            // 🌟 2. 组装绝对严谨的底层信封 (Assemble strict internal envelope)
            // 双重保险：同时塞入 payload 和 params，彻底防止 "最后一公里" 丢包
            const internalRequest = new Request(executeUrl.toString(), {
                method: "POST",
                headers: {
                    "Authorization": authHeader,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    skill_name: actualSkillName,
                    skill_id: toolName, 
                    user_uid: ownerUid,
                    payload: toolArguments,            
                    params: toolArguments              
                })
            });

            const response = await handleExecuteSkill(internalRequest, this.env, this.ctx as any); 
            
            if (!response.ok) {
                const errorText = await response.text();
                finalOutput = `[Gateway Error] ${response.status}: ${errorText}`;
                isError = true;
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
            isError = true;
        }

        result = {
            content: [{ type: "text", text: finalOutput }],
            isError: isError
        };
    }
    else if (method === "initialize") {
        result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "UniSkill-Gateway-Durable", version: "3.0.0" }
        };
    }

    // 推送执行结果至 SSE 控制器 (Push result to SSE)
    if (id !== undefined) {
        const responsePayload = { jsonrpc: "2.0", id: id, result: result };
        const sseMessage = `event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`;
        console.log(`[DO] 📤 Enqueueing SSE message for Request ID: ${id}`);
        this.controller.enqueue(new TextEncoder().encode(sseMessage));
    }

    return true;
  }
}

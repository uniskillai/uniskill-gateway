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

  constructor(ctx: DurableObjectState, env: any) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // ── 通道 A: SSE 建立 (GET) ──────────────────
    if (request.method === "GET") {
      console.log(`[DO] 🔗 New SSE Connection establishing...`);

      const stream = new ReadableStream({
        start: (controller) => {
          this.controller = controller;
          
          // 发送初始 endpoint 事件，告知客户端后续消息应 POST 到本 DO 实例
          // (Logic: Notify client of the stateful POST endpoint tied to this DO instance)
          const postEndpoint = `/v1/mcp/messages?session_id=${this.ctx.id.toString()}`;
          const initMessage = `event: endpoint\ndata: ${postEndpoint}\n\n`;
          controller.enqueue(new TextEncoder().encode(initMessage));
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
            const cachedToolsStr = await this.env.UNISKILL_KV.get("mcp_registry:tools_cache");
            let allTools: any[] = [];
            if (cachedToolsStr) {
                try { allTools = JSON.parse(cachedToolsStr); } catch { }
            }
            // 基础公共工具 = 全局缓存 + fallback
            allTools = [...allTools, ...FALLBACK_TOOLS];

            // --- Access-Aware Discovery (Private Layer) ---
            const authHeader = payload.authHeader || originalRequest.headers.get("Authorization") || "";
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
                                const tool = JSON.parse(raw);
                                const baseName = tool.id || key.name.split(':').pop();
                                return {
                                    name: `${userUid}.${baseName}`, // 🌟 统一为 owner.skill 格式
                                    description: tool.meta?.description || tool.description || "Private tool",
                                    inputSchema: tool.meta?.parameters || { type: "object", properties: {} }
                                };
                            } catch (jsonErr) {
                                // 2. 回退：作为原始 Markdown 解析 (Fallback to Markdown parsing)
                                const tool = SkillParser.parse(raw);
                                const baseName = tool.name || key.name.split(':').pop();
                                return {
                                    name: `${userUid}.${baseName}`, // 🌟 统一为 owner.skill 格式
                                    description: tool.description || "Private tool (parsed from Markdown)",
                                    inputSchema: tool.parameters || { type: "object", properties: {} }
                                };
                            }
                        } catch (e) {
                            console.error(`[MCPSession] Failed to process tool ${key.name}:`, e);
                            return null;
                        }
                    });
                    const privateTools = (await Promise.all(fetchPromises)).filter(Boolean);
                    
                    // Merge unique tools (Private tools hide public ones with same name if overridden)
                    const existingNames = new Set(allTools.map(t => t.name));
                    for (const pt of privateTools) {
                        if (!existingNames.has((pt as any).name)) {
                            allTools.push(pt);
                            existingNames.add((pt as any).name);
                        } else {
                            // Find and replace with private tool
                            const index = allTools.findIndex(t => t.name === (pt as any).name);
                            if (index !== -1) allTools[index] = pt;
                        }
                    }
                }
            }

            result = { tools: allTools };
        } catch (err) {
            result = { tools: FALLBACK_TOOLS };
        }
    }
    else if (method === "tools/call") {
        const toolName = params.name; // e.g., "uniskill.weather" or "owner_uid.skill_name"
        const toolArguments = params.arguments || {};
        const authHeader = payload.authHeader || originalRequest.headers.get("Authorization") || "";

        // 🌟 1. 智能拆解命名空间 (Parse namespace intelligently)
        const nameParts = toolName.split('.');
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
        this.controller.enqueue(new TextEncoder().encode(sseMessage));
    }

    return true;
  }
}

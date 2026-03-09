// uniskill-gateway/src/routes/mcp-server.ts
// Logic: Core MCP (Model Context Protocol) Server for Dynamic Tool Discovery and Execution.

import type { Env } from "../index";
import { errorResponse } from "../utils/response";
// 静态导入核心执行网关，消除循环依赖
import { handleExecuteSkill } from "./execute-skill";

export async function handleMCPRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 逻辑：MCP 协议要求必须是 POST 请求传输 JSON-RPC 消息
    if (request.method !== "POST") {
        return errorResponse("Method Not Allowed. MCP endpoint requires POST.", 405);
    }

    let payload: any;
    try {
        payload = await request.json();
    } catch {
        return errorResponse("Invalid JSON-RPC payload.", 400);
    }

    const { jsonrpc, id, method, params } = payload;

    // 逻辑：校验是否为标准的 JSON-RPC 2.0 格式
    if (jsonrpc !== "2.0") {
        return errorResponse("Invalid protocol. Only JSON-RPC 2.0 is supported.", 400);
    }

    // ============================================================================
    // 🟢 MCP 核心指令 1: 工具发现 (List Tools) - 替代手动写 SKILL.md
    // ============================================================================
    if (method === "tools/list") {
        console.log(`[MCP] Agent requested tool list. Fetching from KV...`);

        // 逻辑：利用终极前缀索引，秒拉所有官方技能
        const kvList = await env.UNISKILL_KV.list({ prefix: "skill:official:" });
        const mcpTools: any[] = [];

        for (const key of kvList.keys) {
            const skillDataStr = await env.UNISKILL_KV.get(key.name);
            if (skillDataStr) {
                const skill = JSON.parse(skillDataStr);

                // 逻辑：将 UniSkill 的数据结构，完美转译为 MCP 的 InputSchema 契约
                mcpTools.push({
                    name: skill.id, // e.g., "uniskill_weather"
                    description: skill.meta?.description || skill.docs?.description || "No description provided.",
                    // 逻辑：直接读取预存的 JSON Schema (参数)
                    inputSchema: skill.meta?.parameters || { type: "object", properties: {} }
                });
            }
        }

        // 逻辑：返回 MCP 标准响应
        return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: id,
            result: {
                tools: mcpTools
            }
        }), { headers: { "Content-Type": "application/json" } });
    }

    // ============================================================================
    // 🔴 MCP 核心指令 2: 工具调用 (Call Tool) - 对接扣费引擎
    // ============================================================================
    if (method === "tools/call") {
        const toolName = params.name;
        const toolArguments = params.arguments;

        console.log(`[MCP] Agent executing tool: ${toolName}`, toolArguments);

        // 1. 从 KV 中精准读取该技能的配置
        const skillDataStr = await env.UNISKILL_KV.get(`skill:official:${toolName}`);

        if (!skillDataStr) {
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: id,
                error: { code: -32601, message: `Tool not found on UniSkill Server: ${toolName}` }
            }), { headers: { "Content-Type": "application/json" } });
        }

        try {
            // 构造虚拟 Request 给主入口执行，复用全部鉴权、计费、清洗逻辑
            const authHeader = request.headers.get("Authorization");
            if (!authHeader) {
                return new Response(JSON.stringify({
                    jsonrpc: "2.0",
                    id: id,
                    error: { code: -32000, message: `Missing Authorization header for tool execution.` }
                }), { headers: { "Content-Type": "application/json" } });
            }

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

            // 核心联动：直接调用纯净的执行网关，复用全部鉴权、计费、清洗逻辑
            const response = await handleExecuteSkill(internalRequest, env, ctx);

            if (!response.ok) {
                const errText = await response.text();
                return new Response(JSON.stringify({
                    jsonrpc: "2.0",
                    id: id,
                    error: { code: -32000, message: `Execution Gateway Error: ${errText}` }
                }), { headers: { "Content-Type": "application/json" } });
            }

            const resultText = await response.text();

            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: id,
                result: {
                    content: [
                        {
                            type: "text",
                            text: resultText
                        }
                    ]
                }
            }), { headers: { "Content-Type": "application/json" } });

        } catch (error: any) {
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: id,
                error: { code: -32000, message: `UniSkill execution failed: ${error.message}` }
            }), { headers: { "Content-Type": "application/json" } });
        }
    }

    // 逻辑：兜底处理未知的 MCP 指令
    return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: `MCP Method not supported by UniSkill: ${method}` }
    }), { headers: { "Content-Type": "application/json" } });
}

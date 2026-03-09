// src/index.ts
// Logic: Gateway entry point using key-based authentication
// 职责：环境类型声明 + 请求路由分发 + 全局中间件（统一鉴权与平台化执行）

import { hashKey } from "./utils/auth";
import { SkillKeys } from "./utils/skill-keys";
import { handleProvision } from "./routes/admin";
import { handleMCPSse, handleMCPMessage } from "./routes/mcp-server";
import { handleExecuteSkill } from "./routes/execute-skill";
import { handleAuthVerify } from "./routes/auth";
import { errorResponse, corsHeaders, successResponse } from "./utils/response";
import { SkillParser } from "./engine/parser";

// ── 环境变量类型声明 ──────────────────────────────────────────
export interface Env {
  UNISKILL_KV: KVNamespace;
  TAVILY_API_KEY: string;
  JINA_API_KEY: string;
  NEWS_API_KEY: string;
  ADMIN_KEY: string;
  VERCEL_WEBHOOK_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  WEB_DOMAIN: string;
  INTERNAL_API_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Preflight: Handle CORS ──
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const cleanPath = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;

    // ============================================================================
    // 逻辑：极其严谨的版本化路由分发 (V1 API 组)
    // ============================================================================
    if (cleanPath.startsWith("/v1/")) {

      // ── GET Routes (Frontend Discover & Details) ──

      // 路由：List All Skills
      if (method === "GET" && cleanPath === "/v1/skills") {
        console.log(`[DEBUG] GET Skills List`);
        const authHeader = request.headers.get("Authorization") || "";
        const rawKey = authHeader.replace("Bearer ", "").trim();
        let keyHash: string | undefined = undefined;
        if (rawKey.startsWith("us-")) {
          keyHash = await hashKey(rawKey);
        }

        const skills = [];
        const scanCategories = [
          { prefix: "skill:official:", source: "official" },
          { prefix: "skill:market:", source: "market" }
        ];

        if (keyHash) {
          scanCategories.unshift({ prefix: `skill:private:${keyHash}:`, source: "private" });
        }

        for (const cat of scanCategories) {
          const list = await env.UNISKILL_KV.list({ prefix: cat.prefix });

          // 逻辑：将耗时的串行 GET 改为并行的 Promise.all 进行并发请求优化
          const fetchPromises = list.keys.map(async (key) => {
            const raw = await env.UNISKILL_KV.get(key.name);
            if (raw) {
              try {
                const skill = JSON.parse(raw);
                return {
                  id: skill.id || key.name.split(':').pop(),
                  name: skill.meta?.name || skill.name,
                  description: skill.meta?.description || skill.description,
                  emoji: skill.meta?.emoji,
                  source: skill.source || cat.source,
                  isOfficial: (skill.source || cat.source) === "official"
                };
              } catch (e) {
                console.error(`Failed to parse unified skill ${key.name}:`, e);
                return null;
              }
            }
            return null;
          });

          const parsedSkills = (await Promise.all(fetchPromises)).filter(Boolean);
          skills.push(...parsedSkills);
        }
        return successResponse({ data: skills });
      }

      // 路由：Export All Skills as OpenAI JSON Schema (Dynamic Discovery)
      if (method === "GET" && cleanPath === "/v1/skills/schema") {
        const list = await env.UNISKILL_KV.list({ prefix: "skill:official:" });
        const schemas = [];

        for (const key of list.keys) {
          const raw = await env.UNISKILL_KV.get(key.name);
          if (raw) {
            try {
              const skill = JSON.parse(raw);
              schemas.push({
                name: skill.id,
                description: skill.meta?.description || skill.docs?.short || "No description",
                parameters: skill.meta?.parameters || { type: "object", properties: {} }
              });
            } catch (e) {
              console.error(`Failed to parse skill for schema export: ${key.name}`, e);
            }
          }
        }
        return successResponse({ tools: schemas });
      }

      // 路由：Get Skill Detail API
      if (method === "GET" && cleanPath.startsWith("/v1/skills/")) {
        const skillName = cleanPath.split("/").pop();
        console.log(`[DEBUG] GET Skill Detail: path=${path}, skillName=${skillName}`);

        if (!skillName) return errorResponse("Missing skill name", 400);

        const authHeader = request.headers.get("Authorization") || "";
        const rawKey = authHeader.replace("Bearer ", "").trim();
        let keyHash: string | undefined = undefined;
        if (rawKey.startsWith("us-")) {
          keyHash = await hashKey(rawKey);
        }

        let skillRaw: string | null = null;
        let source: "official" | "private" | "market" = "official";

        if (keyHash) {
          skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));
          if (skillRaw) source = "private";
        }
        if (!skillRaw) {
          skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
          if (skillRaw) source = "official";
        }
        if (!skillRaw) {
          skillRaw = await env.UNISKILL_KV.get(SkillKeys.market(skillName));
          if (skillRaw) source = "market";
        }

        if (!skillRaw) return errorResponse("Skill Not Found", 404);

        const skill = SkillParser.parse(skillRaw);
        return successResponse({
          spec: skill,
          source: skill.source || source,
          is_official: (skill.source || source) === "official",
          success: true
        });
      }


      // ── POST Routes (Execution & Integration) ──

      // 路由：API Key 校验 (Ping)
      if (cleanPath === "/v1/auth/verify" && method === "GET") {
        return handleAuthVerify(request, env);
      }

      // 路由：Admin Provisioning
      if (cleanPath === "/v1/admin/provision" && method === "POST") {
        const authHeader = request.headers.get("Authorization") || "";
        const adminSecret = authHeader.replace("Bearer ", "").trim();
        if (adminSecret !== env.ADMIN_KEY) {
          return errorResponse("Unauthorized Admin Access", 401);
        }
        return handleProvision(request, env);
      }

      // 路由：标准 MCP 协议请求 (SSE 模式)
      if (cleanPath === "/v1/mcp") {
        if (method === "GET") {
          return handleMCPSse(request, env);
        }
      }

      // 路由：MCP 消息接收端点
      if (cleanPath === "/v1/mcp/message" && method === "POST") {
        return handleMCPMessage(request, env, ctx);
      }

      // 路由：底层工具执行 (Agent 直接调用)
      // 注意：支持 /v1/execute 以及 /v1/execute/:toolName 两种语义 (RESTful 优雅架构)
      if (cleanPath.startsWith("/v1/execute") && method === "POST") {
        return handleExecuteSkill(request, env, ctx);
      }

      // 逻辑：V1 组内未匹配的路径
      return new Response(JSON.stringify({ error: "Endpoint not found in v1 API." }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ── Legacy Compatibility ──
    // 兼容根目录直接 POST
    if (path === "/" && method === "POST") {
      return handleExecuteSkill(request, env, ctx);
    }

    // 逻辑：全局兜底，拦截所有非规范的路径请求
    return new Response(JSON.stringify({ error: "Invalid API version or route. Please use /v1/..." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};

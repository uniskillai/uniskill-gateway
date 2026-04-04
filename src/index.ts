// src/index.ts
// Logic: Gateway entry point using key-based authentication
// 职责：环境类型声明 + 请求路由分发 + 全局中间件（统一鉴权与平台化执行）

import { hashKey } from "./utils/auth";
import { SkillKeys } from "./utils/skill-keys";
import { handleProvision } from "./routes/admin";
import { handleExecuteSkill } from "./routes/execute-skill";
import { handleAuthVerify } from "./routes/auth";
import { errorResponse, corsHeaders, successResponse } from "./utils/response";
import { SkillParser } from "./engine/parser";
export { MCPSession } from "./durable_objects/MCPSession";

// ── 环境变量类型声明 ──────────────────────────────────────────
export interface Env {
  UNISKILL_KV: KVNamespace;
  TAVILY_API_KEY: string;
  JINA_API_KEY: string;
  MAPBOX_API_KEY: string;
  ADMIN_KEY: string;
  VERCEL_WEBHOOK_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  VOYAGE_API_KEY?: string;
  WEB_DOMAIN: string;
  INTERNAL_API_SECRET: string;
  TEST_WALLET_ADDRESS?: string;
  GITHUB_TOKEN?: string;
  MASTER_ENCRYPTION_KEY: string;
  MCP_SESSION: DurableObjectNamespace;
  // 🌟 Auto-Workflow 元技能：DeepSeek Planner LLM 访问密钥
  // 配置方式：wrangler secret put DEEPSEEK_API_KEY
  DEEPSEEK_API_KEY?: string;

  // 🌟 CLI 运行时：远程沙箱 Node 节点 URL 与可选授权 Token
  SANDBOX_NODE_URL?: string;
  SANDBOX_AUTH_TOKEN?: string; // 保持旧版兼容
  SANDBOX_INTERNAL_TOKEN?: string; // 映射自 wrangler secret

  // 🌟 Vault 集成：用于安全 Secret 存储与隔离
  VAULT_URL?: string;
  VAULT_TOKEN?: string;

  // 🌟 核心绑定：元数据 KV 与 异步计费队列
  SKILLS_KV: KVNamespace; // 映射自技能清单 KV
  BILLING_QUEUE: Queue;  // 映射自 CF Queue
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

        let userUid: string | undefined = undefined;
        if (keyHash) {
          const { getUserUid } = await import("./utils/billing");
          userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        }

        const skills = [];
        const scanCategories = [
          { prefix: "skill:official:", source: "official" },
          { prefix: "skill:market:", source: "market" }
        ];

        if (userUid) {
          scanCategories.unshift({ prefix: `skill:private:${userUid}:`, source: "private" });
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
        const authHeader = request.headers.get("Authorization") || "";
        const rawKey = authHeader.replace("Bearer ", "").trim();
        let userUid: string | undefined = undefined;

        if (rawKey.startsWith("us-")) {
          const keyHash = await hashKey(rawKey);
          const { getUserUid } = await import("./utils/billing");
          userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
        }

        const scanCategories = [
          { prefix: "skill:official:", source: "official" }
        ];

        if (userUid && userUid !== "anonymous") {
          scanCategories.unshift({ prefix: `skill:private:${userUid}:`, source: "private" });
        }

        const schemas: any[] = [];
        for (const cat of scanCategories) {
          const list = await env.UNISKILL_KV.list({ prefix: cat.prefix });
          for (const key of list.keys) {
            const raw = await env.UNISKILL_KV.get(key.name);
            if (raw) {
              try {
                const skill = JSON.parse(raw);
                schemas.push({
                  // ID 用作函数名，Meta 用作描述
                  name: skill.id || key.name.split(':').pop(),
                  description: skill.meta?.description || skill.docs?.short || "No description",
                  parameters: skill.meta?.parameters || skill.config?.parameters || { type: "object", properties: {} }
                });
              } catch (e) {
                console.error(`Failed to parse skill for schema export: ${key.name}`, e);
              }
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
          const { getUserUid } = await import("./utils/billing");
          const userUid = await getUserUid(env.UNISKILL_KV, keyHash, env);
          skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(userUid, skillName));
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

      // 路由：Analytics 统计接口 (Analytics Dashboard API)
      if (cleanPath === "/v1/analytics" && method === "GET") {
        const userUid = await authenticate(request, env);
        if (!userUid) return errorResponse("Unauthorized: Missing or Invalid API Key", 401);
        
        const { handleGetAnalytics } = await import("./routes/analytics");
        // 将 userUid 注入 request 供处理器使用 (Inject userUid into request context)
        (request as any).userUid = userUid;
        return handleGetAnalytics(request, env);
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

      // 路由：Admin Sync Cache (Push mode from Control Plane)
      if (cleanPath === "/v1/admin/sync_cache" && method === "POST") {
        const authHeader = request.headers.get("Authorization") || "";
        const adminSecret = authHeader.replace("Bearer ", "").trim();
        if (adminSecret !== env.ADMIN_KEY) {
          return errorResponse("Unauthorized Admin Access", 401);
        }
        const { handleSyncCache } = await import("./routes/admin");
        return handleSyncCache(request, env);
      }

      // 路由：Admin Sync Skill (Push mode from Control Plane Finalize)
      if (cleanPath === "/v1/admin/sync_skill" && method === "POST") {
        const authHeader = request.headers.get("Authorization") || "";
        const adminSecret = authHeader.replace("Bearer ", "").trim();
        // Allow INTERNAL_API_SECRET as fallback for skill syncing
        if (adminSecret !== env.ADMIN_KEY && adminSecret !== env.INTERNAL_API_SECRET) {
          return errorResponse("Unauthorized Admin Access", 401);
        }
        const { handleSyncSkill } = await import("./routes/admin");
        return handleSyncSkill(request, env);
      }

      // 触发全局刷新的内部 API 端点 (Internal API to trigger global refresh)
      if (cleanPath === "/v1/admin/refresh-tools" && method === "POST") {
          // 只有您知道的超级密码 (Your secret admin token)
          if (request.headers.get("Authorization") !== `Bearer ${env.INTERNAL_API_SECRET}`) {
              return errorResponse("Unauthorized", 401);
          }
          
          // 在 KV 里写入当前时间戳，触发全局广播
          // (Write current timestamp to KV to trigger global broadcast)
          await env.UNISKILL_KV.put("mcp_broadcast:tools_changed", Date.now().toString());
          
          return new Response("Global tool refresh triggered successfully!", { status: 200 });
      }

      // 路由：MCP SSE 握手端点 (Logic: Create a new stateful DO instance)
      if (cleanPath === "/v1/mcp/sse" && method === "GET") {
        console.log(`[DEBUG] MCP SSE Handshake requested`);
        const id = env.MCP_SESSION.newUniqueId();
        const stub = env.MCP_SESSION.get(id);
        
        // 透传请求给 DO，DO 会在内存中维护这个连接 (Proxy to DO)
        const response = await stub.fetch(request);
        return response;
      }

      // 路由：MCP 消息接收端点 (Logic: Route to existing DO via session_id)
      if (cleanPath === "/v1/mcp/messages" && method === "POST") {
        const sessionId = url.searchParams.get("session_id");
        console.log(`[DEBUG] MCP Message received. session_id=${sessionId}`);
        if (!sessionId) {
          return errorResponse("Missing session_id in URL", 400);
        }

        try {
          const doId = env.MCP_SESSION.idFromString(sessionId);
          const stub = env.MCP_SESSION.get(doId);
          return await stub.fetch(request);
        } catch (e) {
          console.error(`[DEBUG] MCP Message fetch failure:`, e);
          return errorResponse("Invalid session_id", 400);
        }
      }

      // 路由：天气查询服务 — 走 handleExecuteSkill 以保证鉴权 + 计费
      if (cleanPath === "/v1/weather") {
        const rewrite = new Request(new URL("/v1/execute/uniskill_weather", request.url).toString(), {
          method: "POST",
          headers: request.headers,
          body: request.body
        });
        return handleExecuteSkill(rewrite, env, ctx);
      }

      // 路由：网页抓取入口 — 走 handleExecuteSkill 以保证鉴权 + 计费
      if (cleanPath === "/v1/scrape") {
        const rewrite = new Request(new URL("/v1/execute/uniskill_scrape", request.url).toString(), {
          method: "POST",
          headers: request.headers,
          body: request.body
        });
        return handleExecuteSkill(rewrite, env, ctx);
      }

      if (cleanPath === "/v1/search" && method === "POST") {
        return handleExecuteSkill(request, env, ctx);
      }

      // 路由：新闻聚合语义化入口 (支持 RESTful 直接调用)
      if (cleanPath === "/v1/news" && method === "POST") {
        return handleExecuteSkill(request, env, ctx);
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

/**
 * 🔒 鉴权助手函数：验证并返回 User UID (Auth Helper: Resolve and Verify User Identity)
 * 逻辑：提取 Key → 哈希运算 → KV 查询 → 用户 UID
 */
async function authenticate(request: Request, env: Env): Promise<string | null> {
  const { extractBearerKey, isValidKeyFormat, hashKey } = await import("./utils/auth");
  const rawKey = extractBearerKey(request);
  
  if (!rawKey || !isValidKeyFormat(rawKey)) return null;
  
  const keyHash = await hashKey(rawKey);
  const { getUserUid } = await import("./utils/billing");
  
  return await getUserUid(env.UNISKILL_KV, keyHash, env);
}

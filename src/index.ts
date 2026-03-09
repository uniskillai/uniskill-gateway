// src/index.ts
// Logic: Gateway entry point using key-based authentication
// 职责：环境类型声明 + 请求路由分发 + 全局中间件（统一鉴权与平台化执行）

import { hashKey } from "./utils/auth";
import { SkillKeys } from "./utils/skill-keys";
import { executeSkill } from "./engine/executor";
import { handleProvision } from "./routes/admin";
import { handleBasicConnector } from "./routes/basic-connector";
import { errorResponse, corsHeaders, successResponse, rateLimitResponse } from "./utils/response";
import { getCredits, deductCredit, getTier } from "./utils/billing";
import { SkillParser } from "./engine/parser";
import { formatters } from "./formatters/index";
import { checkRateLimit } from "./rateLimit";

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

/**
 * Logic: Fetch skill configuration dynamically from the web service
 * 逻辑：向 Web 服务端点发起请求获取底层 YAML 配置
 */
async function fetchSkillConfig(skillId: string, env: Env) {
  const response = await fetch(`${env.WEB_DOMAIN}/api/internal/skill-config?id=${skillId}`, {
    method: "GET",
    headers: {
      "x-internal-secret": env.INTERNAL_API_SECRET
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch config for skill: ${skillId}`);
  }

  const data = await response.json() as any;
  // 逻辑：接口现在返回统一 JSON 结构，提取 config 项用于执行
  return data.config || data.implementation;
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Preflight: Handle CORS ──
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Routes Handle ──────────────────────────────────────────
    const method = request.method;
    const cleanPath = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;

    // ── Route: List All Skills (FOR FRONTEND) ──
    // 逻辑：兼容带/不带斜杠的路径
    if (method === "GET" && cleanPath === "/v1/skills") {
      console.log(`[DEBUG] GET Skills List`);

      // ── Step 1: Detect User (for Private Skills) ──
      const authHeader = request.headers.get("Authorization") || "";
      const rawKey = authHeader.replace("Bearer ", "").trim();
      let keyHash: string | undefined = undefined;
      if (rawKey.startsWith("us-")) {
        keyHash = await hashKey(rawKey);
      }

      const skills = [];

      // ── Step 2: Define Scan Categories ──
      const scanCategories = [
        { prefix: "skill:official:", source: "official" },
        { prefix: "skill:market:", source: "market" }
      ];

      if (keyHash) {
        scanCategories.unshift({ prefix: `skill:private:${keyHash}:`, source: "private" });
      }

      // ── Step 3: Execute Scans ──
      for (const cat of scanCategories) {
        const list = await env.UNISKILL_KV.list({ prefix: cat.prefix });
        for (const key of list.keys) {
          const raw = await env.UNISKILL_KV.get(key.name);
          if (raw) {
            try {
              // 🔵 核心变革：直接解析 JSON，不再依赖 Markdown 引擎
              const skill = JSON.parse(raw);
              skills.push({
                id: skill.id || key.name.split(':').pop(),
                name: skill.meta?.name || skill.name,
                description: skill.meta?.description || skill.description,
                emoji: skill.meta?.emoji,
                source: skill.source || cat.source,
                isOfficial: (skill.source || cat.source) === "official"
              });
            } catch (e) {
              console.error(`Failed to parse unified skill ${key.name}:`, e);
            }
          }
        }
      }

      return successResponse({ data: skills });
    }

    // ── Route: Get Skill Detail API (FOR FRONTEND) ──
    // 逻辑：允许 frontend 通过 GET 读取并解析 KV 中的 Markdown 原文
    if (method === "GET" && cleanPath.startsWith("/v1/skills/")) {
      const skillName = cleanPath.split("/").pop();
      console.log(`[DEBUG] GET Skill Detail: path=${path}, skillName=${skillName}`);

      if (!skillName) {
        return errorResponse("Missing skill name", 400);
      }

      // ── Step 1: Detect User (for Private Skills) ──
      const authHeader = request.headers.get("Authorization") || "";
      const rawKey = authHeader.replace("Bearer ", "").trim();
      let keyHash: string | undefined = undefined;
      if (rawKey.startsWith("us-")) {
        keyHash = await hashKey(rawKey);
      }

      // ── Step 2: Try resolve from multiple sources ──
      let skillRaw: string | null = null;
      let source: "official" | "private" | "market" = "official";

      // 1. Private (if authenticated)
      if (keyHash) {
        skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));
        if (skillRaw) source = "private";
      }

      // 2. Official
      if (!skillRaw) {
        skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
        if (skillRaw) source = "official";
      }

      // 3. Market
      if (!skillRaw) {
        skillRaw = await env.UNISKILL_KV.get(SkillKeys.market(skillName));
        if (skillRaw) source = "market";
      }

      if (!skillRaw) {
        return errorResponse("Skill Not Found", 404);
      }

      // 🔵 极致简化：直接交给优化后的 SkillParser
      const skill = SkillParser.parse(skillRaw);
      return successResponse({
        spec: skill,
        source: skill.source || source,
        is_official: (skill.source || source) === "official",
        success: true // Compatibility
      });
    }

    // ── Route: Admin Provisioning ──
    if (path === "/v1/admin/provision" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const adminSecret = authHeader.replace("Bearer ", "").trim();
      if (adminSecret !== env.ADMIN_KEY) {
        return errorResponse("Unauthorized Admin Access", 401);
      }
      return handleProvision(request, env);
    }

    // ── Route: MCP Protocol Server ──
    if (path === "/v1/mcp" && request.method === "POST") {
      // Lazy import to avoid circular dependency in top level
      const { handleMCPRequest } = await import("./routes/mcp-server");
      return handleMCPRequest(request, env, ctx);
    }

    // ── Route: Basic Connector (Transparent Proxy) ──
    if (path === "/v1/basic-connector" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const rawKey = authHeader.replace("Bearer ", "").trim();
      if (!rawKey.startsWith("us-")) {
        return errorResponse("Invalid Key Format", 401);
      }
      return handleBasicConnector(request, env, rawKey, ctx);
    }

    // ── Route: Skill Execution (Root POST or /v1/:skillName) ──
    const isRootPost = path === "/" && request.method === "POST";
    const isV1SkillPath = path.startsWith("/v1/") &&
      path !== "/v1/admin/provision" &&
      path !== "/v1/basic-connector" &&
      request.method === "POST";

    if (isRootPost || isV1SkillPath) {
      // ── Step 1: Extract 'key' from Header ──
      const authHeader = request.headers.get("Authorization") || "";
      const rawKey = authHeader.replace("Bearer ", "").trim();

      if (!rawKey.startsWith("us-")) {
        return new Response("Invalid Key Format", { status: 401, headers: corsHeaders });
      }

      const keyHash = await hashKey(rawKey);

      // ── Step 2: Payload Parsing ──
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        // Allowed to be empty if skillName is in path
      }

      // Logic: Resolve skillName from path or body
      let skillName = body.skillName;
      if (isV1SkillPath) {
        skillName = path.split("/")[2] || skillName;
      }

      if (!skillName) {
        return new Response("Missing skillName", { status: 400, headers: corsHeaders });
      }

      const params = body.params || body;

      try {
        // ── Step 3: Resolve Skill Implementation (Dynamic or KV) ──
        let implementation: any;

        // 🟢 关键步骤：执行前，先尝试从 Web 端拉取最新配置
        try {
          console.log(`[DEBUG] Attempting dynamic config fetch for: ${skillName}`);
          implementation = await fetchSkillConfig(skillName, env);
        } catch (e) {
          console.warn(`[DEBUG] Dynamic config fetch failed, falling back to KV:`, e);

          // Fallback: Resolve Skill from KV
          let skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));
          if (!skillRaw) {
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
          }
          if (!skillRaw && !skillName.startsWith("uniskill_")) {
            const normalizedName = `uniskill_${skillName}`;
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedName));
            if (skillRaw) skillName = normalizedName;
          }

          if (!skillRaw) return new Response(`Skill [${skillName}] Not Found`, { status: 404, headers: corsHeaders });

          // 🔵 极致简化：统一调用 SkillParser
          const spec = SkillParser.parse(skillRaw);
          implementation = spec.implementation;
        }

        // ── Step 4: Rate Limit Check ──
        const userTier = await getTier(env.UNISKILL_KV, keyHash);
        const rlResult = await checkRateLimit(keyHash, userTier, env);

        if (!rlResult.isAllowed) {
          return rateLimitResponse(rlResult.limit, rlResult.remaining);
        }

        // ── Step 5: Billing Check ──
        let currentCredits = await getCredits(env.UNISKILL_KV, keyHash);
        if (currentCredits === -1) currentCredits = 0;

        let skillCost = 1;
        if (skillName === "uniskill_search" || skillName === "uniskill_news" || skillName === "news") {
          skillCost = 10;
        } else if (skillName === "uniskill_scrape" || skillName === "scrape") {
          skillCost = 20;
        }

        if (currentCredits < skillCost) {
          return new Response(`Insufficient Credits. This skill costs ${skillCost}, but you have ${currentCredits}.`, { status: 402, headers: corsHeaders });
        }

        // ── Step 5: Execution ──
        const rawData = await executeSkill(implementation, params, env);
        let finalData = rawData;

        // 🔴 核心逻辑：检查该技能是否配置了 plugin_hook
        const hookName = implementation.plugin_hook;
        if (hookName && (formatters as any)[hookName]) {
          // 逻辑：如果找到了对应的清洗器，就把脏数据扔进去“洗”一遍
          finalData = (formatters as any)[hookName](rawData);
        }

        // ── Step 6: Post-Execution Billing ──
        ctx.waitUntil(deductCredit(
          env.UNISKILL_KV,
          keyHash,
          currentCredits,
          skillCost,
          env.VERCEL_WEBHOOK_URL,
          env.ADMIN_KEY,
          skillName
        ));

        return new Response(typeof finalData === 'string' ? finalData : JSON.stringify(finalData), {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "X-RateLimit-Limit": rlResult.limit.toString(),
            "X-RateLimit-Remaining": rlResult.remaining.toString(),
          }
        });

      } catch (error: any) {
        console.error(`[Execution Flow Error]`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // Fallback for undefined routes
    return errorResponse("Not Found", 404);
  }
};

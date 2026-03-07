// src/index.ts
// Logic: Gateway entry point using key-based authentication
// 职责：环境类型声明 + 请求路由分发 + 全局中间件（统一鉴权与平台化执行）

import { hashKey } from "./utils/auth";
import { SkillKeys } from "./utils/skill-keys";
import { executeSkill } from "./engine/executor";
import { handleProvision } from "./routes/admin";
import { handleBasicConnector } from "./routes/basic-connector";
import { errorResponse, corsHeaders, successResponse } from "./utils/response";
import { getCredits, deductCredit } from "./utils/billing";
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

      // 逻辑：列出所有以 'skill:' 开头的 KV 键（包括官方和私有）
      // 注意：此简单实现假设官方技能都在 KV 中
      const list = await env.UNISKILL_KV.list({ prefix: "skill:official:" });
      const skills = [];

      for (const key of list.keys) {
        const raw = await env.UNISKILL_KV.get(key.name);
        if (raw) {
          try {
            const spec = SkillParser.parse(raw);
            skills.push({
              id: key.name.replace("skill:official:", ""),
              name: spec.name,
              description: spec.description,
              isOfficial: true
            });
          } catch (e) {
            console.error(`Failed to parse skill ${key.name}:`, e);
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

      // 逻辑：优先从官方库获取
      let skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
      console.log(`[DEBUG] Skill Raw Found: ${!!skillRaw}`);
      let isOfficial = true;

      if (!skillRaw) {
        // TODO: 未来可在此扩展用户私有技能的查询逻辑
        return errorResponse("Skill Not Found", 404);
      }

      // 逻辑：调用引擎 Parser 将 Markdown 解析为结构化 JSON
      const parsedSpec = SkillParser.parse(skillRaw);

      return new Response(JSON.stringify({
        success: true,
        spec: parsedSpec,
        is_official: isOfficial
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
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

      const params = body.params || body; // Fallback: if no 'params' key, treat body as params

      // ── Step 3: Resolve Skill with Intelligence ──
      // 1. Try Private Vault
      let skillRaw = await env.UNISKILL_KV.get(SkillKeys.private(keyHash, skillName));

      // 2. Try Official (as-is)
      if (!skillRaw) {
        skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(skillName));
      }

      // 3. Try Official with 'uniskill_' prefix (Normalization for /v1/search etc)
      if (!skillRaw && !skillName.startsWith("uniskill_")) {
        const normalizedName = `uniskill_${skillName}`;
        skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedName));
        if (skillRaw) skillName = normalizedName; // Update skillName for billing
      }

      if (!skillRaw) return new Response(`Skill [${skillName}] Not Found`, { status: 404, headers: corsHeaders });

      // ── Step 4: Billing Check ──
      let currentCredits = await getCredits(env.UNISKILL_KV, keyHash);
      if (currentCredits === -1) currentCredits = 0; // Fallback for safety

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
      const executionResult = await executeSkill(skillRaw, params, env);

      // ── Step 6: Post-Execution Billing ──
      // 逻辑：使用统一计费工具，确保 KV 与 Supabase 同步更新
      ctx.waitUntil(deductCredit(
        env.UNISKILL_KV,
        keyHash,
        currentCredits,
        skillCost,
        env.VERCEL_WEBHOOK_URL,
        env.ADMIN_KEY,
        skillName
      ));

      return new Response(executionResult, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }

    // Fallback for undefined routes
    return errorResponse("Not Found", 404);
  }
};

// ============================================================
// src/index.ts — UniSkill Gateway Entry Point
// 职责：环境类型声明 + 请求路由分发 + 全局中间件（鉴权、限流、CORS）
// ============================================================

import { extractBearerKey, isValidKeyFormat, hashKey } from "./utils/auth.ts";
import { errorResponse } from "./utils/response.ts";
import { handleSearch } from "./routes/search.ts";
import { handleScrape } from "./routes/scrape.ts";
import { handleNews } from "./routes/news.ts";
import { handleSocial } from "./routes/social.ts";
import { handleBasicConnector } from "./routes/basic-connector.ts";
import { handleProvision } from "./routes/admin.ts";
import { checkRateLimit } from "./rateLimit.ts";
import { fetchUserDataFromDB } from "./db.ts";
import { runDiagnosticTest } from "./test-connection.ts";

// ── 环境变量类型声明 ──────────────────────────────────────────
export interface Env {
  UNISKILL_KV: KVNamespace;
  TAVILY_API_KEY: string;
  JINA_API_KEY: string;
  ADMIN_KEY: string;
  VERCEL_WEBHOOK_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

// ── 静态配置 ───────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── 辅助函数：处理技能清单 ─────────────────────────────────────
async function handleGetSkills(): Promise<Response> {
  const skillManifest = {
    version: "v1",
    status: "stable",
    tools: [
      {
        name: "uniskill_search",
        description: "Real-time web search for news, stocks, and trends. Consumes 10 credits.",
        endpoint: "/v1/search",
        parameters: { query: "string" },
      },
      {
        name: "uniskill_scrape",
        description: "Extract clean Markdown from any website URL. Consumes 20 credits.",
        endpoint: "/v1/scrape",
        parameters: { url: "string" },
      },
      {
        name: "uniskill_news",
        description: "Fetch the latest news articles on any topic. Consumes 10 credits.",
        endpoint: "/v1/news",
        parameters: { query: "string" },
      },
      {
        name: "uniskill_social",
        description: "Search social media trends and discussions. Consumes 30 credits. (Coming Soon)",
        endpoint: "/v1/social",
        parameters: { query: "string" },
      },
      {
        name: "uniskill_connect",
        description: "Transparent proxy connector for any API. Consumes 1 credit.",
        endpoint: "/v1/connect",
        parameters: { url: "string", method: "string", headers: "object", data: "object" },
      },
    ],
  };

  return new Response(JSON.stringify(skillManifest, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── 用户请求处理器（包含鉴权与限流） ─────────────────────────────
async function handleUserRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string
): Promise<Response> {
  // 1. 全局鉴权
  const key = extractBearerKey(request);
  if (!key || !isValidKeyFormat(key)) {
    return errorResponse("Missing or invalid Authorization header. Expected: Bearer us-xxxx", 401);
  }

  // 2. 积分与档位检查 (KV 优先，DB 兜底并自动补全)
  const keyHash = await hashKey(key);
  let creditsRaw = await env.UNISKILL_KV.get(keyHash);
  let userTier = await env.UNISKILL_KV.get(`tier:${keyHash}`);

  // 如果 KV 中缺失账户信息 (例如 Vercel 同步延迟)，则触发 DB 兜底同步
  if (creditsRaw === null || !userTier) {
    console.log(`[Auto-Provision] KV miss for ${keyHash.slice(-6)}. Fetching from DB...`);
    const dbData = await fetchUserDataFromDB(keyHash, env);

    // 如果数据库也查不到，说明 key 彻底无效
    if (dbData.credits === 0 && dbData.tier === "FREE") {
      // 这里做一个额外的校验，确认是否真的完全没数据
      // (取决于 fetchUserDataFromDB 的 fallback 实现)
    }

    userTier = dbData.tier;
    creditsRaw = dbData.credits.toString();

    // 自动补全 KV 缓存，避免后续请求再次穿透 DB，直接 await 防止路由取到过时数据
    await Promise.all([
      env.UNISKILL_KV.put(keyHash, creditsRaw),
      env.UNISKILL_KV.put(`tier:${keyHash}`, userTier, { expirationTtl: 3600 })
    ]);
  }



  const rateLimit = await checkRateLimit(key, userTier, env);
  if (!rateLimit.isAllowed) {
    return new Response(JSON.stringify({
      error: "Too Many Requests",
      message: `Your current tier (${userTier}) is limited to ${rateLimit.limit} RPM.`,
      _uniskill: {
        current_usage: rateLimit.currentUsage,
        limit: rateLimit.limit,
        retry_after: 60 - (Math.floor(Date.now() / 1000) % 60)
      }
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "X-RateLimit-Limit": rateLimit.limit.toString() }
    });
  }

  // 3. 仅允许 POST 方法进入技能路由
  if (request.method !== "POST") {
    return errorResponse(`Method ${request.method} not allowed. Use POST.`, 405);
  }

  // 4. 路由分发
  let response: Response;
  switch (pathname) {
    case "/v1/verify":
      // 如果执行到这里，说明鉴权和限流均已通过
      response = new Response(JSON.stringify({
        success: true,
        message: "API Key is valid",
        tier: userTier
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      break;
    case "/v1/search":
      response = await handleSearch(request, env, key, ctx);
      break;
    case "/v1/scrape":
      response = await handleScrape(request, env, key, ctx);
      break;
    case "/v1/news":
      response = await handleNews(request, env, key, ctx);
      break;
    case "/v1/social":
      response = await handleSocial(request, env, key, ctx);
      break;
    case "/v1/connect":
      response = await handleBasicConnector(request, env, key, ctx);
      break;
    default:
      return errorResponse(`Route ${pathname} not found.`, 404);
  }

  // 5. 注入限流状态头
  response.headers.set("X-RateLimit-Limit", rateLimit.limit.toString());
  response.headers.set("X-RateLimit-Remaining", rateLimit.remaining.toString());
  // 附加 CORS 头以便 Web 端调用
  Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v));

  return response;
}

// ── 主 Fetch 处理器 ───────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. 处理 CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // 2. 核心路由表
      switch (pathname) {
        // --- 系统与工具路由 ---
        case "/":
        case "/health":
          return new Response(JSON.stringify({ status: "operational", service: "UniSkill Gateway" }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
          });

        case "/v1/skills":
          return await handleGetSkills();

        case "/v1/diag":
          const report = await runDiagnosticTest(env);
          return new Response(JSON.stringify(report, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS }
          });

        // --- Admin 管理路由 ---
        case "/admin/provision":
        case "/v1/admin/provision":
          const authHeader = request.headers.get("Authorization");
          if (authHeader !== `Bearer ${env.ADMIN_KEY}`) {
            return new Response("Unauthorized Admin", { status: 401 });
          }
          if (request.method !== "POST") {
            return errorResponse(`Method ${request.method} not allowed. Use POST.`, 405);
          }
          return handleProvision(request, env);

        // --- 用户技能路由 (进入流水线：鉴权 -> 限流 -> 执行) ---
        default:
          if (pathname.startsWith("/v1/")) {
            return await handleUserRequest(request, env, ctx, pathname);
          }
          return errorResponse(`Route ${pathname} not found.`, 404);
      }
    } catch (error: any) {
      // 3. 全局错误捕获
      console.error(`Gateway Error [${pathname}]:`, error.message);
      return new Response(
        JSON.stringify({
          error: "Internal Gateway Error",
          message: error.message
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        }
      );
    }
  },
};

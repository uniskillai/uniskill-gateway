// ============================================================
// src/index.ts — UniSkill Gateway Entry Point
// 职责：环境类型声明 + 请求路由分发（保持精简，业务逻辑下沉各模块）
// ============================================================

import { extractBearerToken, isValidTokenFormat } from "./utils/auth.ts";
import { errorResponse } from "./utils/response.ts";
import { handleSearch } from "./routes/search.ts";
import { handleScrape } from "./routes/scrape.ts";
import { handleNews } from "./routes/news.ts";
import { handleSocial } from "./routes/social.ts";
import { handleProvision } from "./routes/admin.ts";
import { checkRateLimit } from "./utils/rate-limit.ts";
import { hashToken } from "./utils/auth.ts";
import { fetchUserTier } from "./db.ts";

// ── 环境变量类型声明（与 wrangler.toml bindings 一一对应）──
export interface Env {
  /** KV 命名空间：存储 SHA-256(token) → 信用额度 映射 */
  UNISKILL_KV: KVNamespace;
  /** Tavily API Key，通过 Cloudflare Secret 注入，不出现在源码中 */
  TAVILY_API_KEY: string;
  /** Jina AI API Key，通过 Cloudflare Secret 注入，供 /v1/scrape 技能使用 */
  JINA_API_KEY: string;
  /** Admin 共享密钥，通过 Cloudflare Secret 注入，供 Vercel 后端调用 */
  ADMIN_KEY: string;
  /** Vercel Webhook URL，扣分后用于将新余额同步写回 Supabase */
  VERCEL_WEBHOOK_URL: string;
  /** Supabase 项目 URL */
  SUPABASE_URL: string;
  /** Supabase 匿名 Key */
  SUPABASE_ANON_KEY: string;
}

// ── 路由表：路径 → 对应的技能处理函数 ──────────────────────
// 每条路由均为独立的工具提供程序（Tool Provider）端点
// 新增技能时只需：① 创建 routes/xxx.ts ② 在此追加一行
const SKILL_ROUTES: Record<
  string,
  (req: Request, env: Env, token: string, ctx: ExecutionContext) => Promise<Response>
> = {
  "/v1/search": handleSearch,   // 全网搜索（Tavily Search API）
  "/v1/scrape": handleScrape,   // 网页内容抓取（Jina AI Reader）
  "/v1/news": handleNews,     // 新闻搜索（Tavily News 模式）
  "/v1/social": handleSocial,   // 社交数据搜索（Coming Soon）
};

// ── 动态技能清单端点：返回当前版本所有可用技能的元数据 ──────
// 无需鉴权，供 AI Agent / 客户端自动发现可用工具
async function handleGetSkills(_request: Request, _env: Env): Promise<Response> {
  // 逻辑：定义当前稳定版 (v1) 的所有工具描述
  const skillManifest = {
    version: "v1",
    status: "stable",
    tools: [
      {
        name: "uniskill_search",
        description: "Real-time web search for news, stocks, and trends.",
        endpoint: "https://uniskill-gateway.geekpro798.workers.dev/v1/search",
        parameters: { query: "string" },
      },
      {
        name: "uniskill_scrape",
        description: "Extract clean Markdown from any website URL.",
        endpoint: "https://uniskill-gateway.geekpro798.workers.dev/v1/scrape",
        parameters: { url: "string" },
      },
      {
        name: "uniskill_news",
        description: "Fetch the latest news articles on any topic.",
        endpoint: "https://uniskill-gateway.geekpro798.workers.dev/v1/news",
        parameters: { query: "string" },
      },
      {
        name: "uniskill_social",
        description: "Search social media trends and discussions. (Coming Soon)",
        endpoint: "https://uniskill-gateway.geekpro798.workers.dev/v1/social",
        parameters: { query: "string" },
      },
    ],
  };

  return new Response(JSON.stringify(skillManifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // 允许跨域调用，供任意 Agent 客户端使用
    },
  });
}

// ── 用户请求处理器（技能执行流水线）─────────────────────────
async function handleUserRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { method, url } = request;
  const { pathname } = new URL(url);

  // ── 1. 全局鉴权：提取并校验 Bearer token 格式 ────────────
  // 格式要求：Authorization: Bearer us-xxxx
  const token = extractBearerToken(request);
  if (!token || !isValidTokenFormat(token)) {
    return errorResponse(
      "Missing or invalid Authorization header. Expected: Bearer us-xxxx",
      401
    );
  }

  // ── 1.5. 速率限制检查 (Rate Limiting) ────────────────────
  const tokenHash = await hashToken(token);

  // 先尝试从 KV 获取档位，KV 没有则查 DB 并回写 KV（缓存 1 小时）
  let userTier = await env.UNISKILL_KV.get(`tier:${tokenHash}`);

  if (!userTier) {
    userTier = await fetchUserTier(token, env);
    // 缓存到 KV，减少对 Supabase 的直接并发查询
    ctx.waitUntil(env.UNISKILL_KV.put(`tier:${tokenHash}`, userTier, { expirationTtl: 3600 }));
  }

  const rateLimit = await checkRateLimit(tokenHash, userTier, env.UNISKILL_KV);

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
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": rateLimit.limit.toString(),
        "X-RateLimit-Remaining": "0"
      }
    });
  }

  // ── 2. 仅允许 POST 方法进入技能路由 ─────────────────────
  if (method !== "POST") {
    return errorResponse(`Method ${method} not allowed. Use POST.`, 405);
  }

  // ── 3. 路由分发：匹配对应的技能处理函数 ──────────────────
  const handler = SKILL_ROUTES[pathname];
  if (!handler) {
    return errorResponse(
      `Route ${pathname} not found. Available skill endpoints: ${Object.keys(SKILL_ROUTES).join(", ")}`,
      404
    );
  }

  // ── 4. 执行对应的技能处理器 ──────────────────────────────
  // 每个处理器内部负责：SHA-256 哈希 → KV 信用查询 → 调用外部 API → 扣费 → 响应
  const response = await handler(request, env, token, ctx);

  // 注入限流状态头
  response.headers.set("X-RateLimit-Limit", rateLimit.limit.toString());
  response.headers.set("X-RateLimit-Remaining", rateLimit.remaining.toString());

  return response;
}

// ── 主 Fetch 处理器 ───────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 0. 健康检查：无需鉴权，供 uptime 监控 / 负载均衡器探针使用
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "UniSkill Gateway",
          available_skills: Object.keys(SKILL_ROUTES),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 0.5. 动态技能清单：无需鉴权，供 AI Agent 自动发现可用工具
    if (url.pathname === "/v1/skills") {
      return handleGetSkills(request, env);
    }

    // 1. Admin 区域：供 Vercel 等受信任后端同步用户积分
    //    鉴权方式：Authorization: Bearer {ADMIN_KEY}（注意与用户 Token 区分）
    if (url.pathname === "/admin/provision" || url.pathname === "/v1/admin/provision") {
      const authHeader = request.headers.get("Authorization");
      // 校验是否携带了正确的 ADMIN_KEY（通过 Cloudflare Secret 注入）
      if (authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return new Response("Unauthorized Admin", { status: 401 });
      }
      if (request.method !== "POST") {
        return errorResponse(`Method ${request.method} not allowed. Use POST.`, 405);
      }
      return handleProvision(request, env);
    }

    // 2. 用户技能区域：执行工具提供程序流水线
    return handleUserRequest(request, env, ctx);
  },
};

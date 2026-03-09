// uniskill-gateway/src/routes/scrape.ts
// Logic: Bulletproof Web Scraper - accepts raw text to prevent JSON parse errors

import type { Env } from "../index";
import { errorResponse } from "../utils/response";

export async function handleScrape(request: Request, _env: Env): Promise<Response> {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        let targetUrl = "";

        // 兼容 POST body 和 GET query
        if (request.method === "POST") {
            const body: any = await request.json();
            // 兼容 mcporter 传参可能是 url 也可能是 target_url
            targetUrl = body.url || body.target_url || body.query;
        } else if (request.method === "GET") {
            const url = new URL(request.url);
            targetUrl = url.searchParams.get("url") || url.searchParams.get("target_url") || "";
        }

        if (!targetUrl) {
            return errorResponse("Missing 'url' parameter in request.", 400);
        }

        console.log(`[Scrape] Fetching Markdown for: ${targetUrl}`);

        // 核心魔法：带上您的专属 Key，但不带 Accept: application/json，逼它吐 Markdown
        const jinaUrl = `https://r.jina.ai/${targetUrl}`;
        const response = await fetch(jinaUrl, {
            headers: {
                "Authorization": `Bearer ${env.JINA_API_KEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`Upstream Scraper returned HTTP ${response.status}`);
        }

        // 🛡️ 防弹核心：绝对不要用 .json()，直接用 .text() 暴力读取！
        const rawMarkdown = await response.text();

        // 🛡️ 防爆盾：截断超长网页，最大只取 8000 字符，防止把大模型的脑容量撑爆
        const safeContent = rawMarkdown.length > 8000
            ? rawMarkdown.substring(0, 8000) + "\n\n...[Content truncated for length]..."
            : rawMarkdown;

        const finalResult = {
            title: `Scraped Content from ${targetUrl}`,
            source: targetUrl,
            content: safeContent
        };

        return new Response(JSON.stringify({ status: "success", data: finalResult }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });

    } catch (error: any) {
        console.error("[Scrape] Error:", error.message);
        // 如果出错，依然返回规整的 JSON，绝对不让客户端看到纯文本的报错页
        return new Response(JSON.stringify({
            status: "error",
            error: `Failed to scrape URL: ${error.message}`
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }
}

// src/engine/executor.ts
// Logic: The central execution engine for UniSkill

// import { SkillParser } from "./parser"; // Unused after refactor
// import { PluginFormatter } from "../plugins/formatter";
// import { PluginRegistryManager } from "../formatters/index"; // Unused after refactor

// Logic: Define Cloudflare environment variables
// 逻辑：定义 Cloudflare 的环境变量接口
export interface Env {
    TAVILY_API_KEY: string;
    JINA_API_KEY: string;
    NEWS_API_KEY: string;
    // ... 其他系统级环境变量
}

export async function executeSkill(impl: any, params: any, env: Env) {
    /**
     * Logic: Use the provided implementation object directly
     * 逻辑：直接使用传入的 implementation 配置对象（支持动态从 Web 获取）
     */

    if (!impl.endpoint) {
        return JSON.stringify({ error: "Missing endpoint in skill implementation." });
    }

    // ── Step 1: Authentication & Header Injection ──
    // 逻辑：构建请求头，并动态注入系统级 API Key
    let headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    if (impl.api_key) {
        if (impl.api_key === "{{TAVILY_API_KEY}}") {
            headers["Authorization"] = `Bearer ${env.TAVILY_API_KEY}`;
        } else if (impl.api_key === "{{JINA_API_KEY}}") {
            headers["Authorization"] = `Bearer ${env.JINA_API_KEY}`;
        } else if (impl.api_key === "{{NEWS_API_KEY}}") {
            headers["Authorization"] = `Bearer ${env.NEWS_API_KEY}`;
        } else {
            // 逻辑：处理用户私有技能自带的常规 Key
            headers["Authorization"] = `Bearer ${impl.api_key}`;
        }
    }

    // ── Step 2: Request Execution ──
    // 🚦 核心重构：HTTP 方法智能分流器 (Method Router)
    let targetUrl = impl.endpoint;
    const method = (impl.method || "POST").toUpperCase();

    const fetchOptions: RequestInit = {
        method: method,
        headers: headers
    };

    try {
        if (method === "GET") {
            // GET 请求绝对不能有 body！将参数转化为 URL 查询字符串
            if (params && Object.keys(params).length > 0) {
                const queryParams = new URLSearchParams(params as Record<string, string>).toString();
                targetUrl += targetUrl.includes('?') ? `&${queryParams}` : `?${queryParams}`;
            }
        } else {
            // POST / PUT / PATCH 请求，参数放进 body
            if (params) {
                fetchOptions.body = JSON.stringify(params);
            }
        }

        console.log(`[Executor] Calling upstream: ${method} ${targetUrl}`);

        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Upstream API returned ${response.status}: ${errorText}`);
        }

        return await response.json();

    } catch (error: any) {
        console.error(`[Executor] Network Error:`, error);
        throw error;
    }
}

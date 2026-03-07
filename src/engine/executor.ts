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
    // 逻辑：发起实际的网关请求，并增加 try-catch 容错处理
    try {
        const response = await fetch(impl.endpoint, {
            method: impl.method || 'POST',
            headers: headers,
            // 逻辑：将 AI 传来的参数映射到请求体
            body: JSON.stringify(params)
        });

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

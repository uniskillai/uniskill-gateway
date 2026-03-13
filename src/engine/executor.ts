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
    MAPBOX_API_KEY: string;
    // ... 其他系统级环境变量
}

export async function executeSkill(impl: any, params: any, env: Env) {
    if (!impl.endpoint) {
        return JSON.stringify({ error: "Missing endpoint in skill implementation." });
    }

    // ── Pre-process: Variable Substitution in Endpoint ──
    // 逻辑：将 endpoint 中的 {{key|default}} 占位符替换为 params 中的实际值
    let targetUrl = impl.endpoint;
    const consumedParams = new Set<string>();

    const placeholderRegex = /\{\{([a-zA-Z0-9_-]+)(?:\|([^}]+))?\}\}/g;
    targetUrl = targetUrl.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
        const val = params[key] !== undefined ? params[key] : defaultValue;
        if (val === undefined) return match; // Keep the placeholder if no value/default
        consumedParams.add(key);
        // Encode for URL safety
        return encodeURIComponent(String(val));
    });

    // ── Step 1: Authentication & Header Injection ──
    let headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    // Merge custom headers from implementation YAML
    if (impl.headers) {
        headers = { ...headers, ...impl.headers };
    }

    if (impl.api_key) {
        if (impl.api_key === "{{TAVILY_API_KEY}}") {
            headers["Authorization"] = `Bearer ${env.TAVILY_API_KEY}`;
        } else if (impl.api_key === "{{JINA_API_KEY}}") {
            headers["Authorization"] = `Bearer ${env.JINA_API_KEY}`;
        } else {
            headers["Authorization"] = `Bearer ${impl.api_key}`;
        }
    }

    // ── Step 2: Request Execution ──
    const method = (impl.method || "POST").toUpperCase();

    const fetchOptions: RequestInit = {
        method: method,
        headers: headers
    };

    try {
        if (method === "GET") {
            // GET 请求：排除掉已经被 endpoint 中间占位符消费掉的参数
            const remainingParams: Record<string, string> = {};
            for (const key in params) {
                if (!consumedParams.has(key)) {
                    remainingParams[key] = String(params[key]);
                }
            }

            if (Object.keys(remainingParams).length > 0) {
                const queryParams = new URLSearchParams(remainingParams).toString();
                targetUrl += targetUrl.includes('?') ? `&${queryParams}` : `?${queryParams}`;
            }
        } else {
            // POST / PUT / PATCH：发送剩余参数
            if (params) {
                fetchOptions.body = JSON.stringify(params);
            }
        }

        console.log(`[Executor] Calling upstream: ${method} ${targetUrl}`);

        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `Upstream API returned ${response.status}`;
            
            // Logic: Distinguish between different error types for better UX
            if (response.status === 429) {
                errorMessage = "Upstream provider rate limit exceeded. Please try again later.";
            } else if (response.status === 404) {
                errorMessage = "The requested resource could not be found on the upstream provider.";
            } else if (response.status >= 500) {
                errorMessage = "The upstream provider is currently experiencing issues.";
            } else {
                try {
                    const parsedError = JSON.parse(errorText);
                    errorMessage = parsedError.message || parsedError.error || errorMessage;
                } catch (e) {
                    errorMessage = errorText || errorMessage;
                }
            }

            throw new Error(errorMessage);
        }

        return await response.json();

    } catch (error: any) {
        console.error(`[Executor] Error: ${error.message}`);
        throw error;
    }
}

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
    // ── Pre-process: Resolve technical fields ──
    const endpoint = impl.endpoint || impl.url;
    const method = (impl.method || impl.request?.method || "POST").toUpperCase();
    
    if (!endpoint) {
        return { error: "Missing endpoint or url in skill implementation." };
    }

    let targetUrl = endpoint;
    const consumedParams = new Set<string>();

    // 🌟 增强型变量处理器 (Enhanced variable resolver)
    const resolveValue = (key: string, defaultValue?: string) => {
        if (key.startsWith("SECRETS.")) {
            const secretName = key.split(".")[1];
            if (secretName === "TAVILY_API_KEY") return env.TAVILY_API_KEY;
            if (secretName === "JINA_API_KEY") return env.JINA_API_KEY;
            if (secretName === "MAPBOX_API_KEY") return env.MAPBOX_API_KEY;
            return defaultValue || `[SECRET_${secretName}_NOT_FOUND]`;
        }
        const val = params[key] !== undefined ? params[key] : defaultValue;
        if (val !== undefined) consumedParams.add(key);
        return val;
    };

    const placeholderRegex = /\{\{([a-zA-Z0-9._-]+)(?:\|([^}]+))?\}\}/g;

    // ── Step 1: Resolve URL ──
    targetUrl = targetUrl.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
        const val = resolveValue(key, defaultValue);
        return val !== undefined ? encodeURIComponent(String(val)) : match;
    });

    // ── Step 2: Authentication & Header Injection ──
    let headers: Record<string, string> = {
        "Content-Type": "application/json"
    };

    // Merge and Resolve Headers
    const rawHeaders = { ...(impl.headers || {}), ...(impl.request?.headers || {}) };
    for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === 'string') {
            headers[k] = v.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
                const val = resolveValue(key, defaultValue);
                return val !== undefined ? String(val) : match;
            });
        }
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

    // ── Step 3: Request Execution ──
    const fetchOptions: RequestInit = {
        method: method,
        headers: headers
    };

    try {
        if (method === "GET") {
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
            // Priority: Explicit body template > All params
            const bodyTemplate = impl.body || impl.request?.body;
            if (bodyTemplate) {
                // Logic: If there is a template, we just pass it (assuming placeholders already covered)
                // BUT for now, most skills just dump params. 
                // Let's stick to the Dumping params for safety unless it's a specific format.
                fetchOptions.body = JSON.stringify(params);
            } else if (params) {
                fetchOptions.body = JSON.stringify(params);
            }
        }

        console.log(`[Executor] Calling upstream: ${method} ${targetUrl}`);

        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `Upstream API returned ${response.status}`;
            
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

        const rawData = await response.json();
        
        // ── Step 4: Response Mapping ──
        const mapping = impl.response_mapping || impl.response?.output_mapping;
        if (mapping && typeof mapping === 'object') {
            const mappedData: Record<string, any> = {};
            let hasMapping = false;

            for (const [k, v] of Object.entries(mapping)) {
                if (v && typeof v === 'string') {
                    const extracted = evaluateJsonPath(rawData, v);
                    mappedData[k] = extracted;
                    hasMapping = true;
                }
            }
            return hasMapping ? mappedData : rawData;
        }

        return rawData;

    } catch (error: any) {
        console.error(`[Executor] Error: ${error.message}`);
        throw error;
    }
}

/**
 * 🌟 轻量级 JSON 寻址引擎 (Lightweight jq-style path evaluator)
 * 例如把 '.current_condition[0].temp_C' 转化为 obj['current_condition'][0]['temp_C']
 */
function evaluateJsonPath(obj: any, path: string) {
    if (!path) return undefined;
    const cleanPath = path.trim().startsWith('.') ? path.trim().slice(1) : path.trim();
    const parts = cleanPath.split(/[\.\[\]]+/).filter(Boolean);
    let current = obj;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        current = current[part];
    }
    return current;
}

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

export async function executeSkill(impl: any, params: any, env: Env, userSecrets: Record<string, string> = {}, isOfficial: boolean = false) {
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
            
            // 🔐 身份强制原则：仅限用户配置的私有 Key (User Secret Only)
            // 逻辑：如果用户未配置该 Key，则不回退到系统全局 Key，以保障用户隐私和厂商成本。
            if (userSecrets[secretName]) return userSecrets[secretName];
            
            return defaultValue || `[MISSING_USER_SECRET_${secretName}]`;
        }
        const val = params[key] !== undefined ? params[key] : defaultValue;
        if (val !== undefined) consumedParams.add(key);
        return val;
    };

    const placeholderRegex = /\{\{([a-zA-Z0-9._-]+)(?:\|([^}]+))?\}\}/g;

    // ── Pre-Resolution: Check for mandatory secrets ──
    // 逻辑：在正式渲染前预检 SECRETS 占位符，如果缺失则直接熔断 (Fail Fast)
    const missingSecrets = new Set<string>();
    const fullText = targetUrl + 
                    JSON.stringify(impl.headers || {}) + 
                    JSON.stringify(impl.request?.headers || {}) +
                    (impl.api_key || ""); // 🌟 包含 api_key 预检 (Include api_key in pre-check)

    const matches = fullText.matchAll(placeholderRegex);
    for (const match of matches) {
        const key = match[1];
        if (key.startsWith("SECRETS.")) {
            const secretName = key.split(".")[1];
            if (!userSecrets[secretName]) {
                missingSecrets.add(secretName);
            }
        }
    }

    if (missingSecrets.size > 0) {
        return { 
            success: false, 
            error: `Missing required private secrets: ${Array.from(missingSecrets).join(", ")}. Please configure them in your UniSkill dashboard.` 
        };
    }

    // ── Step 1: Resolve URL ──
    targetUrl = targetUrl.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
        const val = resolveValue(key, defaultValue);
        return val !== undefined ? encodeURIComponent(String(val)) : match;
    });

    // ── Step 2: Authentication & Header Injection (with Browser Spoofing) ──
    // 🌟 核心改进：外交级默认 Headers (Disguise as a standard desk browser to avoid 502/403 blocks)
    let headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'X-UniSkill-Trace-ID': crypto.randomUUID()
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
        let finalApiKey = impl.api_key;
        
        // 🌟 优先级原则：用户私有 Key > 系统全局 Key (User Secret > Global Env)
        // 🔒 安全隔离：非官方技能严禁回退到系统 Key (No fallback for private skills)
        if (impl.api_key === "{{TAVILY_API_KEY}}") {
            if (isOfficial) {
                finalApiKey = userSecrets["TAVILY_API_KEY"] || env.TAVILY_API_KEY;
            } else {
                if (!userSecrets["TAVILY_API_KEY"]) {
                    throw new Error("Private search tool requires your personal TAVILY_API_KEY. Please configure it in your UniSkill Secrets.");
                }
                finalApiKey = userSecrets["TAVILY_API_KEY"];
            }
        } else if (impl.api_key === "{{JINA_API_KEY}}") {
            if (isOfficial) {
                finalApiKey = userSecrets["JINA_API_KEY"] || env.JINA_API_KEY;
            } else {
                if (!userSecrets["JINA_API_KEY"]) {
                    throw new Error("Private scraping tool requires your personal JINA_API_KEY. Please configure it in your UniSkill Secrets.");
                }
                finalApiKey = userSecrets["JINA_API_KEY"];
            }
        } else {
            // 通用占位符支持 (Generic placeholder support)
            finalApiKey = finalApiKey.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
                const val = resolveValue(key, defaultValue);
                return val !== undefined ? String(val) : match;
            });
        }
        
        headers["Authorization"] = `Bearer ${finalApiKey}`;
    }

    // ── Step 3: Request Execution (with Timeout) ──
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 🌟 10s 硬超时 (10s hard timeout)

    const fetchOptions: RequestInit = {
        method: method,
        headers: headers,
        signal: controller.signal as any
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
            // POST/PATCH/PUT: build body from request.body template (with placeholder expansion) or fall back to raw params
            const bodyTemplate = impl.request?.body || impl.body || impl.payload;
            if (bodyTemplate && typeof bodyTemplate === 'object') {
                // Recursively resolve placeholders in body template values. Skip if unresolved.
                const resolvedBody: Record<string, any> = {};
                for (const [k, v] of Object.entries(bodyTemplate)) {
                    if (typeof v === 'string') {
                        let unresolved = false;
                        const resolved = v.replace(placeholderRegex, (match: string, key: string, defaultValue: string) => {
                            const val = resolveValue(key, defaultValue);
                            if (val === undefined) { unresolved = true; return match; }
                            return String(val);
                        });
                        // Only include in body if placeholder was fully resolved
                        if (!unresolved) resolvedBody[k] = resolved;
                    } else {
                        resolvedBody[k] = v;
                    }
                }
                fetchOptions.body = JSON.stringify(resolvedBody);
            } else if (params && Object.keys(params).length > 0) {
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
                // 🌟 核心防御：上游 HTML 报错页拦截 (Detect HTML error pages)
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('text/html')) {
                    errorMessage = `Upstream Error (HTTP ${response.status}): Provider returned an HTML error page.`;
                } else {
                    errorMessage = "The upstream provider is currently experiencing issues.";
                }
            } else {
                try {
                    const parsedError = JSON.parse(errorText);
                    let rawMessage = parsedError.detail || parsedError.message || parsedError.error || errorMessage;
                    errorMessage = typeof rawMessage === 'object' ? JSON.stringify(rawMessage) : String(rawMessage);
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
        if (error.name === 'AbortError') {
            console.error(`[Executor] Timeout: Upstream API failed to respond within 20s.`);
            throw new Error("Upstream API request timed out. Please try again later.");
        }
        console.error(`[Executor] Error: ${error.message}`);
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 🌟 轻量级 JSON 寻址引擎 (Lightweight jq-style path evaluator)
 * 例如把 '.current_condition[0].temp_C' 转化为 obj['current_condition'][0]['temp_C']
 */
function evaluateJsonPath(obj: any, path: string) {
    if (!path) return undefined;
    
    // 🌟 增强：剔除 JSONPath 开头的 $ 或 $. (Enhanced: remove $. prefix)
    let cleanPath = path.trim();
    if (cleanPath.startsWith('$')) {
        cleanPath = cleanPath.slice(1);
    }
    if (cleanPath.startsWith('.')) {
        cleanPath = cleanPath.slice(1);
    }
    
    if (!cleanPath) return obj;

    const parts = cleanPath.split(/[\.\[\]'"]+/).filter(Boolean);
    let current = obj;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        current = current[part];
    }
    return current;
}

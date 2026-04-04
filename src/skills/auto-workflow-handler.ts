// src/skills/auto-workflow-handler.ts
// 职责：实现 UniSkill 元技能（Meta-Skill）—— uniskill_auto_workflow
// 核心思路：ReAct 循环（Reasoning + Acting）
//   1. Tool Discovery  → 扫描所有可用工具，构建工具目录
//   2. Planner（LLM）  → 分析用户 Goal，输出 call_tool / finish 决策
//   3. InternalExecution → 绕过 HTTP，直接在进程内执行子技能
//   4. Observation 反馈 → 将执行结果注入消息历史，驱动下一轮规划
//   5. 聚合返回        → 附带完整 execution_trace，写入双轨日志

import type { Env } from "../index";
import { SkillKeys } from "../utils/skill-keys";
import { getProfile } from "../utils/billing";
import { executeSkill } from "../engine/executor";
import { recordSkillCall } from "../utils/stats";
import { decryptSecret } from "../utils/security";

// ── 常量配置 ──────────────────────────────────────────────────────────────────
// 最大迭代次数：防止无限循环耗尽 DeepSeek 额度
const MAX_ITERATIONS = 5;

// 总请求超时（毫秒）：Cloudflare Workers CPU 上限约 30s，保留 5s 缓冲
const TOTAL_TIMEOUT_MS = 25_000;

// DeepSeek API 端点（兼容 OpenAI SDK 协议）
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";

// 原生技能集合：与 execute-skill.ts 的 HARDCODED_NATIVE_SKILLS 对齐
// 逻辑：内部调用时根据此集合决定走哪条执行路径
const NATIVE_SKILLS = new Set([
    "uniskill_weather",
    "uniskill_scrape",
    "uniskill_math",
    "uniskill_time",
    "uniskill_crypto_util",
    "uniskill_geo",
    "uniskill_github_tracker",
    "uniskill_smart_chart",
]);

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 单步执行追踪条目（写入 metadata.execution_trace） */
interface TraceEntry {
    step: number;
    action: "call_tool" | "finish" | "partial_finish" | "error";
    tool?: string;
    params?: any;
    result?: any;
    error?: string;
    duration_ms: number;
    timestamp: string;
}

/** Planner LLM 输出的决策结构 */
interface PlannerDecision {
    action: "call_tool" | "finish";
    tool?: string;      // action === "call_tool" 时必填
    params?: any;       // action === "call_tool" 时必填
    result?: string;    // action === "finish" 时必填
}

/** 工具目录条目（提供给 Planner 的工具描述） */
interface ToolEntry {
    name: string;           // 工具调用名（私有工具含 ${username}_ 前缀）
    description: string;
    parameters: any;        // JSON Schema 格式
    source: "official" | "market" | "private";
    internal_name?: string; // 私有工具剥除前缀后的真实 KV key 名
}

/** internalCallSkill 的返回结构 */
interface InternalCallResult {
    success: boolean;
    data?: any;
    error?: string;
    durationMs: number;
    displayName?: string;
    skillUid?: string | null;
    tags?: string[];
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * handleAutoWorkflow
 * 元技能主入口，由 execute-skill.ts 中的原生分发器调用。
 *
 * @param params          用户传入的 payload（必须含 goal 字段）
 * @param payerId         已通过鉴权的用户 UID（Vault 隔离依据）
 * @param env             Cloudflare Worker 环境变量
 * @param ctx             Cloudflare ExecutionContext（用于 waitUntil）
 * @param parentRequestId 父请求 ID（用于双轨日志关联）
 */
export async function handleAutoWorkflow(
    params: any,
    payerId: string,
    env: Env,
    ctx: ExecutionContext,
    parentRequestId: string
): Promise<any> {
    // 逻辑：记录起始时间，用于 25s 超时熔断
    const startTime = Date.now();
    const executionTrace: TraceEntry[] = [];
    let iterationsCompleted = 0;

    // ── 参数提取 ──
    // 逻辑：支持 goal / query / message 等多种字段名，提升兼容性
    const goal: string =
        params.goal || params.query || params.message || params.prompt || "";

    if (!goal || typeof goal !== "string" || goal.trim().length === 0) {
        return {
            success: false,
            error: "Missing required parameter: 'goal'. Please describe what you want to accomplish.",
        };
    }

    // ── Step 1: Tool Discovery ──
    // 逻辑：从 KV 全量扫描 official + market + private 三类技能，构建工具目录
    // 私有工具名会被改写为 ${username}_${skill_name}，防止重名导致 Planner 混乱
    let toolCatalog: ToolEntry[] = [];
    let username = "user"; // 默认用户名，后续从 profile 覆盖
    try {
        const profile = await getProfile(env.UNISKILL_KV, payerId, env);
        username = profile.username || "user";
        toolCatalog = await discoverTools(payerId, username, env);
    } catch (e: any) {
        // 逻辑：Tool Discovery 失败不应阻断执行，使用空工具列表降级
        console.error("[AutoWorkflow] Tool Discovery failed:", e.message);
    }

    // ── Step 2: 初始化 Planner 消息历史 ──
    // 逻辑：采用 OpenAI 兼容的消息格式，为 DeepSeek 构建对话上下文
    const systemPrompt = buildSystemPrompt(toolCatalog);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请完成以下任务：${goal}` },
    ];

    // ── Step 3: ReAct 主循环 ──
    // 状态机：PLANNING → ACTING → OBSERVING → … → DONE / TIMEOUT / MAX_ITER
    let finalResult: any = null;
    let terminatedEarly = false;
    let terminationReason = "";

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        iterationsCompleted = i + 1;

        // B. CPU 时间检查：每次循环开始前檢查总耗时
        // 逻辑：若已接近 25s 上限，强制退出并返回 partial_finish
        const elapsed = Date.now() - startTime;
        if (elapsed > TOTAL_TIMEOUT_MS) {
            terminatedEarly = true;
            terminationReason = "timeout";
            const partialEntry: TraceEntry = {
                step: i + 1,
                action: "partial_finish",
                result: "Request exceeded time limit. Returning partial results.",
                duration_ms: 0,
                timestamp: new Date().toISOString(),
            };
            executionTrace.push(partialEntry);
            break;
        }

        // ── Planner 决策 ──
        // 逻辑：将当前消息历史发给 DeepSeek，获取下一步决策
        const plannerStartTime = Date.now();
        let decision: PlannerDecision;
        try {
            decision = await callPlannerLLM(messages, env);
        } catch (e: any) {
            // 逻辑：Planner 调用失败（网络、API Key 错误等），直接终止循环
            const errEntry: TraceEntry = {
                step: i + 1,
                action: "error",
                error: `Planner LLM failed: ${e.message}`,
                duration_ms: Date.now() - plannerStartTime,
                timestamp: new Date().toISOString(),
            };
            executionTrace.push(errEntry);
            return buildErrorResponse(
                `Auto-Workflow Planner failed: ${e.message}`,
                executionTrace,
                iterationsCompleted,
                false
            );
        }

        // ── 决策分支处理 ──
        if (decision.action === "finish") {
            // 状态转移：DONE —— Planner 认为任务已完成
            const finishEntry: TraceEntry = {
                step: i + 1,
                action: "finish",
                result: decision.result,
                duration_ms: Date.now() - plannerStartTime,
                timestamp: new Date().toISOString(),
            };
            executionTrace.push(finishEntry);
            finalResult = decision.result;
            break;
        }

        if (decision.action === "call_tool") {
            // 逻辑：Planner 决定调用某个工具
            const toolName = decision.tool || "";
            const toolParams = decision.params || {};

            // 将 Planner 的决策加入消息历史
            messages.push({
                role: "assistant",
                content: JSON.stringify(decision),
            });

            // ── 内部工具执行 ──
            const toolStartTime = Date.now();
            let callResult: InternalCallResult;

            try {
                // 逻辑：internalCallSkill 负责处理命名空间还原（剥除 username 前缀）
                callResult = await internalCallSkill(
                    toolName,
                    toolParams,
                    payerId,
                    env,
                    username
                );
            } catch (e: any) {
                // 逻辑：执行器抛出异常，构造错误 Observation 反馈给 Planner（Self-Healing）
                callResult = {
                    success: false,
                    error: e.message,
                    durationMs: Date.now() - toolStartTime,
                };
            }

            const stepDuration = Date.now() - toolStartTime;

            // ── 追加 TraceEntry（轨道 1）──
            const traceEntry: TraceEntry = {
                step: i + 1,
                action: "call_tool",
                tool: toolName,
                params: toolParams,
                result: callResult.success ? callResult.data : undefined,
                error: callResult.success ? undefined : callResult.error,
                duration_ms: stepDuration,
                timestamp: new Date().toISOString(),
            };
            executionTrace.push(traceEntry);

            // ── 双轨日志（轨道 2）：向 skill_usage_logs 写入 cost=0 的子调用记录 ──
            // 逻辑：让创作者主页的 Total Invocations 统计到被 Auto-Workflow 间接调用的贡献
            // 使用 ctx.waitUntil 异步写入，不阻塞主流程
            if (callResult.success) {
                const subRequestId = `${parentRequestId}-step${i + 1}`;
                // 逻辑：还原真实工具名（剥除 username 前缀后的名字）用于日志记录
                const realToolName = resolveRealSkillName(toolName, username);
                ctx.waitUntil(
                    recordSkillCall(
                        env,
                        payerId,
                        realToolName,
                        subRequestId,
                        /* credits= */ 0,  // 子技能不重复计费
                        "credits",
                        {
                            status_code: 200,
                            execution_status: "SUCCESS",
                            error_message: null,
                            latency_ms: stepDuration,
                            metadata: {
                                invoked_by: "uniskill_auto_workflow",
                                parent_request_id: parentRequestId,
                                step: i + 1,
                            },
                        },
                        /* creditsPerCall= */ 0,
                        callResult.displayName,
                        callResult.tags,
                        callResult.skillUid
                    )
                );
            }

            // ── Observation 反馈给 Planner ──
            // 逻辑：Self-Healing 机制的核心：将执行结果（包括错误）直接告诉 Planner
            // Planner 可以据此修正参数、换用其他工具或判断放弃
            const observation = callResult.success
                ? `Tool Result (${toolName}): ${JSON.stringify(callResult.data)}`
                : `Tool Error (${toolName}): ${callResult.error}. Please try with different parameters or use another tool.`;

            messages.push({
                role: "user",
                content: observation,
            });

            continue; // 进入下一轮规划
        }

        // 逻辑：Planner 返回了意外的 action 格式，记录并中断
        const unexpectedEntry: TraceEntry = {
            step: i + 1,
            action: "error",
            error: `Planner returned unexpected action: ${JSON.stringify(decision)}`,
            duration_ms: Date.now() - plannerStartTime,
            timestamp: new Date().toISOString(),
        };
        executionTrace.push(unexpectedEntry);
        terminatedEarly = true;
        terminationReason = "invalid_planner_output";
        break;
    }

    // 逻辑：循环结束但 MAX_ITERATIONS 耗尽，触发 partial_finish
    if (finalResult === null && !terminatedEarly) {
        terminatedEarly = true;
        terminationReason = "max_iterations";
        executionTrace.push({
            step: MAX_ITERATIONS + 1,
            action: "partial_finish",
            result: "Reached maximum iterations. Returning partial results.",
            duration_ms: 0,
            timestamp: new Date().toISOString(),
        });
    }

    // ── 构建最终响应 ──
    if (terminatedEarly) {
        // 逻辑：超时 / 迭代耗尽 / 意外中断 → partial_finish
        return {
            status: "partial_finish",
            reason: terminationReason,
            partial_result: extractBestPartialResult(executionTrace),
            execution_trace: executionTrace,
            iterations_completed: iterationsCompleted,
            terminated_early: true,
        };
    }

    // 逻辑：正常完成
    return {
        result: finalResult,
        execution_trace: executionTrace,
        iterations_completed: iterationsCompleted,
        terminated_early: false,
    };
}

// ── Tool Discovery ─────────────────────────────────────────────────────────────

/**
 * discoverTools
 * 全量扫描 KV，构建当前用户可用的工具目录。
 *
 * 命名空间规则（防止私有工具重名）：
 *   - 官方 / 市场工具：使用原始名（如 uniskill_weather）
 *   - 私有工具：改写为 ${username}_${skill_name}（如 sunzekun99_my_search）
 *
 * 注意：internal_name 字段保存原始 skill_name，internalCallSkill 用它反查 KV
 */
async function discoverTools(
    payerId: string,
    username: string,
    env: Env
): Promise<ToolEntry[]> {
    const tools: ToolEntry[] = [];

    // 1. 扫描官方技能
    const officialList = await env.UNISKILL_KV.list({ prefix: "skill:official:" });
    for (const key of officialList.keys) {
        const raw = await env.UNISKILL_KV.get(key.name);
        if (!raw) continue;
        try {
            const skill = JSON.parse(raw);
            const skillName =
                skill.id ||
                key.name.replace("skill:official:", "");
            // 逻辑：跳过 Auto-Workflow 自身，防止递归调用
            if (skillName === "uniskill_auto_workflow") continue;

            tools.push({
                name: skillName,
                description:
                    skill.meta?.description || skill.description || "No description",
                parameters:
                    skill.meta?.parameters ||
                    skill.config?.parameters || { type: "object", properties: {} },
                source: "official",
            });
        } catch {
            /* 解析失败跳过 */
        }
    }

    // 2. 扫描市场技能
    const marketList = await env.UNISKILL_KV.list({ prefix: "skill:market:" });
    for (const key of marketList.keys) {
        const raw = await env.UNISKILL_KV.get(key.name);
        if (!raw) continue;
        try {
            const skill = JSON.parse(raw);
            const skillName =
                skill.id ||
                key.name.replace("skill:market:", "");

            tools.push({
                name: skillName,
                description:
                    skill.meta?.description || skill.description || "No description",
                parameters:
                    skill.meta?.parameters ||
                    skill.config?.parameters || { type: "object", properties: {} },
                source: "market",
            });
        } catch {
            /* 解析失败跳过 */
        }
    }

    // 3. 扫描用户私有技能（A. 命名空间隔离）
    // 逻辑：私有工具的展示名前缀为 ${username}_，防止与其他用户工具重名
    const privateList = await env.UNISKILL_KV.list({
        prefix: `skill:private:${payerId}:`,
    });
    for (const key of privateList.keys) {
        const raw = await env.UNISKILL_KV.get(key.name);
        if (!raw) continue;
        try {
            const skill = JSON.parse(raw);
            // 逻辑：提取 skill_name（去掉 skill:private:{uid}: 前缀）
            const rawName = key.name.replace(
                `skill:private:${payerId}:`,
                ""
            );
            const skillName = skill.id || rawName;
            // 逻辑：构造带命名空间的工具名（Planner 看到的名字）
            const namespacedName = `${username}_${skillName}`;

            tools.push({
                name: namespacedName,          // Planner 使用这个名字调用
                internal_name: skillName,       // internalCallSkill 用这个名字查 KV
                description:
                    skill.meta?.description || skill.description || "Private skill",
                parameters:
                    skill.meta?.parameters ||
                    skill.config?.parameters || { type: "object", properties: {} },
                source: "private",
            });
        } catch {
            /* 解析失败跳过 */
        }
    }

    return tools;
}

// ── Planner LLM ───────────────────────────────────────────────────────────────

/**
 * callPlannerLLM
 * 调用 DeepSeek-Chat（兼容 OpenAI 协议），获取下一步规划决策。
 * 严格校验输出格式，若解析失败则抛出异常。
 */
async function callPlannerLLM(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    env: Env
): Promise<PlannerDecision> {
    const apiKey = (env as any).DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error(
            "DEEPSEEK_API_KEY is not configured. Please add it to your Worker secrets."
        );
    }

    // 逻辑：调用 DeepSeek API（OpenAI 兼容接口）
    const response = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages,
            temperature: 0.1,     // 低温度：确保决策输出稳定，减少格式变异
            max_tokens: 512,       // 限制输出长度：决策 JSON 不需要很长
            response_format: { type: "json_object" }, // DeepSeek 支持强制 JSON 输出
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
    }

    const llmResult: any = await response.json();
    const rawContent = llmResult.choices?.[0]?.message?.content;

    if (!rawContent) {
        throw new Error("DeepSeek returned empty content.");
    }

    // 逻辑：解析 Planner 输出的 JSON 决策
    let decision: PlannerDecision;
    try {
        decision = JSON.parse(rawContent);
    } catch {
        throw new Error(
            `Planner output is not valid JSON: ${rawContent.slice(0, 200)}`
        );
    }

    // 逻辑：校验决策结构完整性
    if (decision.action !== "call_tool" && decision.action !== "finish") {
        throw new Error(
            `Planner returned unknown action: "${decision.action}". Expected "call_tool" or "finish".`
        );
    }
    if (decision.action === "call_tool" && !decision.tool) {
        throw new Error('Planner decided "call_tool" but did not specify "tool" field.');
    }

    return decision;
}

// ── Internal Execution Engine ─────────────────────────────────────────────────

/**
 * internalCallSkill
 * 内部执行引擎：绕过 HTTP 请求直接调用子技能逻辑。
 * 不鉴权、不扣费（bypassBilling = true）。
 *
 * 执行路径优先级：
 *   1. 原生内置技能（Native：weather / scrape / math 等）
 *   2. 用户私有技能（读 skill:private:{payerId}:{realName}）
 *   3. 通用技能（official / market，走 executeSkill 泛化执行器）
 *
 * @param namespacedName  Planner 传来的工具名（可能带 ${username}_ 前缀）
 * @param params          工具参数
 * @param payerId         原始请求者 UID（用于 Vault 隔离读取 Secrets）
 * @param env             Worker 环境
 * @param username        用于还原命名空间前缀
 */
async function internalCallSkill(
    namespacedName: string,
    params: any,
    payerId: string,
    env: Env,
    username: string
): Promise<InternalCallResult> {
    const startTime = Date.now();

    // 逻辑：还原真实 skillName（剥除 ${username}_ 前缀）
    const realName = resolveRealSkillName(namespacedName, username);
    // 标准化：确保格式为 uniskill_xxx
    const normalizedName = realName.startsWith("uniskill_")
        ? realName
        : `uniskill_${realName}`;

    try {
        // ── 路径 1：原生内置技能 ──
        // 逻辑：与 execute-skill.ts 的原生分发逻辑保持一致
        if (NATIVE_SKILLS.has(normalizedName)) {
            // 逻辑：构造一个合成 Request 对象
            // 内部调用不含真实 Authorization Header，避免鉴权开销
            const syntheticReq = new Request("https://internal.uniskill/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });

            let nativeResponse: Response;

            if (normalizedName === "uniskill_weather") {
                const { handleWeather } = await import("../routes/weather");
                nativeResponse = await handleWeather(syntheticReq, env);
            } else if (normalizedName === "uniskill_scrape") {
                const { handleScrape } = await import("../routes/scrape");
                nativeResponse = await handleScrape(syntheticReq, env);
            } else if (normalizedName === "uniskill_math") {
                const { handleMath } = await import("../routes/math");
                nativeResponse = await handleMath(syntheticReq, env);
            } else if (normalizedName === "uniskill_time") {
                const { handleTime } = await import("../routes/time");
                nativeResponse = await handleTime(syntheticReq, env);
            } else if (normalizedName === "uniskill_crypto_util") {
                const { handleCrypto } = await import("../routes/crypto_util");
                nativeResponse = await handleCrypto(syntheticReq, env);
            } else if (normalizedName === "uniskill_geo") {
                const { handleGeo } = await import("../routes/geo");
                nativeResponse = await handleGeo(syntheticReq, env);
            } else if (normalizedName === "uniskill_github_tracker") {
                const { handleGithubTracker } = await import("../routes/github-tracker");
                nativeResponse = await handleGithubTracker(syntheticReq, env);
            } else if (normalizedName === "uniskill_smart_chart") {
                const { executeSmartChart } = await import("../routes/uniskill-smart-chart");
                const chartData = await executeSmartChart(params, env);
                return {
                    success: true,
                    data: chartData,
                    durationMs: Date.now() - startTime,
                    displayName: "UniSkill Smart Chart",
                };
            } else {
                throw new Error(`Native handler not found: ${normalizedName}`);
            }

            if (!nativeResponse.ok) {
                const errText = await nativeResponse.text();
                throw new Error(`Native skill error (${nativeResponse.status}): ${errText}`);
            }

            const data = await nativeResponse.json();
            return { success: true, data, durationMs: Date.now() - startTime };
        }

        // ── 路径 2 & 3：私有技能 + 通用技能（走 executeSkill 泛化执行器）──
        // 逻辑：按优先级查 KV：私有 > 官方 > 市场
        let skillRaw: string | null = null;
        let skillMeta: any = null;

        // 优先尝试用户私有技能（使用还原后的真实 skillName）
        const rawNameForPrivate = resolveRealSkillName(namespacedName, username);
        skillRaw =
            (await env.UNISKILL_KV.get(SkillKeys.private(payerId, rawNameForPrivate))) ||
            (await env.UNISKILL_KV.get(SkillKeys.private(payerId, normalizedName)));

        if (!skillRaw) {
            // 尝试官方技能
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.official(normalizedName));
        }
        if (!skillRaw) {
            // 尝试市场技能
            skillRaw = await env.UNISKILL_KV.get(SkillKeys.market(normalizedName));
        }

        if (!skillRaw) {
            throw new Error(
                `Skill not found: "${namespacedName}" (resolved as "${normalizedName}"). ` +
                    `Please check the skill name and try again.`
            );
        }

        skillMeta = JSON.parse(skillRaw);
        const implementation =
            skillMeta.implementation ||
            skillMeta.config ||
            (skillMeta as any).config;
        const displayName =
            skillMeta.display_name ||
            skillMeta.meta?.display_name ||
            skillMeta.meta?.name ||
            normalizedName;
        const skillUid = skillMeta.skill_uid || skillMeta.id || null;
        const tags = skillMeta.tags || skillMeta.meta?.tags || [];

        if (!implementation) {
            throw new Error(
                `Skill "${normalizedName}" has no implementation config.`
            );
        }

        // ── Vault 隔离：只读取 payerId 对应的 Secrets ──
        // 逻辑：子技能只能访问发起请求的用户的 Vault，不存在跨用户读取
        const rawSecrets: Record<string, string> = {};
        try {
            const userSecretsRaw = await env.UNISKILL_KV.get(
                SkillKeys.secrets(payerId)
            );
            mergeSecretsInto(rawSecrets, userSecretsRaw);

            const skillSecretsRaw = await env.UNISKILL_KV.get(
                SkillKeys.skillSecrets(payerId, rawNameForPrivate)
            );
            mergeSecretsInto(rawSecrets, skillSecretsRaw);
        } catch (e: any) {
            console.warn("[AutoWorkflow] Secrets load warning:", e.message);
        }

        // 实时解密 Secrets
        const decryptedSecrets: Record<string, string> = {};
        for (const [key, val] of Object.entries(rawSecrets)) {
            try {
                if (typeof val === "string" && val.split(".").length === 3) {
                    decryptedSecrets[key] = decryptSecret(
                        val,
                        (env as any).MASTER_ENCRYPTION_KEY
                    );
                } else {
                    decryptedSecrets[key] = val;
                }
            } catch {
                // 逻辑：解密失败时不中断，让 executeSkill 内部处理 missing secret 错误
                decryptedSecrets[key] = val;
            }
        }

        // 调用通用执行器（isOfficial = true 时允许回退到系统 Key）
        const isOfficial = !skillRaw.includes(`skill:private:${payerId}`);
        const data = await executeSkill(
            implementation,
            params,
            env as any,
            decryptedSecrets,
            isOfficial
        );

        return {
            success: true,
            data,
            durationMs: Date.now() - startTime,
            displayName,
            skillUid,
            tags,
        };
    } catch (e: any) {
        return {
            success: false,
            error: e.message,
            durationMs: Date.now() - startTime,
        };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * buildSystemPrompt
 * 构建提供给 Planner LLM 的 System Prompt。
 * 包含完整工具目录描述和严格的输出格式规范。
 */
function buildSystemPrompt(tools: ToolEntry[]): string {
    // 逻辑：将工具目录序列化为 JSON 格式，供 Planner 理解可用工具
    const toolsList = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));

    return `你是 UniSkill 自动工作流协调者（Auto-Workflow Planner）。你的任务是根据用户的 Goal，有序地规划并调用以下工具来完成任务。

【可用工具列表】
${JSON.stringify(toolsList, null, 2)}

【命名规则说明】
- 官方工具以 "uniskill_" 开头（如 uniskill_weather）
- 私有工具以用户名开头（如 username_my_tool），调用时请使用完整名称

【输出规范 - 非常重要】
每次只返回一个 JSON 对象，必须是以下两种格式之一，不得有任何额外文本：

格式 A（调用工具）:
{ "action": "call_tool", "tool": "<工具名>", "params": { <工具参数> } }

格式 B（完成任务）:
{ "action": "finish", "result": "<最终答案，直接面向用户的自然语言>" }

【行为准则】
1. 每次只做一件事，不要一次性规划所有步骤
2. 收到工具执行结果后，基于结果决定下一步
3. 如果工具执行报错，尝试修正参数或換用其他工具
4. 任务完成后立即使用 finish，不要做多余的步骤
5. 如果无法完成任务，用 finish 说明原因`;
}

/**
 * resolveRealSkillName
 * 逻辑：将 Planner 使用的带命名空间工具名还原为真实 skillName。
 * 例如：sunzekun99_my_search → my_search（剥除 ${username}_ 前缀）
 * 官方工具不含前缀：uniskill_weather → uniskill_weather（不变）
 */
function resolveRealSkillName(namespacedName: string, username: string): string {
    const prefix = `${username}_`;
    if (username && username !== "user" && namespacedName.startsWith(prefix)) {
        return namespacedName.slice(prefix.length);
    }
    return namespacedName;
}

/**
 * mergeSecretsInto
 * 将 KV 读取的原始 secrets JSON 字符串合并到目标对象中。
 * 支持 Array 格式（[{key, value}]）和 Object 格式。
 */
function mergeSecretsInto(
    target: Record<string, string>,
    raw: string | null
): void {
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            parsed.forEach((item: any) => {
                if (item.key && item.value) target[item.key] = item.value;
            });
        } else if (typeof parsed === "object") {
            Object.assign(target, parsed);
        }
    } catch {
        /* 忽略解析错误 */
    }
}

/**
 * extractBestPartialResult
 * 逻辑：从 execution_trace 中提取最后一个成功的工具调用结果，
 * 作为 partial_finish 情况下的降级返回内容。
 */
function extractBestPartialResult(trace: TraceEntry[]): string {
    // 反向遍历，找最近一次成功的 call_tool 结果
    for (let i = trace.length - 1; i >= 0; i--) {
        const entry = trace[i];
        if (entry.action === "call_tool" && entry.result !== undefined) {
            return `Partial result from step ${entry.step} (${entry.tool}): ${JSON.stringify(entry.result)}`;
        }
    }
    return "No partial result available.";
}

/**
 * buildErrorResponse
 * 构造标准化的错误响应对象。
 */
function buildErrorResponse(
    message: string,
    trace: TraceEntry[],
    iterations: number,
    terminatedEarly: boolean
): any {
    return {
        success: false,
        error: message,
        execution_trace: trace,
        iterations_completed: iterations,
        terminated_early: terminatedEarly,
    };
}

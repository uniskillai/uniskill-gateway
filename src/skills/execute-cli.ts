/**
 * src/skills/execute-cli.ts
 * 核心 CLI 执行处理器：重构版，完全对齐单元测试规格 (src/skills/execute-cli.test.ts)
 */

import { CliExecutionContext, CliExecutionResult, SandboxRequest, SandboxResponse } from "../types/cli";

// 🌟 变量注入正则：支持 {{param_name}} 和 {{SECRETS.KEY}}
const PLACEHOLDER_REGEX = /\{\{([a-zA-Z0-9._-]+)\}\}/g;

/**
 * 执行 CLI 技能的核心处理器
 * 职责：变量注入、沙箱请求构造、结果解析映射
 * 
 * @param context 执行上下文，包含实现定义、参数和机密信息
 * @param sandboxUrl 远程沙箱节点 URL
 * @param internalToken 内部授权令牌
 */
export async function executeCliSkill(
  context: CliExecutionContext,
  sandboxUrl: string,
  internalToken: string
): Promise<CliExecutionResult> {
  const startTime = Date.now();
  const { implementation, params, secrets, payer_id } = context;

  try {
    // 1. 变量注入 (Variable Injection)
    // 逻辑：基于正则匹配 {{}} 占位符。若参数缺失则原地保留，确保命令语义完整。
    const resolver = (match: string, key: string) => {
      // 🔐 优先匹配 SECRETS.KEY
      if (key.startsWith("SECRETS.")) {
        const secretKey = key.split(".")[1];
        return secrets[secretKey] !== undefined ? String(secrets[secretKey]) : match;
      }
      // 💼 匹配调用方传入的 params 业务参数
      return params[key] !== undefined ? String(params[key]) : match;
    };

    const resolvedEnv = { ...(implementation.env || {}) };
    for (const [k, v] of Object.entries(resolvedEnv)) {
      resolvedEnv[k] = v.replace(PLACEHOLDER_REGEX, resolver);
    }

    const finalArgs = (implementation.args || []).map(arg => 
      arg.replace(PLACEHOLDER_REGEX, resolver)
    );

    // 2. 构造加密沙箱载荷 (Sandbox Payload)
    // 根据最新类型定义，payer_id 仅通过 Header 传输以提高安全性
    const sandboxPayload: SandboxRequest = {
      image: implementation.image || "uniskill/cli-base:latest",
      binary: implementation.binary,
      args: finalArgs,
      env: resolvedEnv,
      timeout_seconds: implementation.timeout_seconds || 30
    };

    if (!sandboxUrl) {
      throw new Error("SANDBOX_NODE_URL is not configured.");
    }

    // 3. 发送高性能请求至沙箱节点
    // 自动适配结尾斜杠并追加执行路径
    const targetUrl = sandboxUrl.endsWith('/') ? `${sandboxUrl}execute` : `${sandboxUrl}/execute`;
    const controller = new AbortController();
    const timeoutMs = (sandboxPayload.timeout_seconds || 30) * 1000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-UniSkill-Internal-Token": internalToken,
          "X-UniSkill-Payer-Id": payer_id // 身份标识作为 Header 传输
        },
        body: JSON.stringify(sandboxPayload),
        signal: controller.signal as any
      });

      // 处理沙箱级错误或网络异常
      if (!response.ok) {
        if (response.status === 504) {
          return {
            status: 'TIMEOUT',
            message: "The CLI sandbox execution timed out.",
            result: { output: "" },
            duration_ms: Date.now() - startTime
          };
        }
        const errorText = await response.text();
        return {
          status: 'FAILED',
          message: `Sandbox infrastructure error: HTTP ${response.status}`,
          result: { error: errorText },
          duration_ms: Date.now() - startTime
        };
      }

      const sandboxData = (await response.json()) as SandboxResponse;

      // 4. 解析 CLI 进程反馈 (Process Result Mapping)
      if (sandboxData.exit_code !== 0) {
        return {
          status: 'FAILED',
          message: `CLI execution failed with exit code: ${sandboxData.exit_code}`,
          result: { 
            error: sandboxData.stderr || "Process exited with errors.",
            exit_code: sandboxData.exit_code
          },
          duration_ms: Date.now() - startTime
        };
      }

      // 处理成功输出并进行结构化猜测 (JSON vs Text)
      const parsedResult = parseStdout(sandboxData.stdout);

      return {
        status: 'SUCCESS',
        result: parsedResult,
        duration_ms: Date.now() - startTime
      };

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return {
          status: 'TIMEOUT',
          message: `Execution exceeded the limit of ${sandboxPayload.timeout_seconds}s`,
          result: { output: "" },
          duration_ms: Date.now() - startTime
        };
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

  } catch (err: any) {
    // 捕获网络、配置及其他意外异常
    return {
      status: 'FAILED',
      message: err.message || "An unexpected error occurred into CLI executor.",
      result: { error: String(err) },
      duration_ms: Date.now() - startTime
    };
  }
}

/**
 * 智能解析 stdout 输出
 * 
 * 规则：
 * 1. 若输出为合法 JSON 对象/数组 -> 原始导出
 * 2. 若输出为 JSON 基元 (数字, 布尔) -> 封装为 { value: ... }
 * 3. 否则 -> 作为文本包装在 { output: "..." }
 */
function parseStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return { output: "" };

  try {
    const parsed = JSON.parse(trimmed);
    
    // 逻辑：处理对象与数组 (Array 也是 Object)
    if (parsed !== null && typeof parsed === 'object') {
      return parsed; // 已经是结构化对象
    }
    
    // 逻辑：处理基元 (Primitive)
    return { value: parsed };
  } catch {
    // 逻辑：文本输出
    return { output: trimmed };
  }
}

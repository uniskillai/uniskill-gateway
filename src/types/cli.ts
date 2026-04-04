/**
 * src/types/cli.ts
 * CLI 运行时类型定义
 * 为 UniSkill Gateway 的 CLI 执行模式提供严格的类型约束
 */

// ============================================================
// 技能清单中 CLI 实现块的结构定义
// ============================================================

/**
 * CLI 实现配置接口
 * 对应技能清单 (Manifest) 中 implementation 字段的结构
 */
export interface CliImplementation {
  /** 运行时类型标识符，固定为 "cli" */
  type: "cli";

  /**
   * 要执行的二进制文件名称
   * 例如: "vercel", "stripe", "gh", "bash"
   * 沙箱节点需在 PATH 中预装该命令
   */
  binary: string;

  /**
   * 传递给二进制文件的参数列表
   * 支持 {{param_name}} 和 {{SECRETS.KEY}} 占位符
   * 例如: ["deploy", "--name={{project_name}}", "--token={{SECRETS.VERCEL_TOKEN}}"]
   */
  args?: string[];

  /**
   * 注入到命令执行环境中的环境变量映射
   * 支持占位符替换
   * 例如: { "VERCEL_TOKEN": "{{SECRETS.VERCEL_TOKEN}}" }
   */
  env?: Record<string, string>;

  /**
   * 容器镜像名称（可选，默认使用基础镜像）
   * 例如: "uniskill/cli-base:latest", "uniskill/node-cli:18"
   */
  image?: string;

  /**
   * 命令执行超时时间（秒）
   * 超时后沙箱返回 504，网关映射为 FAILED 状态
   */
  timeout_seconds?: number;
}

// ============================================================
// 发送给远程沙箱节点的请求载荷
// ============================================================

/**
 * 沙箱执行请求接口
 * 网关向 UniSkill Sandbox Node 发送的标准载荷格式
 */
export interface SandboxRequest {
  /**
   * 使用的容器镜像
   * 沙箱节点将在此镜像环境中执行命令
   */
  image: string;

  /**
   * 要执行的二进制文件名（占位符已完成替换）
   */
  binary: string;

  /**
   * 完成变量替换后的最终参数列表（无任何 {{}} 占位符）
   */
  args: string[];

  /**
   * 完成变量替换后的环境变量映射
   * 包含从 Vault 解密后的真实 Secret 值
   */
  env: Record<string, string>;

  /**
   * 执行超时时间（秒），透传给沙箱节点
   */
  timeout_seconds?: number;
}

// ============================================================
// 沙箱节点返回结果
// ============================================================

/**
 * 沙箱执行响应接口
 * 沙箱节点执行完毕后返回的标准响应格式
 */
export interface SandboxResponse {
  /** 命令的标准输出（stdout） */
  stdout: string;

  /** 命令的标准错误输出（stderr） */
  stderr?: string;

  /** 进程退出码，0 表示成功 */
  exit_code: number;

  /** 实际执行耗时（毫秒） */
  duration_ms?: number;
}

// ============================================================
// UniSkill 技能执行结果标准格式
// ============================================================

/** 执行状态枚举 */
export type ExecutionStatus = "SUCCESS" | "FAILED" | "TIMEOUT";

/**
 * CLI 技能执行结果
 * 返回给 API 调用方的标准化响应结构
 */
export interface CliExecutionResult {
  /** 执行状态 */
  status: ExecutionStatus;

  /**
   * 结构化输出数据
   * 若 stdout 为合法 JSON 则直接解析；否则封装在 result.output 中
   */
  result: Record<string, unknown>;

  /** 可读的执行状态描述（供调试使用） */
  message?: string;

  /** 执行耗时（毫秒） */
  duration_ms?: number;
}

// ============================================================
// 执行上下文（由路由分发器组装后传入执行层）
// ============================================================

/**
 * CLI 执行上下文接口
 * 路由分发器从请求和技能定义中提取所有必要信息后，
 * 封装成此结构传递给核心处理器
 */
export interface CliExecutionContext {
  /** 技能逻辑名称 (对应 KV 中的 name 部分) */
  skill_name: string;

  /**
   * 付费方用户 ID
   * 安全关键字段：仅从 Vault 中提取该用户授权的 Secret
   */
  payer_id: string;

  /** 技能调用方传入的动态参数（用于替换 {{param_name}} 占位符） */
  params: Record<string, string>;

  /** CLI 实现配置（来自技能清单） */
  implementation: CliImplementation;

  /**
   * 已从 Vault 获取的 Secret 键值对
   * 键名对应 {{SECRETS.KEY}} 中的 KEY 部分
   * 值为解密后的明文（内存中短暂持有，用后立即丢弃）
   */
  secrets: Record<string, string>;
}

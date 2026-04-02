// ============================================================
// src/routes/analytics.ts
// Analytics Handler: Secure, per-user usage statistics.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { errorResponse, successResponse } from "../utils/response";

/**
 * 统计响应数据的标准接口定义
 */
interface AnalyticsResponse {
  range: string;
  overview: {
    totalInvocations: number;   // 总调用量
    successRate: number;        // 成功率 (百分比)
    totalRevenue: number;       // 总计费积分 (收益)
    avgLatencyMs: number;       // 平均执行延迟
    evolutionImpact: number;    // 进化机制（经验注入）触发次数
  };
  topErrors: Array<{
    errorMessage: string;       // 错误信息描述
    count: number;              // 发生次数
  }>;
  trend: Array<{
    date: string;               // 日期 (YYYY-MM-DD)
    calls: number;              // 当日调用数
    revenue: number;            // 当日收益
  }>;
}

/**
 * 获取分析统计数据的核心处理器
 * 支持 Query Params: ?range=24h | 7d | 30d | 90d | all
 * Note: Middleware ensures userUid is present.
 */
export async function handleGetAnalytics(request: any, env: any) {
  const userUid = request.userUid;
  if (!userUid) return errorResponse("Unauthorized: Missing User Identity", 401);

  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") || "7d";

  // 1. 时间范围映射表
  const rangeMap: Record<string, number> = {
    "24h": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "all": 0
  };

  const days = rangeMap[range] ?? 7;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // 🌟 趋势图负载控制：限制趋势图最长回溯 180 天 (Trend Load Control: 180 days max)
  const trendLimitDays = (days === 0 || days > 180) ? 180 : days;
  const trendStartDate = new Date(Date.now() - trendLimitDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 3. 并发数据检索
    const [overviewResult, errorResult, trendResult] = await Promise.all([
      // A. 调用 Supabase 定义的高性能聚合 RPC
      supabase.rpc("get_user_analytics_overview", { 
        p_user_uid: userUid, 
        p_days: days 
      }),

      // B. 查询高频错误分布 (FAILED 记录) —— 同样受限于 trendLimitDays 防大包
      supabase
        .from("skill_usage_logs")
        .select("error_message")
        .eq("user_uid", userUid)
        .eq("execution_status", "FAILED")
        .gte("created_at", trendStartDate)
        .limit(300),

      // C. 获取趋势数据 —— 受限于 180 天限制
      supabase
        .from("skill_usage_logs")
        .select("created_at, cost")
        .eq("user_uid", userUid)
        .gte("created_at", trendStartDate)
    ]);

    // 4. 处理概览结果
    if (overviewResult.error) throw overviewResult.error;
    const ov = overviewResult.data[0];

    // 5. 处理错误排行逻辑 (In-Memory 聚合)
    const errorMap: Record<string, number> = {};
    errorResult.data?.forEach((log: any) => {
      const msg = log.error_message || "Unknown Execution Error";
      errorMap[msg] = (errorMap[msg] || 0) + 1;
    });

    const topErrors = Object.entries(errorMap)
      .map(([errorMessage, count]) => ({ errorMessage, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // 6. 处理每日趋势逻辑 (In-Memory 聚合)
    const trendMap: Record<string, { calls: number; revenue: number }> = {};
    trendResult.data?.forEach((log: any) => {
      const dateKey = log.created_at.split("T")[0]; // 提取 YYYY-MM-DD
      if (!trendMap[dateKey]) trendMap[dateKey] = { calls: 0, revenue: 0 };
      trendMap[dateKey].calls += 1;
      trendMap[dateKey].revenue += (log.cost || 0); // 财务对齐：完全使用 cost 字段进行求和
    });

    const trend = Object.entries(trendMap)
      .map(([date, val]) => ({ date, ...val }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 7. 构建标准响应
    const responseData: AnalyticsResponse = {
      range,
      overview: {
        totalInvocations: parseInt(ov?.total_calls || "0"),
        successRate: parseFloat(ov?.success_rate || "0"),
        totalRevenue: parseFloat(ov?.total_credits_earned || "0"),
        avgLatencyMs: Math.round(ov?.avg_latency_ms || 0),
        evolutionImpact: parseInt(ov?.evolution_count || "0")
      },
      topErrors,
      trend
    };

    return successResponse({
      data: responseData,
      _uniskill_meta: {
        server_region: "global-edge",
        cache_status: "bypass"
      }
    });

  } catch (err: any) {
    return errorResponse(`Analytics Service Error: ${err.message}`, 500);
  }
}

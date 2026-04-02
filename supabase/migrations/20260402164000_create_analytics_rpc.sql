-- 📊 UniSkill Analytics RPC: get_user_analytics_overview
-- Description: Aggregates usage metrics for a specific user over a given day range.
-- Version: 3.0 (with Evolution Impact double-check)

DROP FUNCTION IF EXISTS public.get_user_analytics_overview(UUID, INT);

CREATE OR REPLACE FUNCTION public.get_user_analytics_overview(
    p_user_uid UUID,
    p_days INT -- 0 means 'all'
)
RETURNS TABLE (
    total_calls BIGINT,
    success_rate NUMERIC,
    total_credits_earned NUMERIC,
    avg_latency_ms NUMERIC,
    evolution_count BIGINT
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_start_date TIMESTAMP;
BEGIN
    -- [1] Determine start date
    IF p_days > 0 THEN
        v_start_date := NOW() - (p_days || ' days')::INTERVAL;
    ELSE
        v_start_date := '1970-01-01'::TIMESTAMP;
    END IF;

    -- [2] Core aggregation
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT as total_calls,
        CASE 
            WHEN COUNT(*) = 0 THEN 0 
            ELSE (COUNT(*) FILTER (WHERE execution_status = 'SUCCESS')::NUMERIC / COUNT(*)::NUMERIC) * 100 
        END as success_rate,
        COALESCE(SUM(cost), 0)::NUMERIC as total_credits_earned,
        COALESCE(AVG(latency_ms), 0)::NUMERIC as avg_latency_ms,
        -- 🌟 进化触发双重检测逻辑 (Double-check evolution logic)
        COUNT(*) FILTER (
            WHERE (metadata->>'experience_injected' = 'true') 
               OR (metadata->'trace' ? 'experience_injection')
        )::BIGINT as evolution_count
    FROM public.skill_usage_logs
    WHERE user_uid = p_user_uid
      AND created_at >= v_start_date;
END;
$$;

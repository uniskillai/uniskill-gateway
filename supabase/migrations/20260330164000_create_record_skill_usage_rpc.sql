-- 🌟 UniSkill Core RPC: record_skill_usage
-- Description: Unified handler for usage logging, credit deduction, and skill metrics.
-- Includes explicit Nil/Official UID handling to avoid FK violations.

CREATE OR REPLACE FUNCTION public.record_skill_usage(
    p_user_uid TEXT,
    p_skill_name TEXT,
    p_source_skill_uid TEXT,
    p_payment_type TEXT,
    p_request_id TEXT,
    p_cost NUMERIC,
    p_status_code INT,
    p_execution_status TEXT,
    p_error_message TEXT,
    p_latency_ms INT,
    p_metadata JSONB,
    p_credits_per_call NUMERIC DEFAULT 0,
    p_display_name TEXT DEFAULT NULL,
    p_tags TEXT[] DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER -- 🌟 重要：以系统权限运行以完成跨表操作（Deduction, Logs）
AS $$
DECLARE
    v_safe_user_uid UUID;
    v_actual_skill_uid UUID;
    v_actual_display_name TEXT;
    -- 🌟 官方系统级 UID
    v_system_uid UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    -- [A] 安全转换用户 UUID (Try-Cast)
    BEGIN
        v_safe_user_uid := p_user_uid::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_safe_user_uid := v_system_uid;
    END;

    -- [B] 解析技能 UID 与名称 (Skill Resolution)
    -- 尝试从传入的 p_source_skill_uid (需符合UUID) 解析
    IF p_source_skill_uid IS NOT NULL AND p_source_skill_uid ~ '^[0-9a-fA-F-]{36}$' THEN
        v_actual_skill_uid := p_source_skill_uid::UUID;
    END IF;

    -- 根据名称搜索，匹配原始名或私有前缀名
    IF v_actual_skill_uid IS NULL THEN
        SELECT skill_uid, display_name INTO v_actual_skill_uid, v_actual_display_name
        FROM public.skills 
        WHERE skill_name = p_skill_name OR skill_name = 'uniskillai_' || p_skill_name LIMIT 1;
    END IF;

    -- [C] 名称补全策略
    v_actual_display_name := COALESCE(NULLIF(TRIM(p_display_name), ''), v_actual_display_name, p_skill_name);
    
    -- 🌟 如果技能不存在于 skills 表，强制置为 NULL 或系统 ID，避免外键冲突
    IF v_actual_skill_uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.skills WHERE skill_uid = v_actual_skill_uid) THEN
        v_actual_skill_uid := v_system_uid; 
    END IF;

    -- [D] 审计日志插入 (Step 1: Audit Log)
    -- 注意：这里如果不确定 profiles 里有没有 v_safe_user_uid，
    -- 我们在插入前先检查是否存在，不存在则设为系统 ID 兜底
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_uid = v_safe_user_uid) THEN
        v_safe_user_uid := v_system_uid;
    END IF;

    INSERT INTO public.skill_usage_logs (
        user_uid, 
        source_skill_uid, 
        skill_name, 
        display_name, 
        payment_type, 
        request_id, 
        cost, 
        status_code, 
        execution_status, 
        error_message, 
        latency_ms, 
        metadata, 
        created_at
    )
    VALUES (
        v_safe_user_uid, 
        COALESCE(v_actual_skill_uid, v_system_uid), 
        p_skill_name, 
        v_actual_display_name, 
        LOWER(p_payment_type), 
        p_request_id, 
        p_cost, 
        p_status_code, 
        p_execution_status, 
        p_error_message, 
        p_latency_ms, 
        p_metadata, 
        NOW()
    );

    -- [E] 财务结算逻辑 (Step 2: Financials)
    IF p_execution_status = 'SUCCESS' AND p_cost > 0 THEN
        
        -- 1. 更新技能热度 (对真实的技能)
        IF v_actual_skill_uid IS NOT NULL AND v_actual_skill_uid <> v_system_uid THEN
            UPDATE public.skills 
            SET total_calls = total_calls + 1, 
                last_called_at = NOW() 
            WHERE skill_uid = v_actual_skill_uid;
        END IF;

        -- 2. 写入账单流水
        INSERT INTO public.credit_events (
            user_uid, 
            skill_name, 
            display_name, 
            amount, 
            request_id, 
            created_at
        )
        VALUES (
            v_safe_user_uid, 
            p_skill_name, 
            v_actual_display_name, 
            -p_cost, 
            p_request_id, 
            NOW()
        );

        -- 3. 扣除余额 (🌟 核心修复：对齐列名为 user_uid 且跳过系统账户)
        IF v_safe_user_uid <> v_system_uid THEN
            UPDATE public.profiles 
            SET credits = COALESCE(credits, 0) - p_cost 
            WHERE user_uid = v_safe_user_uid; -- 👈 修复：从 id 改回 user_uid
        END IF;

    END IF;
END;
$$;

-- 🌟 UniSkill TTL: Auto-cleanup for invocations table
-- Description: Uses pg_cron to delete invocation logs older than 30 days every midnight.

-- 1. 开启 pg_cron 扩展 (如果尚未开启)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 将定时任务权限授予 postgres 角色
GRANT USAGE ON SCHEMA cron TO postgres;

-- 3. 编排每日清理任务
-- 逻辑：每天凌晨 0 点执行，仅清理 invocations 表，不碰 skill_usage_logs
SELECT cron.schedule(
    'uniskill-logs-cleanup', -- 任务名称
    '0 0 * * *',             -- Cron 表达式: 每天 0 点
    $$
    BEGIN;
      -- 仅清理原始调用日志，保留财务审计日志 (skill_usage_logs)
      DELETE FROM public.invocations WHERE created_at < NOW() - INTERVAL '30 days';
    COMMIT;
    $$
);

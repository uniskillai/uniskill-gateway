-- 1. 启用必需的扩展
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 修改原来的 invocations 表
ALTER TABLE public.invocations 
  ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMP WITH TIME ZONE NULL;

-- 3. 创建 skill_learnings 知识库表
CREATE TABLE IF NOT EXISTS public.skill_learnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_uid UUID REFERENCES public.skills(uid) ON DELETE CASCADE,
    user_uid UUID REFERENCES public.profiles(user_uid) ON DELETE CASCADE,
    task_description TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    solution_patch TEXT NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. 建立由于经常根据 skill_uid 全表检索的普通索引
CREATE INDEX IF NOT EXISTS idx_skill_learnings_skill_uid ON public.skill_learnings(skill_uid);

-- 5. RLS 权限（强制仅 Service Role 可增删改查）
ALTER TABLE public.skill_learnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service Role Only - All Operations on skill_learnings"
ON public.skill_learnings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 6. 创建匹配已有教训的 RPC 函数 (Cos相似度)
CREATE OR REPLACE FUNCTION match_skill_learnings (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  target_skill_uid UUID
)
RETURNS TABLE (
  id UUID,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    skill_learnings.id,
    1 - (skill_learnings.embedding <=> query_embedding) AS similarity
  FROM public.skill_learnings
  WHERE skill_learnings.skill_uid = target_skill_uid
    AND 1 - (skill_learnings.embedding <=> query_embedding) > match_threshold
  ORDER BY skill_learnings.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 7. 注入定时触发器 (通过 pg_cron 每 30 分钟触发 Edge Function)
-- 注意: 请在 Supabase Dashbaord 或设置中配置好 pg_net 插件和 webhook url，这里给出一个标准的 cron 使用案例
-- SELECT cron.schedule(
--   'invoke-evolve-critic-every-30-min',
--   '*/30 * * * *',
--   $$
--   SELECT net.http_post(
--       url:='https://your-project-ref.supabase.co/functions/v1/evolve-critic',
--       headers:=jsonb_build_object('Content-Type', 'application/json', 'Authorization', current_setting('app.settings.service_role_key'))
--   );
--   $$
-- );

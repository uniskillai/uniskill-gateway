-- 1. 找到约束名并精准爆破 (如果不知道名字，可以用下面这条通用的)
ALTER TABLE public.skill_learnings 
DROP CONSTRAINT IF EXISTS skill_learnings_user_id_fkey;

ALTER TABLE public.skill_learnings 
DROP CONSTRAINT IF EXISTS skill_learnings_user_uid_fkey;

-- 2. 将 user_uid 设为可选（Nullable）
ALTER TABLE public.skill_learnings 
ALTER COLUMN user_uid DROP NOT NULL;

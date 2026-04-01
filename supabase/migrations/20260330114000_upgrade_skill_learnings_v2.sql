-- Migration: Upgrade skill_learnings to Dual-Vector schema (V2 - 1024d)
-- Description: Replace 'embedding' with 'input_embedding' and 'error_embedding', create bi-directional matching RPCs.
-- Note: Using 1024 dimensions as required by voyage-code-3.

-- 1. Alter the skill_learnings table
ALTER TABLE skill_learnings 
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS input_embedding,
  DROP COLUMN IF EXISTS error_embedding;

ALTER TABLE skill_learnings
  ADD COLUMN input_embedding vector(1024),
  ADD COLUMN error_embedding vector(1024);

-- 2. Drop existing RPCs to re-create with new dimensions
DROP FUNCTION IF EXISTS match_learnings_by_input;
DROP FUNCTION IF EXISTS match_learnings_by_error;

-- 3. Create the Input Matching RPC (Used by Gateway Interceptor)
CREATE OR REPLACE FUNCTION match_learnings_by_input(
  query_embedding vector(1024),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  skill_uid uuid,
  error_pattern text,
  solution_patch text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    skill_uid,
    error_pattern,
    solution_patch,
    1 - (skill_learnings.input_embedding <=> query_embedding) AS similarity
  FROM skill_learnings
  WHERE 1 - (skill_learnings.input_embedding <=> query_embedding) > match_threshold
  ORDER BY skill_learnings.input_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

-- 4. Create the Error Matching RPC (Used by Evolve Critic for Deduplication)
CREATE OR REPLACE FUNCTION match_learnings_by_error(
  query_embedding vector(1024),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id uuid,
  skill_uid uuid,
  error_pattern text,
  solution_patch text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    skill_uid,
    error_pattern,
    solution_patch,
    1 - (skill_learnings.error_embedding <=> query_embedding) AS similarity
  FROM skill_learnings
  WHERE 1 - (skill_learnings.error_embedding <=> query_embedding) > match_threshold
  ORDER BY skill_learnings.error_embedding <=> query_embedding ASC
  LIMIT match_count;
$$;

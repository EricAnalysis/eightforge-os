-- Enforce unique project code per organization.
-- The API route already handles error code 23505 with a 409 response;
-- this migration adds the DB constraint so that guard actually fires.

-- Step 1: Remove duplicate (organization_id, code) rows created before the
-- constraint existed. For each duplicate set, keep the oldest row (lowest
-- created_at) and delete the rest.
DELETE FROM public.projects
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY organization_id, code
        ORDER BY created_at ASC
      ) AS rn
    FROM public.projects
  ) ranked
  WHERE rn > 1
);

-- Step 2: Now that no duplicates exist, add the constraint.
ALTER TABLE public.projects
  ADD CONSTRAINT projects_org_code_unique UNIQUE (organization_id, code);

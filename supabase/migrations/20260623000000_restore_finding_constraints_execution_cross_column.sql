-- ============================================================
-- Phase B: Restore missing finding check constraints +
--          Add execution_items cross-column status/outcome constraint
-- ============================================================
-- MANDATORY PRE-CHECK — run these queries against production BEFORE applying
-- this migration. Each must return 0 rows. If any return rows, stop and report.
--
-- SELECT id, category FROM project_validation_findings
--   WHERE category NOT IN ('required_sources','identity_consistency','financial_integrity','ticket_integrity');
--
-- SELECT id, severity FROM project_validation_findings
--   WHERE severity NOT IN ('critical','warning','info');
--
-- SELECT id, status FROM project_validation_findings
--   WHERE status NOT IN ('open','resolved','dismissed','muted');
--
-- SELECT id, check_key, rule_id, subject_id FROM project_validation_findings
--   WHERE check_key != rule_id || ':' || subject_id;
--
-- SELECT id, status, outcome FROM execution_items
--   WHERE (status = 'open'       AND outcome IS NOT NULL)
--      OR (status = 'resolvable' AND outcome IS NOT NULL)
--      OR (status = 'resolved'   AND outcome NOT IN ('confirmed','resolved','overridden'));
-- ============================================================

DO $$
BEGIN

  -- --------------------------------------------------------
  -- 1. project_validation_findings_category_check
  --    Values emitted by all rule packs via shared.ts CATEGORY constants.
  --    Phase A confirmed this was absent despite being declared in
  --    20260401000000_project_validator_phase0_schema.sql.
  -- --------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_category_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_category_check
      CHECK (
        category IN (
          'required_sources',
          'identity_consistency',
          'financial_integrity',
          'ticket_integrity'
        )
      );
  END IF;

  -- --------------------------------------------------------
  -- 2. project_validation_findings_severity_check
  --    Matches ValidationSeverity type in types/validator.ts.
  -- --------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_severity_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_severity_check
      CHECK (severity IN ('critical', 'warning', 'info'));
  END IF;

  -- --------------------------------------------------------
  -- 3. project_validation_findings_status_check
  --    Matches FindingStatus write paths in persistValidationRun.ts
  --    and syncExecutionItems.ts (dismisses to 'dismissed').
  -- --------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_status_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_status_check
      CHECK (status IN ('open', 'resolved', 'dismissed', 'muted'));
  END IF;

  -- --------------------------------------------------------
  -- 4. project_validation_findings_check_key_format_check
  --    Enforces the canonical format emitted by shared.ts:695
  --    (buildFinding always sets check_key = ruleId:subjectId).
  --    HIGHEST RISK: run the check_key pre-check query above first.
  -- --------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_check_key_format_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_check_key_format_check
      CHECK (check_key = rule_id || ':' || subject_id);
  END IF;

  -- --------------------------------------------------------
  -- 5. execution_items cross-column status/outcome constraint
  --    Codifies the state machine in app/api/execution-items/[id]/outcome/route.ts
  --    and lib/execution/syncExecutionItems.ts:
  --      open       → outcome must be NULL
  --      resolvable → outcome must be NULL   (pending correction w/o canonical mutation)
  --      resolved   → outcome must be one of confirmed | resolved | overridden
  --    New constraint — not previously declared anywhere.
  -- --------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'execution_items'
      AND constraint_name = 'execution_items_status_outcome_pairing_check'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_status_outcome_pairing_check
      CHECK (
        (status IN ('open', 'resolvable') AND outcome IS NULL)
        OR
        (status = 'resolved' AND outcome IN ('confirmed', 'resolved', 'overridden'))
      );
  END IF;

END $$;

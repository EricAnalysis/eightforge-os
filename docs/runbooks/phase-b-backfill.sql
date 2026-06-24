-- ============================================================
-- Phase B: Zero-diff verification queries
-- Run against production BEFORE switching any reader to persisted columns.
-- Each section must return 0 rows before the reader switch is approved.
-- ============================================================

-- ============================================================
-- SECTION 0: Constraint pre-checks (run before applying
--   migration 20260623000000_restore_finding_constraints_execution_cross_column.sql)
-- ============================================================

-- 0a. category violations
SELECT id, category FROM project_validation_findings
WHERE category NOT IN ('required_sources','identity_consistency','financial_integrity','ticket_integrity');

-- 0b. severity violations
SELECT id, severity FROM project_validation_findings
WHERE severity NOT IN ('critical','warning','info');

-- 0c. status violations
SELECT id, status FROM project_validation_findings
WHERE status NOT IN ('open','resolved','dismissed','muted');

-- 0d. check_key format violations (highest risk — verify before adding constraint)
SELECT id, check_key, rule_id, subject_id,
       rule_id || ':' || subject_id AS expected_check_key
FROM project_validation_findings
WHERE check_key != rule_id || ':' || subject_id;

-- 0e. execution_items cross-column violations
SELECT id, status, outcome FROM execution_items
WHERE (status = 'open'       AND outcome IS NOT NULL)
   OR (status = 'resolvable' AND outcome IS NOT NULL)
   OR (status = 'resolved'   AND outcome NOT IN ('confirmed','resolved','overridden'));

-- ============================================================
-- SECTION 1: Constraint existence verification (run after applying
--   migration 20260623000000)
-- ============================================================

SELECT conname, conrelid::regclass
FROM pg_constraint
WHERE conrelid IN (
  'project_validation_findings'::regclass,
  'execution_items'::regclass
)
  AND contype = 'c'
  AND conname IN (
    'project_validation_findings_category_check',
    'project_validation_findings_severity_check',
    'project_validation_findings_status_check',
    'project_validation_findings_check_key_format_check',
    'execution_items_status_outcome_pairing_check'
  )
ORDER BY conrelid::regclass::text, conname;
-- Expected: 5 rows

-- ============================================================
-- SECTION 2: documents.operational_status zero-diff
-- Compare persisted value against canonical resolver output.
-- Run after migration 20260623000001 backfill completes.
-- ============================================================

SELECT
  d.id,
  d.processing_status,
  d.operational_status AS persisted,
  public.compute_document_operational_status_simple(
    d.processing_status,
    COALESCE(r.status, 'not_reviewed'),
    r.reviewed_at,
    d.processed_at
  ) AS derived
FROM documents d
LEFT JOIN LATERAL (
  SELECT status, reviewed_at
  FROM document_reviews
  WHERE document_id = d.id
  ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
  LIMIT 1
) r ON true
WHERE d.operational_status IS DISTINCT FROM
  public.compute_document_operational_status_simple(
    d.processing_status,
    COALESCE(r.status, 'not_reviewed'),
    r.reviewed_at,
    d.processed_at
  );
-- Expected: 0 rows

-- ============================================================
-- SECTION 3: project_validation_findings.lifecycle_state zero-diff
-- Focus on Williamson and Goodlettsville (named test projects).
-- Run after migration 20260623000002 backfill completes.
-- ============================================================

SELECT
  f.id,
  f.project_id,
  f.check_key,
  f.lifecycle_state AS persisted,
  public.compute_finding_lifecycle_state(
    f.status, f.severity, f.linked_decision_id,
    d.status, d.details, f.linked_action_id
  ) AS derived
FROM project_validation_findings f
LEFT JOIN decisions d ON d.id = f.linked_decision_id
WHERE f.project_id IN (
  SELECT id FROM projects WHERE code IN ('williamson', 'goodlettsville')
)
AND f.lifecycle_state IS DISTINCT FROM
  public.compute_finding_lifecycle_state(
    f.status, f.severity, f.linked_decision_id,
    d.status, d.details, f.linked_action_id
  );
-- Expected: 0 rows

-- ============================================================
-- SECTION 4: execution_items.queue_state zero-diff
-- Run after migration 20260623000003 backfill completes.
-- ============================================================

SELECT
  id, status, outcome, severity,
  queue_state AS persisted,
  public.compute_execution_item_queue_state(status, outcome, severity) AS derived
FROM execution_items
WHERE queue_state IS DISTINCT FROM
  public.compute_execution_item_queue_state(status, outcome, severity);
-- Expected: 0 rows

-- ============================================================
-- SECTION 5: Constraint rejection test (Phase C gate 4)
-- Verify the new constraints actually reject bad data.
-- Run in a transaction you roll back.
-- ============================================================

BEGIN;

-- Should fail with constraint violation:
INSERT INTO project_validation_findings (
  run_id, project_id, rule_id, check_key, category, severity, status,
  subject_type, subject_id
) VALUES (
  (SELECT id FROM project_validation_runs LIMIT 1),
  (SELECT id FROM projects LIMIT 1),
  'TEST_RULE', 'TEST_RULE:test-subject', 'NOT_A_VALID_CATEGORY',
  'critical', 'open', 'invoice', 'test-subject'
);

ROLLBACK;

BEGIN;

-- Should fail with constraint violation:
INSERT INTO execution_items (
  organization_id, project_id, source_type, source_id, source_key,
  severity, title, problem, impact, required_action, status, outcome
) VALUES (
  (SELECT id FROM organizations LIMIT 1),
  (SELECT id FROM projects LIMIT 1),
  'validator_finding', gen_random_uuid()::text, 'TEST:subject',
  'high', 'test', 'test', 'test', 'test', 'open', 'confirmed'  -- 'open' + non-null outcome violates pairing
);

ROLLBACK;

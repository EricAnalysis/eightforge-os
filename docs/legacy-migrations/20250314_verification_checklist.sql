-- ============================================================================
-- POST-MIGRATION VERIFICATION CHECKLIST
-- Run each query in the Supabase SQL Editor after applying migrations.
-- Each query should return rows confirming the schema is correct.
-- ============================================================================


-- 1. Verify documents columns
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'documents'
  AND column_name IN ('domain', 'document_type', 'source_type', 'mime_type',
                       'processing_status', 'processing_error', 'processed_at', 'file_path')
ORDER BY column_name;
-- EXPECT: 8 rows


-- 2. Verify documents processing_status check constraint
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'documents_processing_status_check';
-- EXPECT: 1 row


-- 3. Verify document_extractions new columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'document_extractions'
  AND column_name IN ('field_key', 'field_value_text', 'field_value_number',
                       'field_value_date', 'field_value_boolean', 'field_type',
                       'source', 'confidence', 'created_by', 'organization_id', 'status')
ORDER BY column_name;
-- EXPECT: 11 rows


-- 4. Verify document_extractions indexes
SELECT indexname FROM pg_indexes
WHERE tablename = 'document_extractions'
  AND indexname IN ('idx_document_extractions_document_id',
                    'idx_document_extractions_organization_id',
                    'idx_document_extractions_field_key',
                    'idx_document_extractions_doc_field');
-- EXPECT: 4 rows


-- 5. Verify document_fields table and unique index
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'document_fields'
ORDER BY ordinal_position;
-- EXPECT: 7 rows (id, domain, document_type, field_key, label, field_type, is_active, created_at)

SELECT indexname FROM pg_indexes
WHERE tablename = 'document_fields'
  AND indexname = 'idx_document_fields_domain_type_key';
-- EXPECT: 1 row


-- 6. Verify rules table, constraints, and indexes
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'rules'
ORDER BY ordinal_position;
-- EXPECT: 16 rows

SELECT constraint_name FROM information_schema.check_constraints
WHERE constraint_name IN ('rules_severity_check', 'rules_status_check');
-- EXPECT: 2 rows

SELECT indexname FROM pg_indexes
WHERE tablename = 'rules'
  AND indexname LIKE 'idx_rules_%';
-- EXPECT: 6 rows


-- 7. Verify decisions new columns and constraints
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'decisions'
  AND column_name IN ('rule_id', 'evidence', 'resolved_by');
-- EXPECT: 3 rows

SELECT constraint_name FROM information_schema.check_constraints
WHERE constraint_name IN ('decisions_severity_check', 'decisions_source_check', 'decisions_status_check');
-- EXPECT: 3 rows

SELECT indexname FROM pg_indexes
WHERE tablename = 'decisions'
  AND indexname LIKE 'idx_decisions_%';
-- EXPECT: 6+ rows


-- 8. Verify workflow_tasks extensions
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'workflow_tasks'
  AND column_name = 'completed_at';
-- EXPECT: 1 row

SELECT constraint_name FROM information_schema.check_constraints
WHERE constraint_name IN ('workflow_tasks_priority_check', 'workflow_tasks_status_check');
-- EXPECT: 2 rows


-- 9. Verify decision_feedback new columns
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'decision_feedback'
  AND column_name IN ('reviewer_id', 'correction_type', 'corrected_value');
-- EXPECT: 3 rows


-- 10. Verify signals table
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'signals'
ORDER BY ordinal_position;
-- EXPECT: 10 rows

SELECT constraint_name FROM information_schema.check_constraints
WHERE constraint_name IN ('signals_severity_check', 'signals_status_check');
-- EXPECT: 2 rows


-- 11. Verify updated_at trigger on rules
SELECT trigger_name FROM information_schema.triggers
WHERE event_object_table = 'rules' AND trigger_name = 'trg_rules_updated_at';
-- EXPECT: 1 row


-- 12. Verify foreign keys
SELECT constraint_name, table_name
FROM information_schema.table_constraints
WHERE constraint_type = 'FOREIGN KEY'
  AND constraint_name IN (
    'document_extractions_document_id_fkey',
    'decisions_document_id_fkey',
    'decisions_rule_id_fkey',
    'workflow_tasks_decision_id_fkey',
    'decision_feedback_decision_id_fkey'
  )
ORDER BY constraint_name;
-- EXPECT: 5 rows


-- 13. Verify RLS policies
SELECT tablename, policyname FROM pg_policies
WHERE policyname IN (
  'document_fields_select_authenticated',
  'rules_select_org',
  'signals_select_org'
);
-- EXPECT: 3 rows


-- 14. Verify seed data: document_fields counts
SELECT domain, document_type, count(*) as field_count
FROM public.document_fields
WHERE domain = 'debris_ops'
GROUP BY domain, document_type
ORDER BY document_type;
-- EXPECT: 5 rows (invoice=9, haul_ticket=8, ticket_export=10, project_contract=9, rate_table=7)


-- 15. Verify seed data: rules counts
SELECT domain, rule_group, count(*) as rule_count
FROM public.rules
WHERE domain = 'debris_ops'
GROUP BY domain, rule_group
ORDER BY rule_group;
-- EXPECT: 6 rows (compliance=3, duplicate_detection=1, rate_validation=2,
--         required_fields=4, threshold_validation=3, timeline_validation=2)
-- TOTAL: 15-16 rules


-- 16. Quick smoke test: load all active rules for a document type
SELECT id, name, decision_type, severity, priority
FROM public.rules
WHERE domain = 'debris_ops'
  AND document_type = 'invoice'
  AND status = 'active'
ORDER BY priority ASC;
-- EXPECT: ~8 rules for invoice type


-- ============================================================================
-- VERIFICATION COMPLETE
-- ============================================================================

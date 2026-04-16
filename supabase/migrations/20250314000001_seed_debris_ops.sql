-- ============================================================================
-- SEED: Deterministic Decision v1 — domain = 'debris_ops'
-- Purpose: Controlled field definitions + starter rules for debris operations
-- Idempotent: Uses ON CONFLICT DO NOTHING for fields, name-guard for rules
-- ============================================================================


-- ============================================================================
-- SECTION 1: Document Fields for debris_ops
-- ============================================================================

-- ---- invoice (11 fields) ----
INSERT INTO public.document_fields (domain, document_type, field_key, label, field_type) VALUES
  ('debris_ops', 'invoice', 'invoice_number',  'Invoice Number',   'text'),
  ('debris_ops', 'invoice', 'vendor_name',     'Vendor Name',      'text'),
  ('debris_ops', 'invoice', 'amount',          'Total Amount',     'number'),
  ('debris_ops', 'invoice', 'invoice_date',    'Invoice Date',     'date'),
  ('debris_ops', 'invoice', 'service_date',    'Service Date',     'date'),
  ('debris_ops', 'invoice', 'rate_code',       'Rate Code',        'text'),
  ('debris_ops', 'invoice', 'rate_amount',     'Rate Amount',      'number'),
  ('debris_ops', 'invoice', 'disposal_site',   'Disposal Site',    'text'),
  ('debris_ops', 'invoice', 'project_id',      'Project ID',       'text'),
  ('debris_ops', 'invoice', 'po_number',       'PO Number',        'text'),
  ('debris_ops', 'invoice', 'payment_terms',   'Payment Terms',    'text')
ON CONFLICT (domain, document_type, field_key) DO NOTHING;

-- ---- haul_ticket (10 fields) ----
INSERT INTO public.document_fields (domain, document_type, field_key, label, field_type) VALUES
  ('debris_ops', 'haul_ticket', 'ticket_number',  'Ticket Number',    'text'),
  ('debris_ops', 'haul_ticket', 'load_id',        'Load ID',          'text'),
  ('debris_ops', 'haul_ticket', 'disposal_site',  'Disposal Site',    'text'),
  ('debris_ops', 'haul_ticket', 'material',       'Material Type',    'text'),
  ('debris_ops', 'haul_ticket', 'haul_date',      'Haul Date',        'date'),
  ('debris_ops', 'haul_ticket', 'net_tonnage',    'Net Tonnage',      'number'),
  ('debris_ops', 'haul_ticket', 'cyd',            'Cubic Yards',      'number'),
  ('debris_ops', 'haul_ticket', 'service_item',   'Service Item',     'text'),
  ('debris_ops', 'haul_ticket', 'driver_name',    'Driver Name',      'text'),
  ('debris_ops', 'haul_ticket', 'truck_id',       'Truck ID',         'text')
ON CONFLICT (domain, document_type, field_key) DO NOTHING;

-- ---- ticket_export (10 fields) ----
INSERT INTO public.document_fields (domain, document_type, field_key, label, field_type) VALUES
  ('debris_ops', 'ticket_export', 'ticket_number',   'Ticket Number',    'text'),
  ('debris_ops', 'ticket_export', 'transaction_id',  'Transaction ID',   'text'),
  ('debris_ops', 'ticket_export', 'invoice_number',  'Invoice Number',   'text'),
  ('debris_ops', 'ticket_export', 'disposal_site',   'Disposal Site',    'text'),
  ('debris_ops', 'ticket_export', 'material',        'Material Type',    'text'),
  ('debris_ops', 'ticket_export', 'service_item',    'Service Item',     'text'),
  ('debris_ops', 'ticket_export', 'mileage',         'Mileage',          'number'),
  ('debris_ops', 'ticket_export', 'net_tonnage',     'Net Tonnage',      'number'),
  ('debris_ops', 'ticket_export', 'cyd',             'Cubic Yards',      'number'),
  ('debris_ops', 'ticket_export', 'haul_date',       'Haul Date',        'date')
ON CONFLICT (domain, document_type, field_key) DO NOTHING;

-- ---- project_contract (9 fields) ----
INSERT INTO public.document_fields (domain, document_type, field_key, label, field_type) VALUES
  ('debris_ops', 'project_contract', 'contract_number',        'Contract Number',        'text'),
  ('debris_ops', 'project_contract', 'vendor_name',            'Vendor Name',            'text'),
  ('debris_ops', 'project_contract', 'effective_date',         'Effective Date',         'date'),
  ('debris_ops', 'project_contract', 'expiration_date',        'Expiration Date',        'date'),
  ('debris_ops', 'project_contract', 'approved_disposal_site', 'Approved Disposal Site', 'text'),
  ('debris_ops', 'project_contract', 'rate_code',              'Rate Code',              'text'),
  ('debris_ops', 'project_contract', 'approved_rate_amount',   'Approved Rate Amount',   'number'),
  ('debris_ops', 'project_contract', 'rate_basis',             'Rate Basis',             'text'),
  ('debris_ops', 'project_contract', 'project_id',             'Project ID',             'text')
ON CONFLICT (domain, document_type, field_key) DO NOTHING;

-- ---- rate_table (7 fields) ----
INSERT INTO public.document_fields (domain, document_type, field_key, label, field_type) VALUES
  ('debris_ops', 'rate_table', 'rate_code',            'Rate Code',            'text'),
  ('debris_ops', 'rate_table', 'rate_description',     'Rate Description',     'text'),
  ('debris_ops', 'rate_table', 'approved_rate_amount', 'Approved Rate Amount', 'number'),
  ('debris_ops', 'rate_table', 'rate_basis',           'Rate Basis',           'text'),
  ('debris_ops', 'rate_table', 'effective_date',       'Effective Date',       'date'),
  ('debris_ops', 'rate_table', 'expiration_date',      'Expiration Date',      'date'),
  ('debris_ops', 'rate_table', 'project_id',           'Project ID',           'text')
ON CONFLICT (domain, document_type, field_key) DO NOTHING;


-- ============================================================================
-- SECTION 2: Starter Rules for debris_ops (18 rules)
-- ============================================================================
-- Guard: skip insert if a rule with the same name already exists.
-- This keeps the seed idempotent without requiring a unique constraint on name.

-- --------------------------------------------------------------------------
-- Rule Group: required_fields (4 rules)
-- --------------------------------------------------------------------------

-- R01: Invoice missing invoice number
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'required_fields',
       'Invoice missing invoice number',
       'Invoices must have an invoice number for tracking and reconciliation.',
       'missing_field', 'high', 10, 'active',
       '{"match_type":"all","conditions":[{"field_key":"invoice_number","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_missing_field","assign_to_role":"audit_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice missing invoice number' AND domain = 'debris_ops');

-- R02: Invoice missing vendor name
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'required_fields',
       'Invoice missing vendor name',
       'Invoices must identify the vendor for payment processing.',
       'missing_field', 'high', 10, 'active',
       '{"match_type":"all","conditions":[{"field_key":"vendor_name","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_missing_field","assign_to_role":"audit_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice missing vendor name' AND domain = 'debris_ops');

-- R03: Haul ticket missing ticket number
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'haul_ticket', 'required_fields',
       'Haul ticket missing ticket number',
       'Every haul load must have a ticket number for audit trail.',
       'missing_field', 'high', 10, 'active',
       '{"match_type":"all","conditions":[{"field_key":"ticket_number","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_missing_field","assign_to_role":"audit_queue","due_in_hours":12}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Haul ticket missing ticket number' AND domain = 'debris_ops');

-- R04: Haul ticket missing disposal site
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'haul_ticket', 'required_fields',
       'Haul ticket missing disposal site',
       'Disposal site is required for FEMA eligibility and compliance documentation.',
       'missing_field', 'critical', 5, 'active',
       '{"match_type":"all","conditions":[{"field_key":"disposal_site","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_compliance_gap","assign_to_role":"compliance_queue","due_in_hours":8}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Haul ticket missing disposal site' AND domain = 'debris_ops');


-- --------------------------------------------------------------------------
-- Rule Group: threshold_validation (3 rules)
-- --------------------------------------------------------------------------

-- R05: Invoice amount exceeds $50,000
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'threshold_validation',
       'Invoice amount exceeds $50,000',
       'High-value invoices require senior review before payment authorization.',
       'over_threshold', 'high', 20, 'active',
       '{"match_type":"all","conditions":[{"field_key":"amount","operator":"greater_than","value":50000}]}'::jsonb,
       '{"create_task":true,"task_type":"review_high_value_invoice","assign_to_role":"senior_review","due_in_hours":48}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice amount exceeds $50,000' AND domain = 'debris_ops');

-- R06: Invoice amount exceeds $250,000
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'threshold_validation',
       'Invoice amount exceeds $250,000',
       'Very high-value invoices require executive approval.',
       'over_threshold', 'critical', 5, 'active',
       '{"match_type":"all","conditions":[{"field_key":"amount","operator":"greater_than","value":250000}]}'::jsonb,
       '{"create_task":true,"task_type":"review_executive_approval","assign_to_role":"executive_review","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice amount exceeds $250,000' AND domain = 'debris_ops');

-- R07: Haul ticket tonnage exceeds 30 tons
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'haul_ticket', 'threshold_validation',
       'Haul ticket tonnage exceeds 30 tons',
       'Unusually heavy single loads may indicate scale errors or load splitting issues.',
       'over_threshold', 'medium', 50, 'active',
       '{"match_type":"all","conditions":[{"field_key":"net_tonnage","operator":"greater_than","value":30}]}'::jsonb,
       '{"create_task":true,"task_type":"verify_tonnage","assign_to_role":"audit_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Haul ticket tonnage exceeds 30 tons' AND domain = 'debris_ops');


-- --------------------------------------------------------------------------
-- Rule Group: rate_validation (3 rules)
-- --------------------------------------------------------------------------

-- R08: Invoice rate exceeds $100 per unit
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'rate_validation',
       'Invoice rate exceeds $100 per unit',
       'Unit rates above $100 should be verified against the approved rate table.',
       'rate_mismatch', 'high', 30, 'active',
       '{"match_type":"all","conditions":[{"field_key":"rate_amount","operator":"greater_than","value":100}]}'::jsonb,
       '{"create_task":true,"task_type":"review_rate_issue","assign_to_role":"audit_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice rate exceeds $100 per unit' AND domain = 'debris_ops');

-- R09: Invoice rate suspiciously low
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'rate_validation',
       'Invoice rate suspiciously low',
       'Rates below $2 per unit are likely data entry errors.',
       'rate_mismatch', 'medium', 40, 'active',
       '{"match_type":"all","conditions":[{"field_key":"rate_amount","operator":"less_than","value":2}]}'::jsonb,
       '{"create_task":true,"task_type":"review_rate_issue","assign_to_role":"audit_queue","due_in_hours":48}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice rate suspiciously low' AND domain = 'debris_ops');

-- R10: Contract approved rate exceeds $150
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'project_contract', 'rate_validation',
       'Contract approved rate exceeds $150',
       'Approved rates above $150 per unit are abnormal for debris ops and require review.',
       'rate_mismatch', 'high', 25, 'active',
       '{"match_type":"all","conditions":[{"field_key":"approved_rate_amount","operator":"greater_than","value":150}]}'::jsonb,
       '{"create_task":true,"task_type":"review_rate_issue","assign_to_role":"senior_review","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Contract approved rate exceeds $150' AND domain = 'debris_ops');


-- --------------------------------------------------------------------------
-- Rule Group: duplicate_detection (2 rules)
-- --------------------------------------------------------------------------

-- R11: Invoice with amount but no PO reference
-- (proxy for duplicate risk — invoices without PO are harder to reconcile)
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'duplicate_detection',
       'Invoice missing PO number',
       'Invoices without a purchase order reference are at higher risk of duplicate payment.',
       'duplicate_document', 'high', 15, 'active',
       '{"match_type":"all","conditions":[{"field_key":"amount","operator":"greater_than","value":0},{"field_key":"po_number","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_duplicate","assign_to_role":"audit_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice missing PO number' AND domain = 'debris_ops');

-- R12: Ticket export missing transaction ID
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'ticket_export', 'duplicate_detection',
       'Ticket export missing transaction ID',
       'Ticket exports without a transaction ID cannot be deduplicated reliably.',
       'duplicate_document', 'high', 15, 'active',
       '{"match_type":"all","conditions":[{"field_key":"transaction_id","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_duplicate","assign_to_role":"audit_queue","due_in_hours":12}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Ticket export missing transaction ID' AND domain = 'debris_ops');


-- --------------------------------------------------------------------------
-- Rule Group: timeline_validation (2 rules)
-- --------------------------------------------------------------------------

-- R13: Invoice missing service date
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'invoice', 'timeline_validation',
       'Invoice missing service date',
       'Invoices without a service date cannot be validated against haul ticket timelines.',
       'timeline_violation', 'medium', 60, 'active',
       '{"match_type":"all","conditions":[{"field_key":"service_date","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_timeline","assign_to_role":"audit_queue","due_in_hours":48}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Invoice missing service date' AND domain = 'debris_ops');

-- R14: Contract missing expiration date
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'project_contract', 'timeline_validation',
       'Contract missing expiration date',
       'Contracts without an expiration date may allow unbounded billing.',
       'timeline_violation', 'high', 20, 'active',
       '{"match_type":"all","conditions":[{"field_key":"expiration_date","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_contract_terms","assign_to_role":"compliance_queue","due_in_hours":24}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Contract missing expiration date' AND domain = 'debris_ops');


-- --------------------------------------------------------------------------
-- Rule Group: compliance (4 rules)
-- --------------------------------------------------------------------------

-- R15: Haul ticket missing material type
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'haul_ticket', 'compliance',
       'Haul ticket missing material type',
       'Material classification is required for FEMA eligibility documentation.',
       'compliance_flag', 'high', 15, 'active',
       '{"match_type":"all","conditions":[{"field_key":"material","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_compliance_gap","assign_to_role":"compliance_queue","due_in_hours":12}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Haul ticket missing material type' AND domain = 'debris_ops');

-- R16: Contract missing approved disposal site
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'project_contract', 'compliance',
       'Contract missing approved disposal site',
       'Approved disposal sites must be listed for FEMA reimbursement eligibility.',
       'compliance_flag', 'critical', 5, 'active',
       '{"match_type":"all","conditions":[{"field_key":"approved_disposal_site","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_compliance_gap","assign_to_role":"compliance_queue","due_in_hours":8}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Contract missing approved disposal site' AND domain = 'debris_ops');

-- R17: Ticket export missing invoice reference
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'ticket_export', 'compliance',
       'Ticket export missing invoice reference',
       'Ticket exports without an invoice number cannot be reconciled against billing.',
       'compliance_flag', 'medium', 40, 'active',
       '{"match_type":"all","conditions":[{"field_key":"invoice_number","operator":"not_exists","value":null}]}'::jsonb,
       '{"create_task":true,"task_type":"review_reconciliation_gap","assign_to_role":"audit_queue","due_in_hours":48}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Ticket export missing invoice reference' AND domain = 'debris_ops');

-- R18: Ticket export with excessive mileage
INSERT INTO public.rules (domain, document_type, rule_group, name, description, decision_type, severity, priority, status, condition_json, action_json)
SELECT 'debris_ops', 'ticket_export', 'compliance',
       'Ticket export mileage exceeds 100 miles',
       'Haul distances over 100 miles are unusual and may indicate routing to a non-approved site.',
       'compliance_flag', 'high', 25, 'active',
       '{"match_type":"all","conditions":[{"field_key":"mileage","operator":"greater_than","value":100}]}'::jsonb,
       '{"create_task":true,"task_type":"review_compliance_gap","assign_to_role":"compliance_queue","due_in_hours":12}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.rules WHERE name = 'Ticket export mileage exceeds 100 miles' AND domain = 'debris_ops');


-- ============================================================================
-- SEED COMPLETE: debris_ops domain
-- 47 document_fields across 5 document types
--   invoice: 11 | haul_ticket: 10 | ticket_export: 10
--   project_contract: 9 | rate_table: 7
-- 18 starter rules across 6 rule groups
--   required_fields: 4 | threshold_validation: 3 | rate_validation: 3
--   duplicate_detection: 2 | timeline_validation: 2 | compliance: 4
-- ============================================================================

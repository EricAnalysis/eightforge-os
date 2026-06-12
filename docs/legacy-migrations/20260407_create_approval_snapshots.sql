-- Migration: 20260407_create_approval_snapshots.sql
-- Purpose: Create approval decision snapshot tables for audit trails and regression detection

-- Project-level approval snapshots
CREATE TABLE IF NOT EXISTS project_approval_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('approved', 'approved_with_exceptions', 'needs_review', 'blocked', 'not_evaluated')),

  -- Financial totals at snapshot time
  total_billed DECIMAL(12, 2),
  total_supported DECIMAL(12, 2),
  at_risk_amount DECIMAL(12, 2),
  blocked_amount DECIMAL(12, 2),

  -- Invoice counts by status
  invoice_count INT NOT NULL DEFAULT 0,
  blocked_invoice_count INT NOT NULL DEFAULT 0,
  needs_review_invoice_count INT NOT NULL DEFAULT 0,
  approved_invoice_count INT NOT NULL DEFAULT 0,

  -- Audit trail details
  finding_ids TEXT[] DEFAULT '{}', -- Array of decision IDs causing blockers
  billing_group_ids TEXT[], -- Billing groups affected
  validation_trigger_source TEXT, -- Source that triggered validation

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Indexes
  UNIQUE(project_id, created_at), -- One snapshot per project per second (approximately)
  INDEX idx_project_approval_snapshots_project_id (project_id),
  INDEX idx_project_approval_snapshots_created_at (created_at DESC)
);

-- Per-invoice approval snapshots
CREATE TABLE IF NOT EXISTS invoice_approval_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Invoice identity
  invoice_number TEXT,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('approved', 'approved_with_exceptions', 'needs_review', 'blocked')),

  -- Financial state
  billed_amount DECIMAL(12, 2),
  supported_amount DECIMAL(12, 2),
  at_risk_amount DECIMAL(12, 2),
  reconciliation_status TEXT,

  -- Reasons and context
  blocking_reasons TEXT[] DEFAULT '{}',
  billing_group_ids TEXT[],

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Indexes for queries
  INDEX idx_invoice_approval_snapshots_project_id (project_id),
  INDEX idx_invoice_approval_snapshots_created_at (created_at DESC),
  INDEX idx_invoice_approval_snapshots_invoice_number (invoice_number)
);

-- Create index for efficient diffs (get snapshots within date range)
CREATE INDEX idx_project_approval_snapshots_created_at_desc
ON project_approval_snapshots(project_id, created_at DESC);

CREATE INDEX idx_invoice_approval_snapshots_created_at_desc
ON invoice_approval_snapshots(project_id, created_at DESC);

-- Grant permissions (adjust as needed for your auth model)
ALTER TABLE project_approval_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_approval_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can only see snapshots for projects they have access to
-- (Assumes you have a projects table with appropriate RLS)
CREATE POLICY "Users can view project approval snapshots"
ON project_approval_snapshots
FOR SELECT
USING (project_id IN (SELECT id FROM projects WHERE organization_id = auth.jwt() -> 'org_id'));

CREATE POLICY "Users can view invoice approval snapshots"
ON invoice_approval_snapshots
FOR SELECT
USING (project_id IN (SELECT id FROM projects WHERE organization_id = auth.jwt() -> 'org_id'));

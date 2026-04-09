/**
 * lib/server/approvalSnapshots.ts
 * Approval decision persistence layer for audit trails and regression detection.
 * Captures project and invoice-level approval states as immutable snapshots.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type {
  ProjectOperationalRollup,
  ProjectValidatorSummarySnapshot,
  ProjectOverviewInvoiceItem,
} from '@/lib/projectOverview';

/**
 * Project-level approval snapshot
 * Records the complete approval state at a point in time.
 */
export type ProjectApprovalSnapshot = {
  id?: string;
  project_id: string;
  approval_status: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked' | 'not_evaluated';
  total_billed: number | null;
  total_supported: number | null;
  at_risk_amount: number | null;
  blocked_amount: number | null;
  invoice_count: number;
  blocked_invoice_count: number;
  needs_review_invoice_count: number;
  approved_invoice_count: number;
  finding_ids: string[];
  billing_group_ids: string[] | null;
  validation_trigger_source: string | null;
  created_at: string;
};

/**
 * Per-invoice approval snapshot
 * Records the approval state for a single invoice.
 */
export type InvoiceApprovalSnapshot = {
  id?: string;
  project_id: string;
  invoice_number: string | null;
  approval_status: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked';
  billed_amount: number | null;
  supported_amount: number | null;
  at_risk_amount: number | null;
  reconciliation_status: string;
  blocking_reasons: string[];
  billing_group_ids: string[] | null;
  created_at: string;
};

/**
 * Diff of two approval snapshots
 * Identifies what changed between two points in time.
 */
export type ApprovalSnapshotDiff = {
  approval_status_changed: boolean;
  total_billed_changed: number | null; // delta
  blocked_amount_changed: number | null; // delta
  at_risk_amount_changed: number | null; // delta
  invoice_count_changed: number; // delta
  blocked_invoice_count_changed: number; // delta
  needs_review_invoice_count_changed: number; // delta
  new_blocking_reasons: string[];
  resolved_blocking_reasons: string[];
};

/**
 * Persist a new approval snapshot when validation completes
 * Appends to history without overwriting previous snapshots (audit trail)
 */
export async function persistApprovalSnapshot(
  projectId: string,
  validatorSummary: ProjectValidatorSummarySnapshot | null,
  rollup: ProjectOperationalRollup,
): Promise<ProjectApprovalSnapshot | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // Compute project-level snapshot from validator summary + rollup
  const approvalStatus = rollup.status.label as any;
  const invoices = validatorSummary?.invoice_summaries || [];

  // Count invoices by status
  const blockedCount = invoices.filter((i) => i.approval_status === 'blocked').length;
  const needsReviewCount = invoices.filter((i) => i.approval_status === 'needs_review').length;
  const approvedCount = invoices.filter((i) =>
    i.approval_status === 'approved' || i.approval_status === 'approved_with_exceptions'
  ).length;

  // Compute totals
  const totalBilled = invoices.reduce((sum, i) => sum + (i.billed_amount ?? 0), 0);
  const totalSupported = invoices.reduce((sum, i) => sum + (i.supported_amount ?? 0), 0);

  // Extract finding IDs from rollup pending actions (use action id as finding reference)
  const findingIds = rollup.pending_actions.map((action) => action.id);

  const snapshot: ProjectApprovalSnapshot = {
    project_id: projectId,
    approval_status: approvalStatus,
    total_billed: totalBilled > 0 ? totalBilled : null,
    total_supported: totalSupported > 0 ? totalSupported : null,
    at_risk_amount: validatorSummary?.total_at_risk ?? null,
    blocked_amount: validatorSummary?.blocked_amount ?? null,
    invoice_count: invoices.length,
    blocked_invoice_count: blockedCount,
    needs_review_invoice_count: needsReviewCount,
    approved_invoice_count: approvedCount,
    finding_ids: findingIds,
    billing_group_ids: null, // TODO: extract from invoice details if available
    validation_trigger_source: validatorSummary?.trigger_source ?? null,
    created_at: new Date().toISOString(),
  };

  // Insert project snapshot
  const { data: projectSnapshotData, error: projectError } = await admin
    .from('project_approval_snapshots')
    .insert(snapshot)
    .select()
    .single();

  if (projectError || !projectSnapshotData) {
    console.error('[approvalSnapshots] Failed to persist project snapshot:', projectError);
    return null;
  }

  // Insert per-invoice snapshots
  const invoiceSnapshots: InvoiceApprovalSnapshot[] = invoices.map((invoice) => ({
    project_id: projectId,
    invoice_number: invoice.invoice_number,
    approval_status: invoice.approval_status,
    billed_amount: invoice.billed_amount,
    supported_amount: invoice.supported_amount,
    at_risk_amount: invoice.at_risk_amount,
    reconciliation_status: invoice.reconciliation_status,
    blocking_reasons: [], // TODO: extract from intelligence trace if available
    billing_group_ids: null, // TODO: extract from invoice details if available
    created_at: new Date().toISOString(),
  }));

  if (invoiceSnapshots.length > 0) {
    const { error: invoicesError } = await admin
      .from('invoice_approval_snapshots')
      .insert(invoiceSnapshots);

    if (invoicesError) {
      console.error('[approvalSnapshots] Failed to persist invoice snapshots:', invoicesError);
      // Still return project snapshot even if invoice insert fails
    }
  }

  return projectSnapshotData as ProjectApprovalSnapshot;
}

/**
 * Retrieve the latest approval snapshot for a project
 */
export async function getLatestApprovalSnapshot(
  projectId: string,
): Promise<ProjectApprovalSnapshot | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('project_approval_snapshots')
    .select()
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as ProjectApprovalSnapshot;
}

/**
 * Retrieve approval history for a project
 * Returns snapshots in reverse chronological order (newest first)
 */
export async function getApprovalHistory(
  projectId: string,
  limit: number = 50,
): Promise<ProjectApprovalSnapshot[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from('project_approval_snapshots')
    .select()
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as ProjectApprovalSnapshot[];
}

/**
 * Retrieve invoice snapshots for a specific project snapshot
 */
export async function getInvoiceSnapshotsAt(
  projectId: string,
  createdAt: string,
): Promise<InvoiceApprovalSnapshot[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  // Get all invoice snapshots created at or before this timestamp
  // In a real implementation, you might associate snapshots by ID instead
  const { data, error } = await admin
    .from('invoice_approval_snapshots')
    .select()
    .eq('project_id', projectId)
    .lte('created_at', createdAt)
    .order('created_at', { ascending: false })
    .limit(100); // Get enough to find the right snapshot set

  if (error || !data) return [];

  // Filter to only invoices created at this exact timestamp (or use snapshot ID association)
  return data.filter((invoice) => invoice.created_at === createdAt) as InvoiceApprovalSnapshot[];
}

/**
 * Compare two approval snapshots to identify what changed
 */
export function compareApprovalSnapshots(
  previous: ProjectApprovalSnapshot | null,
  current: ProjectApprovalSnapshot,
): ApprovalSnapshotDiff {
  if (!previous) {
    // No previous snapshot - all values are "new"
    return {
      approval_status_changed: true,
      total_billed_changed: current.total_billed ?? 0,
      blocked_amount_changed: current.blocked_amount ?? 0,
      at_risk_amount_changed: current.at_risk_amount ?? 0,
      invoice_count_changed: current.invoice_count,
      blocked_invoice_count_changed: current.blocked_invoice_count,
      needs_review_invoice_count_changed: current.needs_review_invoice_count,
      new_blocking_reasons: [],
      resolved_blocking_reasons: [],
    };
  }

  return {
    approval_status_changed: previous.approval_status !== current.approval_status,
    total_billed_changed:
      (current.total_billed ?? 0) - (previous.total_billed ?? 0) || null,
    blocked_amount_changed:
      (current.blocked_amount ?? 0) - (previous.blocked_amount ?? 0) || null,
    at_risk_amount_changed:
      (current.at_risk_amount ?? 0) - (previous.at_risk_amount ?? 0) || null,
    invoice_count_changed: current.invoice_count - previous.invoice_count,
    blocked_invoice_count_changed:
      current.blocked_invoice_count - previous.blocked_invoice_count,
    needs_review_invoice_count_changed:
      current.needs_review_invoice_count - previous.needs_review_invoice_count,
    new_blocking_reasons: current.finding_ids.filter(
      (id) => !previous.finding_ids.includes(id),
    ),
    resolved_blocking_reasons: previous.finding_ids.filter(
      (id) => !current.finding_ids.includes(id),
    ),
  };
}

/**
 * Derive approval status from invoice summaries (helper for snapshot creation)
 */
export function deriveProjectApprovalStatus(
  invoices: ProjectOverviewInvoiceItem[],
): ProjectApprovalSnapshot['approval_status'] {
  if (invoices.length === 0) return 'not_evaluated';

  const hasBlocked = invoices.some((i) => i.approval_status === 'blocked');
  if (hasBlocked) return 'blocked';

  const hasNeedsReview = invoices.some((i) => i.approval_status === 'needs_review');
  if (hasNeedsReview) return 'needs_review';

  const hasExceptions = invoices.some((i) => i.approval_status === 'approved_with_exceptions');
  if (hasExceptions) return 'approved_with_exceptions';

  return 'approved';
}

/**
 * lib/server/approvalEnforcement.ts
 * Approval gate enforcement: blocks downstream actions when projects/invoices are in blocked/needs_review state.
 *
 * CRITICAL: Fail-closed for destructive/money-moving actions (delete, export, approve, pay)
 *           Fail-open for read-only actions (view, list)
 *
 * Enforcement order:
 * 1. Check project approval first (if blocked, everything is blocked)
 * 2. Then check invoice approval (only matters if project is not blocked)
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  getLatestApprovalSnapshot,
  type ProjectApprovalSnapshot,
  type InvoiceApprovalSnapshot,
} from '@/lib/server/approvalSnapshots';

/**
 * Result type for approval checks
 * 'allowed': proceed with action
 * 'blocked': action is blocked by approval policy (project or invoice)
 * 'unknown': cannot determine approval status (fail-closed for destructive actions)
 */
export type ApprovalCheckResult =
  | { status: 'allowed'; snapshot: ProjectApprovalSnapshot | InvoiceApprovalSnapshot | null }
  | { status: 'blocked'; snapshot: ProjectApprovalSnapshot | InvoiceApprovalSnapshot; reason: string }
  | { status: 'unknown'; error: string };

/**
 * Check whether a project can proceed with an action (export, delete, etc.)
 *
 * Returns three states:
 * - 'allowed': proceed
 * - 'blocked': project is blocked/needs_review
 * - 'unknown': cannot determine (caller decides fail-open or fail-closed)
 *
 * For read-only: treat 'unknown' as 'allowed'
 * For destructive (delete, export): treat 'unknown' as 409 Conflict or 503 Service Unavailable
 */
export async function canProjectProceed(projectId: string): Promise<ApprovalCheckResult> {
  try {
    const snapshot = await getLatestApprovalSnapshot(projectId);

    // No snapshot yet: allow action (backward compat, new projects)
    if (!snapshot) {
      return { status: 'allowed', snapshot: null };
    }

    // If blocked: deny action
    if (snapshot.approval_status === 'blocked') {
      return {
        status: 'blocked',
        snapshot,
        reason: `Project is blocked. ${snapshot.blocked_amount ? `Blocked amount: $${(snapshot.blocked_amount / 100).toFixed(2)}` : ''}`,
      };
    }

    // If needs_review: deny action (approval pending)
    if (snapshot.approval_status === 'needs_review') {
      return {
        status: 'blocked',
        snapshot,
        reason: `Project requires review before proceeding. ${snapshot.needs_review_invoice_count} invoices need attention.`,
      };
    }

    // Otherwise allow
    return { status: 'allowed', snapshot };
  } catch (error) {
    console.error('[approvalEnforcement] canProjectProceed failed:', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail-closed: return 'unknown' so destructive actions return 503
    return {
      status: 'unknown',
      error: 'Could not determine approval status. Try again shortly.',
    };
  }
}

/**
 * Check whether an invoice can proceed with an action (approve, pay, etc.)
 *
 * ENFORCEMENT ORDER (critical):
 * 1. If project is blocked → invoice is blocked (even if invoice snapshot is approved)
 * 2. If project is not blocked → check invoice snapshot
 *
 * Returns three states:
 * - 'allowed': proceed
 * - 'blocked': invoice or project is blocked/needs_review
 * - 'unknown': cannot determine (fail-closed for destructive actions)
 */
export async function canInvoiceProceed(projectId: string, invoiceNumber: string): Promise<ApprovalCheckResult> {
  try {
    // Step 1: Check project approval FIRST (project block overrides everything)
    const projectResult = await canProjectProceed(projectId);
    if (projectResult.status === 'blocked') {
      // Project is blocked, so invoice is blocked too
      return {
        status: 'blocked',
        snapshot: projectResult.snapshot,
        reason: `Cannot approve invoice: ${projectResult.reason}`,
      };
    }
    if (projectResult.status === 'unknown') {
      // Can't determine project status, fail-closed
      return projectResult;
    }

    // Step 2: Project is allowed, now check invoice
    const admin = getSupabaseAdmin();
    if (!admin) {
      // Admin client unavailable, can't check
      return {
        status: 'unknown',
        error: 'Server not configured. Try again shortly.',
      };
    }

    const { data, error } = await admin
      .from('invoice_approval_snapshots')
      .select()
      .eq('project_id', projectId)
      .eq('invoice_number', invoiceNumber)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      // No invoice snapshot yet: allow action
      return { status: 'allowed', snapshot: null };
    }

    const snapshot = data as InvoiceApprovalSnapshot;

    // If invoice is blocked or needs_review: deny action
    if (snapshot.approval_status === 'blocked') {
      return {
        status: 'blocked',
        snapshot,
        reason: `Invoice ${invoiceNumber} is blocked. ${snapshot.at_risk_amount ? `At-risk amount: $${(snapshot.at_risk_amount / 100).toFixed(2)}` : ''}`,
      };
    }

    if (snapshot.approval_status === 'needs_review') {
      return {
        status: 'blocked',
        snapshot,
        reason: `Invoice ${invoiceNumber} requires review before approval.`,
      };
    }

    // Otherwise allow
    return { status: 'allowed', snapshot };
  } catch (error) {
    console.error('[approvalEnforcement] canInvoiceProceed failed:', {
      projectId,
      invoiceNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail-closed for destructive actions
    return {
      status: 'unknown',
      error: 'Could not determine approval status. Try again shortly.',
    };
  }
}

/**
 * Get the latest approval snapshot for a project (used by UI components)
 */
export async function getProjectApprovalStatus(
  projectId: string,
): Promise<ProjectApprovalSnapshot | null> {
  try {
    return await getLatestApprovalSnapshot(projectId);
  } catch (error) {
    console.error('[approvalEnforcement] getProjectApprovalStatus failed:', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get the latest approval snapshot for a specific invoice (used by UI components)
 */
export async function getInvoiceApprovalStatus(
  projectId: string,
  invoiceNumber: string,
): Promise<InvoiceApprovalSnapshot | null> {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return null;

    const { data, error } = await admin
      .from('invoice_approval_snapshots')
      .select()
      .eq('project_id', projectId)
      .eq('invoice_number', invoiceNumber)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return data as InvoiceApprovalSnapshot;
  } catch (error) {
    console.error('[approvalEnforcement] getInvoiceApprovalStatus failed:', {
      projectId,
      invoiceNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Create a 409 Conflict response when action is blocked by approval status
 * Returns structured error with reason and optional blocked_amount
 */
export function createApprovalBlockResponse(
  reason: string,
  blockedAmount?: number,
): Response {
  const body = {
    error: 'Approval gate: action blocked',
    reason,
    blocked_amount: blockedAmount ?? null,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 409,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Extract blocking reasons from snapshot for UI display
 * Returns top 2-3 reasons
 */
export function getBlockingReasons(snapshot: ProjectApprovalSnapshot | InvoiceApprovalSnapshot): string[] {
  if (!snapshot) return [];

  const reasons: string[] = [];

  // For invoice snapshots, use blocking_reasons directly
  if ('blocking_reasons' in snapshot && snapshot.blocking_reasons?.length > 0) {
    return snapshot.blocking_reasons.slice(0, 3);
  }

  // For project snapshots, construct from approval_status
  if (snapshot.approval_status === 'blocked') {
    reasons.push('Project or invoices are blocked');
  }
  if (snapshot.approval_status === 'needs_review') {
    if ('needs_review_invoice_count' in snapshot && snapshot.needs_review_invoice_count > 0) {
      reasons.push(`${snapshot.needs_review_invoice_count} invoice(s) need review`);
    }
  }

  return reasons.length > 0 ? reasons : ['Approval required'];
}

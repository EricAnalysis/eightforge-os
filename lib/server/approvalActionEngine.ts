/**
 * lib/server/approvalActionEngine.ts
 * Phase 10: Operator Graph execution engine.
 *
 * Converts approval snapshots into deterministic workflow tasks.
 * Triggered after validation completes, approval snapshot is created, or
 * reconciliation state changes.
 *
 * ENFORCEMENT ORDER (mirrors approvalEnforcement.ts):
 *   blocked              → requires_verification_review (per invoice) + flag_project + notify_operator
 *   needs_review         → needs_review_queue (per invoice) + assign_analyst
 *   approved_with_exceptions → needs_review_queue + assign_analyst (same as needs_review)
 *   approved             → mark_project_ready + generate_approval_log
 *   not_evaluated        → no actions
 *
 * CRITICAL:
 *   - No external integrations. Internal task creation only.
 *   - Does not throw. All errors collected in ApprovalActionResult.errors.
 *   - Deterministic: same snapshot always produces same action plan.
 *   - Idempotent: re-running for the same project + status updates existing tasks, not duplicates.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  getLatestApprovalSnapshot,
  type ProjectApprovalSnapshot,
  type InvoiceApprovalSnapshot,
} from '@/lib/server/approvalSnapshots';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalActionType =
  | 'requires_verification_review'
  | 'flag_project'
  | 'notify_operator'
  | 'needs_review_queue'
  | 'assign_analyst'
  | 'mark_project_ready'
  | 'generate_approval_log';

/**
 * A single planned action produced by the approval engine.
 * The shape is invariant — same across all action types.
 */
export type ApprovalAction = {
  action_type: ApprovalActionType;
  project_id: string;
  /** null for project-level actions; set for invoice-level actions */
  invoice_number: string | null;
  /** Amount in cents. null when not applicable. */
  amount: number | null;
  reason: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
};

export type ApprovalActionResult = {
  project_id: string;
  approval_status: string;
  actions_planned: ApprovalAction[];
  tasks_created: number;
  tasks_updated: number;
  errors: string[];
  executed_at: string;
};

export type ExecuteApprovalActionsParams = {
  projectId: string;
  organizationId: string;
  /**
   * Pass snapshot directly to avoid an extra query.
   * Useful when calling right after persistApprovalSnapshot().
   */
  snapshot?: ProjectApprovalSnapshot | null;
  /**
   * Pass invoice snapshots if available to avoid an extra query.
   */
  invoiceSnapshots?: InvoiceApprovalSnapshot[];
};

// Internal task upsert result
type TaskUpsertOutcome =
  | { ok: true; task_id: string; action: 'created' | 'updated' }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action planning — pure, deterministic, no DB calls
// ---------------------------------------------------------------------------

/**
 * Map a project approval snapshot to a list of planned actions.
 *
 * Pure function: no side effects, no async, fully testable.
 * Invoice snapshots are used to create per-invoice tasks; when none are
 * provided a single project-level task is created instead.
 */
export function planApprovalActions(
  snapshot: ProjectApprovalSnapshot,
  invoiceSnapshots: InvoiceApprovalSnapshot[] = [],
): ApprovalAction[] {
  const actions: ApprovalAction[] = [];
  const { approval_status, project_id } = snapshot;

  if (approval_status === 'blocked') {
    const blockedInvoices = invoiceSnapshots.filter(
      (i) => i.approval_status === 'blocked',
    );

    if (blockedInvoices.length > 0) {
      for (const inv of blockedInvoices) {
        actions.push({
          action_type: 'requires_verification_review',
          project_id,
          invoice_number: inv.invoice_number,
          amount: inv.billed_amount,
          reason: buildInvoiceBlockedReason(inv),
          priority: 'critical',
        });
      }
    } else {
      // Snapshot blocked but no per-invoice data available — one project-level task
      actions.push({
        action_type: 'requires_verification_review',
        project_id,
        invoice_number: null,
        amount: snapshot.blocked_amount,
        reason: buildProjectBlockedReason(snapshot),
        priority: 'critical',
      });
    }

    actions.push({
      action_type: 'flag_project',
      project_id,
      invoice_number: null,
      amount: snapshot.blocked_amount,
      reason: `Project flagged: ${snapshot.blocked_invoice_count} blocked invoice(s) totaling ${formatCents(snapshot.blocked_amount)}`,
      priority: 'high',
    });

    actions.push({
      action_type: 'notify_operator',
      project_id,
      invoice_number: null,
      amount: snapshot.blocked_amount,
      reason: `Operator review required: ${snapshot.blocked_invoice_count} invoice(s) require verification, ${formatCents(snapshot.blocked_amount)} blocked`,
      priority: 'high',
    });
  } else if (
    approval_status === 'needs_review' ||
    approval_status === 'approved_with_exceptions'
  ) {
    const reviewInvoices = invoiceSnapshots.filter(
      (i) =>
        i.approval_status === 'needs_review' ||
        i.approval_status === 'approved_with_exceptions',
    );

    if (reviewInvoices.length > 0) {
      for (const inv of reviewInvoices) {
        actions.push({
          action_type: 'needs_review_queue',
          project_id,
          invoice_number: inv.invoice_number,
          amount: inv.at_risk_amount,
          reason: buildInvoiceReviewReason(inv),
          priority: 'medium',
        });
      }
    } else {
      actions.push({
        action_type: 'needs_review_queue',
        project_id,
        invoice_number: null,
        amount: snapshot.at_risk_amount,
        reason: `${snapshot.needs_review_invoice_count} invoice(s) queued for review — ${formatCents(snapshot.at_risk_amount)} at risk`,
        priority: 'medium',
      });
    }

    actions.push({
      action_type: 'assign_analyst',
      project_id,
      invoice_number: null,
      amount: snapshot.at_risk_amount,
      reason: `Analyst assignment required for ${snapshot.needs_review_invoice_count} invoice(s) — ${formatCents(snapshot.at_risk_amount)} at risk`,
      priority: 'medium',
    });
  } else if (approval_status === 'approved') {
    actions.push({
      action_type: 'mark_project_ready',
      project_id,
      invoice_number: null,
      amount: snapshot.total_billed,
      reason: `All ${snapshot.approved_invoice_count} invoice(s) verified — project approved for export`,
      priority: 'low',
    });

    actions.push({
      action_type: 'generate_approval_log',
      project_id,
      invoice_number: null,
      amount: snapshot.total_billed,
      reason: `Approval log generated for ${snapshot.invoice_count} invoice(s), ${formatCents(snapshot.total_billed)} total`,
      priority: 'low',
    });
  }
  // approval_status === 'not_evaluated' → no actions

  return actions;
}

// ---------------------------------------------------------------------------
// Task type and display helpers
// ---------------------------------------------------------------------------

const ACTION_TASK_TYPE: Record<ApprovalActionType, string> = {
  requires_verification_review: 'approval_requires_verification',
  flag_project:                 'approval_flag_project',
  notify_operator:              'approval_notify_operator',
  needs_review_queue:           'approval_needs_review_queue',
  assign_analyst:               'approval_assign_analyst',
  mark_project_ready:           'approval_mark_ready',
  generate_approval_log:        'approval_generate_log',
};

function buildTaskType(action: ApprovalAction): string {
  return ACTION_TASK_TYPE[action.action_type];
}

function buildTaskTitle(action: ApprovalAction): string {
  const amt = action.amount != null ? ` — ${formatCents(action.amount)}` : '';

  switch (action.action_type) {
    case 'requires_verification_review':
      return action.invoice_number
        ? `Review invoice ${action.invoice_number}${amt}: verification required`
        : `Review project${amt}: verification required`;
    case 'flag_project':
      return `Project flagged: verification required${amt}`;
    case 'notify_operator':
      return `Operator review needed${amt}`;
    case 'needs_review_queue':
      return action.invoice_number
        ? `Review queue: invoice ${action.invoice_number}${amt}`
        : `Review queue: project invoices${amt}`;
    case 'assign_analyst':
      return `Assign analyst for review${amt}`;
    case 'mark_project_ready':
      return `Project approved — ready for export${amt}`;
    case 'generate_approval_log':
      return `Generate approval log${amt}`;
  }
}

function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function buildInvoiceBlockedReason(inv: InvoiceApprovalSnapshot): string {
  const parts: string[] = [];

  if (inv.invoice_number) {
    parts.push(`Invoice ${inv.invoice_number}`);
  }
  parts.push('requires verification');

  if (inv.billed_amount != null) {
    parts.push(`— billed ${formatCents(inv.billed_amount)}`);
  }
  if (inv.at_risk_amount != null) {
    parts.push(`(${formatCents(inv.at_risk_amount)} at risk)`);
  }
  if (inv.blocking_reasons.length > 0) {
    parts.push(`Reasons: ${inv.blocking_reasons.slice(0, 3).join(', ')}`);
  }

  return parts.join(' ');
}

function buildProjectBlockedReason(snapshot: ProjectApprovalSnapshot): string {
  return [
    'Project requires verification.',
    snapshot.blocked_invoice_count > 0
      ? `${snapshot.blocked_invoice_count} blocked invoice(s).`
      : null,
    snapshot.blocked_amount != null
      ? `Blocked amount: ${formatCents(snapshot.blocked_amount)}.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function buildInvoiceReviewReason(inv: InvoiceApprovalSnapshot): string {
  const parts = [
    inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'Invoice',
    'needs review.',
    inv.at_risk_amount != null ? `At risk: ${formatCents(inv.at_risk_amount)}.` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Per-project workflow task upsert
// Deduplicates by (organization_id, project_id, task_type) — not decision_id.
// Approval tasks are project-scoped, not decision-scoped.
// ---------------------------------------------------------------------------

async function upsertApprovalTask(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  params: {
    organization_id: string;
    project_id: string;
    task_type: string;
    title: string;
    description: string;
    priority: string;
    source_metadata: Record<string, unknown>;
  },
): Promise<TaskUpsertOutcome> {
  const now = new Date().toISOString();
  const ACTIVE = ['open', 'in_progress', 'blocked'];

  // Find existing active task for this project + task_type
  const { data: existing, error: findError } = await admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', params.organization_id)
    .eq('project_id', params.project_id)
    .eq('task_type', params.task_type)
    .in('status', ACTIVE)
    .limit(1)
    .maybeSingle();

  if (findError) {
    return { ok: false, error: findError.message };
  }

  if (existing) {
    const { error: updateError } = await admin
      .from('workflow_tasks')
      .update({
        title: params.title,
        description: params.description,
        priority: params.priority,
        source_metadata: params.source_metadata,
        updated_at: now,
      })
      .eq('id', (existing as { id: string }).id);

    if (updateError) {
      return { ok: false, error: updateError.message };
    }

    return { ok: true, task_id: (existing as { id: string }).id, action: 'updated' };
  }

  const { data: inserted, error: insertError } = await admin
    .from('workflow_tasks')
    .insert({
      organization_id: params.organization_id,
      project_id: params.project_id,
      decision_id: null,
      document_id: null,
      task_type: params.task_type,
      title: params.title,
      description: params.description,
      status: 'open',
      priority: params.priority,
      source: 'approval_engine',
      source_metadata: params.source_metadata,
      details: {},
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  if (insertError) {
    return { ok: false, error: insertError.message };
  }

  return {
    ok: true,
    task_id: (inserted as { id: string }).id,
    action: 'created',
  };
}

// ---------------------------------------------------------------------------
// Execution log
// ---------------------------------------------------------------------------

async function logActionExecution(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  params: {
    project_id: string;
    organization_id: string;
    approval_status: string;
    action: ApprovalAction;
    task_id: string | null;
    task_outcome: 'created' | 'updated' | 'failed';
    error: string | null;
  },
): Promise<void> {
  try {
    await admin.from('approval_action_log').insert({
      project_id: params.project_id,
      organization_id: params.organization_id,
      approval_status: params.approval_status,
      action_type: params.action.action_type,
      invoice_number: params.action.invoice_number,
      amount: params.action.amount,
      reason: params.action.reason,
      priority: params.action.priority,
      task_id: params.task_id,
      task_outcome: params.task_outcome,
      error: params.error,
      executed_at: new Date().toISOString(),
    });
  } catch (e) {
    // Non-fatal — action log is supplementary audit trail, not critical path
    console.error('[approvalActionEngine] logActionExecution failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Invoice snapshot loading with deduplication (latest per invoice_number)
// ---------------------------------------------------------------------------

async function loadLatestInvoiceSnapshots(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  projectId: string,
  invoiceCount: number,
): Promise<InvoiceApprovalSnapshot[]> {
  const { data, error } = await admin
    .from('invoice_approval_snapshots')
    .select()
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(Math.max(invoiceCount * 2 + 10, 20));

  if (error || !data) return [];

  // Keep only the latest per invoice_number (ordered desc already, so first wins)
  const seen = new Set<string>();
  const deduped: InvoiceApprovalSnapshot[] = [];

  for (const row of data as InvoiceApprovalSnapshot[]) {
    const key = row.invoice_number ?? '__no_invoice__';
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Main execution entry point
// ---------------------------------------------------------------------------

/**
 * Execute deterministic operator actions based on the project's current
 * approval status.
 *
 * Call after:
 *   - persistApprovalSnapshot() completes (pass snapshot to avoid extra query)
 *   - Reconciliation state changes
 *   - Manual re-trigger via API
 *
 * Does not throw. All errors are returned in result.errors.
 */
export async function executeApprovalActions(
  params: ExecuteApprovalActionsParams,
): Promise<ApprovalActionResult> {
  const { projectId, organizationId } = params;
  const executedAt = new Date().toISOString();

  const result: ApprovalActionResult = {
    project_id: projectId,
    approval_status: 'unknown',
    actions_planned: [],
    tasks_created: 0,
    tasks_updated: 0,
    errors: [],
    executed_at: executedAt,
  };

  const admin = getSupabaseAdmin();
  if (!admin) {
    result.errors.push('Server not configured');
    return result;
  }

  try {
    // Resolve snapshot
    const snapshot = params.snapshot ?? await getLatestApprovalSnapshot(projectId);

    if (!snapshot) {
      result.approval_status = 'not_evaluated';
      return result;
    }

    result.approval_status = snapshot.approval_status;

    if (snapshot.approval_status === 'not_evaluated') {
      return result;
    }

    // Resolve invoice snapshots
    let invoiceSnapshots = params.invoiceSnapshots ?? [];
    if (invoiceSnapshots.length === 0 && snapshot.invoice_count > 0) {
      invoiceSnapshots = await loadLatestInvoiceSnapshots(
        admin,
        projectId,
        snapshot.invoice_count,
      );
    }

    // Plan (pure, no DB)
    const actions = planApprovalActions(snapshot, invoiceSnapshots);
    result.actions_planned = actions;

    if (actions.length === 0) {
      return result;
    }

    // Execute each action
    for (const action of actions) {
      try {
        const outcome = await upsertApprovalTask(admin, {
          organization_id: organizationId,
          project_id: projectId,
          task_type: buildTaskType(action),
          title: buildTaskTitle(action),
          description: action.reason,
          priority: action.priority,
          source_metadata: {
            action_type: action.action_type,
            approval_status: snapshot.approval_status,
            invoice_number: action.invoice_number,
            amount: action.amount,
            snapshot_created_at: snapshot.created_at,
          },
        });

        if (outcome.ok) {
          if (outcome.action === 'created') {
            result.tasks_created += 1;
          } else {
            result.tasks_updated += 1;
          }

          await logActionExecution(admin, {
            project_id: projectId,
            organization_id: organizationId,
            approval_status: snapshot.approval_status,
            action,
            task_id: outcome.task_id,
            task_outcome: outcome.action,
            error: null,
          });
        } else {
          result.errors.push(`${action.action_type}: ${outcome.error}`);

          await logActionExecution(admin, {
            project_id: projectId,
            organization_id: organizationId,
            approval_status: snapshot.approval_status,
            action,
            task_id: null,
            task_outcome: 'failed',
            error: outcome.error,
          });
        }
      } catch (actionError) {
        const msg = actionError instanceof Error ? actionError.message : String(actionError);
        result.errors.push(`${action.action_type}: ${msg}`);
        console.error('[approvalActionEngine] action failed:', {
          action_type: action.action_type,
          projectId,
          error: msg,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Execution failed: ${msg}`);
    console.error('[approvalActionEngine] executeApprovalActions failed:', {
      projectId,
      error: msg,
    });
  }

  if (result.errors.length > 0) {
    console.error('[approvalActionEngine] completed with errors:', {
      projectId,
      errors: result.errors,
    });
  }

  return result;
}

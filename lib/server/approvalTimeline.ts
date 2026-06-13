/**
 * lib/server/approvalTimeline.ts
 * Timeline builder for approval history visualization
 * Converts approval snapshots into chronological timeline events
 */

import type { ProjectApprovalSnapshot, InvoiceApprovalSnapshot } from './approvalSnapshots';
import { getSupabaseAdmin } from './supabaseAdmin';

/**
 * Timeline event types for approval history
 */
export type TimelineEventType =
  | 'status_changed'
  | 'blocked_amount_changed'
  | 'at_risk_amount_changed'
  | 'invoice_added'
  | 'invoice_status_changed'
  | 'blocking_reason_added'
  | 'blocking_reason_resolved';

/**
 * A single timeline event in the approval history
 */
export type ApprovalTimelineEvent = {
  id: string; // snapshot timestamp + event type hash
  timestamp: string; // ISO 8601
  type: TimelineEventType;
  title: string; // Human-readable title
  description: string; // What changed
  severity: 'info' | 'warning' | 'critical'; // Visual priority

  // Context
  projectId: string;
  invoiceNumber?: string; // For invoice-specific events

  // Old → New values
  previous?: Record<string, any>;
  current?: Record<string, any>;

  // Derived data
  blockedAmountDelta?: number;
  atRiskAmountDelta?: number;
  invoiceCountDelta?: number;
  newBlockingReasons?: string[];
  resolvedBlockingReasons?: string[];
};

/**
 * Complete timeline with metadata
 */
export type ApprovalTimeline = {
  projectId: string;
  totalEvents: number;
  dateRange: {
    earliest: string;
    latest: string;
  };
  events: ApprovalTimelineEvent[];
  summary: {
    statusChanges: number;
    blockersAdded: number;
    blockersResolved: number;
    invoicesAdded: number;
  };
};

/**
 * Build a timeline from project approval history
 * Compares consecutive snapshots to extract events
 */
export async function buildApprovalTimeline(
  projectId: string,
  limit: number = 50
): Promise<ApprovalTimeline | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  try {
    // Fetch project snapshots (newest first)
    const { data: projectSnapshots, error: snapError } = await admin
      .from('project_approval_snapshots')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (snapError || !projectSnapshots) {
      console.error('[buildApprovalTimeline] Failed to fetch snapshots:', snapError);
      return null;
    }

    if (projectSnapshots.length === 0) {
      return {
        projectId,
        totalEvents: 0,
        dateRange: { earliest: new Date().toISOString(), latest: new Date().toISOString() },
        events: [],
        summary: {
          statusChanges: 0,
          blockersAdded: 0,
          blockersResolved: 0,
          invoicesAdded: 0,
        },
      };
    }

    const events: ApprovalTimelineEvent[] = [];

    // Process snapshots in reverse chronological order (oldest → newest)
    const reversedSnapshots = [...projectSnapshots].reverse();

    for (let i = 0; i < reversedSnapshots.length - 1; i++) {
      const previous = reversedSnapshots[i];
      const current = reversedSnapshots[i + 1];

      // 1. Approval status changed
      if (previous.approval_status !== current.approval_status) {
        events.push({
          id: `${current.created_at}-status-${current.approval_status}`,
          timestamp: current.created_at,
          type: 'status_changed',
          title: `Status changed to ${formatStatus(current.approval_status)}`,
          description: `Approval status changed from ${formatStatus(previous.approval_status)} to ${formatStatus(current.approval_status)}`,
          severity: current.approval_status === 'blocked' ? 'critical' : 'info',
          projectId,
          previous: { status: previous.approval_status },
          current: { status: current.approval_status },
        });
      }

      // 2. Blocked amount changed
      const blockedDelta =
        (current.blocked_amount ?? 0) - (previous.blocked_amount ?? 0);
      if (blockedDelta !== 0) {
        events.push({
          id: `${current.created_at}-blocked-${blockedDelta}`,
          timestamp: current.created_at,
          type: 'blocked_amount_changed',
          title: `Blocked amount ${blockedDelta > 0 ? 'increased' : 'decreased'}`,
          description: `Blocked amount changed from $${formatCurrency(previous.blocked_amount ?? 0)} to $${formatCurrency(current.blocked_amount ?? 0)} (${formatCurrency(Math.abs(blockedDelta))} ${blockedDelta > 0 ? 'increase' : 'decrease'})`,
          severity: blockedDelta > 0 ? 'critical' : 'info',
          projectId,
          blockedAmountDelta: blockedDelta,
          previous: { blockedAmount: previous.blocked_amount },
          current: { blockedAmount: current.blocked_amount },
        });
      }

      // 3. At-risk amount changed
      const atRiskDelta =
        (current.at_risk_amount ?? 0) - (previous.at_risk_amount ?? 0);
      if (atRiskDelta !== 0) {
        events.push({
          id: `${current.created_at}-atrisk-${atRiskDelta}`,
          timestamp: current.created_at,
          type: 'at_risk_amount_changed',
          title: `At-risk amount ${atRiskDelta > 0 ? 'increased' : 'decreased'}`,
          description: `At-risk amount changed from $${formatCurrency(previous.at_risk_amount ?? 0)} to $${formatCurrency(current.at_risk_amount ?? 0)} (${formatCurrency(Math.abs(atRiskDelta))} ${atRiskDelta > 0 ? 'increase' : 'decrease'})`,
          severity: atRiskDelta > 0 ? 'warning' : 'info',
          projectId,
          atRiskAmountDelta: atRiskDelta,
          previous: { atRiskAmount: previous.at_risk_amount },
          current: { atRiskAmount: current.at_risk_amount },
        });
      }

      // 4. Invoice count changed
      const invoiceDelta = current.invoice_count - previous.invoice_count;
      if (invoiceDelta > 0) {
        events.push({
          id: `${current.created_at}-invoices-${invoiceDelta}`,
          timestamp: current.created_at,
          type: 'invoice_added',
          title: `${invoiceDelta} invoice${invoiceDelta !== 1 ? 's' : ''} added`,
          description: `Invoice count increased from ${previous.invoice_count} to ${current.invoice_count}`,
          severity: 'info',
          projectId,
          invoiceCountDelta: invoiceDelta,
          previous: { invoiceCount: previous.invoice_count },
          current: { invoiceCount: current.invoice_count },
        });
      }

      // 5. Blocked invoices changed
      const blockedInvoiceDelta =
        current.blocked_invoice_count - previous.blocked_invoice_count;
      if (blockedInvoiceDelta !== 0) {
        events.push({
          id: `${current.created_at}-blocked-invoices-${blockedInvoiceDelta}`,
          timestamp: current.created_at,
          type: 'invoice_status_changed',
          title: `${Math.abs(blockedInvoiceDelta)} invoice${Math.abs(blockedInvoiceDelta) !== 1 ? 's' : ''} blocked`,
          description: `Blocked invoices changed from ${previous.blocked_invoice_count} to ${current.blocked_invoice_count}`,
          severity: 'critical',
          projectId,
          previous: { blockedInvoiceCount: previous.blocked_invoice_count },
          current: { blockedInvoiceCount: current.blocked_invoice_count },
        });
      }

      // 6. Invoice-level events (fetch invoice snapshots for this moment)
      const invoiceEvents = await getInvoiceTimelineEvents(projectId, previous, current);
      events.push(...invoiceEvents);
    }

    // Sort by timestamp ascending (oldest first)
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Compute summary stats
    const summary = {
      statusChanges: events.filter((e) => e.type === 'status_changed').length,
      blockersAdded: events.filter((e) => e.type === 'blocking_reason_added').length,
      blockersResolved: events.filter((e) => e.type === 'blocking_reason_resolved').length,
      invoicesAdded: events.filter((e) => e.type === 'invoice_added').length,
    };

    return {
      projectId,
      totalEvents: events.length,
      dateRange: {
        earliest: reversedSnapshots[0].created_at,
        latest: reversedSnapshots[reversedSnapshots.length - 1].created_at,
      },
      events,
      summary,
    };
  } catch (err) {
    console.error('[buildApprovalTimeline] Error building timeline:', err);
    return null;
  }
}

/**
 * Compare invoice snapshots to detect blocking reason changes
 */
async function getInvoiceTimelineEvents(
  projectId: string,
  previousSnapshot: ProjectApprovalSnapshot,
  currentSnapshot: ProjectApprovalSnapshot
): Promise<ApprovalTimelineEvent[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  try {
    const previousTime = previousSnapshot.created_at;
    const currentTime = currentSnapshot.created_at;

    // Fetch invoices at both moments
    const { data: previousInvoices } = await admin
      .from('invoice_approval_snapshots')
      .select('*')
      .eq('project_id', projectId)
      .eq('created_at', previousTime);

    const { data: currentInvoices } = await admin
      .from('invoice_approval_snapshots')
      .select('*')
      .eq('project_id', projectId)
      .eq('created_at', currentTime);

    if (!previousInvoices || !currentInvoices) return [];

    const events: ApprovalTimelineEvent[] = [];
    const previousMap = new Map(previousInvoices.map((i) => [i.invoice_number, i]));

    // Check each invoice in current state
    for (const current of currentInvoices) {
      const previous = previousMap.get(current.invoice_number);

      if (!previous) {
        // New invoice
        continue; // Already handled by invoice_added event
      }

      // Check for new blocking reasons
      const previousReasons = new Set(previous.blocking_reasons || []);
      const currentReasons = new Set(current.blocking_reasons || []);

      const newReasons = ([...currentReasons] as string[]).filter((r) => !previousReasons.has(r));
      const resolvedReasons = ([...previousReasons] as string[]).filter((r) => !currentReasons.has(r));

      if (newReasons.length > 0) {
        events.push({
          id: `${currentTime}-blocker-added-${current.invoice_number}`,
          timestamp: currentTime,
          type: 'blocking_reason_added',
          title: `Blocking reason${newReasons.length > 1 ? 's' : ''} added for ${current.invoice_number}`,
          description: `New blocker${newReasons.length > 1 ? 's' : ''}: ${newReasons.join(', ')}`,
          severity: 'critical',
          projectId,
          invoiceNumber: current.invoice_number || undefined,
          newBlockingReasons: newReasons,
        });
      }

      if (resolvedReasons.length > 0) {
        events.push({
          id: `${currentTime}-blocker-resolved-${current.invoice_number}`,
          timestamp: currentTime,
          type: 'blocking_reason_resolved',
          title: `Blocking reason${resolvedReasons.length > 1 ? 's' : ''} resolved for ${current.invoice_number}`,
          description: `Resolved blocker${resolvedReasons.length > 1 ? 's' : ''}: ${resolvedReasons.join(', ')}`,
          severity: 'info',
          projectId,
          invoiceNumber: current.invoice_number || undefined,
          resolvedBlockingReasons: resolvedReasons,
        });
      }
    }

    return events;
  } catch (err) {
    console.error('[getInvoiceTimelineEvents] Error fetching invoice events:', err);
    return [];
  }
}

/**
 * Format approval status for display
 */
function formatStatus(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format currency for display
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

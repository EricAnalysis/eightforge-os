/**
 * lib/server/approvalTimeline.ts
 * Timeline builder for approval history visualization
 * Converts approval snapshots into chronological timeline events
 */

import {
  compareApprovalSnapshots,
  getApprovalHistory,
  type ProjectApprovalSnapshot,
  type InvoiceApprovalSnapshot,
} from './approvalSnapshots';
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
    const projectSnapshots = await getApprovalHistory(projectId, limit);

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
    const findingLifecycleEvents = await getFindingLifecycleEvents(projectId);

    // Process snapshots in reverse chronological order (oldest → newest)
    const reversedSnapshots = [...projectSnapshots].reverse();

    for (let i = 0; i < reversedSnapshots.length - 1; i++) {
      const previous = reversedSnapshots[i];
      const current = reversedSnapshots[i + 1];
      const diff = compareApprovalSnapshots(previous, current);

      // 1. Approval status changed
      if (diff.approval_status_changed) {
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
      const blockedDelta = diff.blocked_amount_changed ?? 0;
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
      const atRiskDelta = diff.at_risk_amount_changed ?? 0;
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
      const invoiceDelta = diff.invoice_count_changed;
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
      const blockedInvoiceDelta = diff.blocked_invoice_count_changed;
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

      // Legacy snapshots contain pseudo finding ids. Compare finding sets only
      // when both sides are attributed to canonical validation runs.
      if (previous.run_id && current.run_id) {
        const runEvents = findingLifecycleEvents.filter((event) => event.runId === current.run_id);
        const addedIds = new Set(diff.new_blocking_reasons);
        const resolvedIds = new Set(diff.resolved_blocking_reasons);
        for (const event of runEvents) {
          if (event.eventType === 'validation_finding_generated') addedIds.add(event.findingId);
          if (event.eventType === 'validation_finding_resolved') resolvedIds.add(event.findingId);
        }

        for (const findingId of [...addedIds].sort()) {
          events.push({
            id: `${current.created_at}-finding-added-${findingId}`,
            timestamp: current.created_at,
            type: 'blocking_reason_added',
            title: 'Validation finding added',
            description: `Finding ${findingId} entered the canonical open set.`,
            severity: 'warning',
            projectId,
            newBlockingReasons: [findingId],
          });
        }

        for (const findingId of [...resolvedIds].sort()) {
          events.push({
            id: `${current.created_at}-finding-resolved-${findingId}`,
            timestamp: current.created_at,
            type: 'blocking_reason_resolved',
            title: 'Validation finding resolved',
            description: `Finding ${findingId} left the canonical open set.`,
            severity: 'info',
            projectId,
            resolvedBlockingReasons: [findingId],
          });
        }
      }

      // 7. Invoice-level events (fetch invoice snapshots for this moment)
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

type FindingLifecycleTimelineSource = {
  findingId: string;
  eventType: 'validation_finding_generated' | 'validation_finding_resolved';
  runId: string;
};

async function getFindingLifecycleEvents(
  projectId: string,
): Promise<FindingLifecycleTimelineSource[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from('activity_events')
    .select('entity_id, event_type, new_value')
    .eq('project_id', projectId)
    .in('event_type', ['validation_finding_generated', 'validation_finding_resolved']);

  if (error) {
    console.error('[buildApprovalTimeline] Failed to fetch finding lifecycle events:', error);
    return [];
  }

  return (data ?? []).flatMap((row): FindingLifecycleTimelineSource[] => {
    const eventType = row.event_type;
    const runId = row.new_value?.run_id;
    if (
      (eventType !== 'validation_finding_generated' && eventType !== 'validation_finding_resolved')
      || typeof row.entity_id !== 'string'
      || typeof runId !== 'string'
    ) {
      return [];
    }
    return [{ findingId: row.entity_id, eventType, runId }];
  });
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

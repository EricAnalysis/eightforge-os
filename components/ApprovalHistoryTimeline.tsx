'use client';

import React from 'react';
import { AlertCircle, CheckCircle2, Clock, DollarSign, FileText } from 'lucide-react';
import type { ApprovalTimeline, ApprovalTimelineEvent } from '@/lib/server/approvalTimeline';

const eventTypeIcons: Record<string, React.ReactNode> = {
  status_changed: <CheckCircle2 className="w-5 h-5" />,
  blocked_amount_changed: <DollarSign className="w-5 h-5" />,
  at_risk_amount_changed: <AlertCircle className="w-5 h-5" />,
  invoice_added: <FileText className="w-5 h-5" />,
  invoice_status_changed: <AlertCircle className="w-5 h-5" />,
  blocking_reason_added: <AlertCircle className="w-5 h-5" />,
  blocking_reason_resolved: <CheckCircle2 className="w-5 h-5" />,
};

interface ApprovalHistoryTimelineProps {
  timeline: ApprovalTimeline;
  compact?: boolean; // Show only important events
}

/**
 * ApprovalHistoryTimeline
 * Displays approval decision evolution over time with color-coded severity levels
 */
export function ApprovalHistoryTimeline({
  timeline,
  compact = false,
}: ApprovalHistoryTimelineProps) {
  const { events, summary, dateRange } = timeline;

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Clock className="mb-3 h-12 w-12 text-[var(--ef-text-soft)]" />
        <p className="text-sm text-[var(--ef-text-muted)]">No approval history yet</p>
      </div>
    );
  }

  // Filter events if compact mode
  const filteredEvents = compact
    ? events.filter((e) => e.severity !== 'info')
    : events;

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Status Changes"
          value={summary.statusChanges}
          icon="status"
        />
        <StatCard
          label="Blockers Added"
          value={summary.blockersAdded}
          icon="alert"
        />
        <StatCard
          label="Blockers Resolved"
          value={summary.blockersResolved}
          icon="check"
        />
        <StatCard
          label="Invoices Added"
          value={summary.invoicesAdded}
          icon="file"
        />
      </div>

      {/* Timeline */}
      <div className="relative">
        <div className="absolute bottom-0 left-6 top-0 w-0.5 bg-[var(--ef-border-subtle)]" />

        <div className="space-y-6">
          {filteredEvents.map((event) => (
            <TimelineItem
              key={event.id}
              event={event}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--ef-border-subtle)] pt-4 text-xs text-[var(--ef-text-muted)]">
        <span>
          {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
        </span>
        <span>
          {new Date(dateRange.earliest).toLocaleDateString()} —{' '}
          {new Date(dateRange.latest).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}

interface TimelineItemProps {
  event: ApprovalTimelineEvent;
}

/**
 * Individual timeline event
 */
function TimelineItem({ event }: TimelineItemProps) {
  const severityColors: Record<string, string> = {
    critical: 'bg-[var(--ef-critical-bg)] dark:bg-[var(--ef-critical-bg)] border-[var(--ef-critical-a20)] dark:border-[var(--ef-critical-a40)]',
    warning: 'bg-[var(--ef-warning-bg)] dark:bg-[var(--ef-warning-bg)] border-[var(--ef-warning-a20)] dark:border-[var(--ef-warning-a40)]',
    info: 'bg-[var(--ef-purple-primary-a10)] dark:bg-[var(--ef-purple-primary-a10)] border-[var(--ef-purple-primary-a20)] dark:border-[var(--ef-purple-primary-a30)]',
  };

  const severityTextColors: Record<string, string> = {
    critical: 'text-[var(--ef-critical)] dark:text-[var(--ef-critical-soft)]',
    warning: 'text-[var(--ef-warning)] dark:text-[var(--ef-warning-soft)]',
    info: 'text-[var(--ef-purple-primary)] dark:text-[var(--ef-purple-glow)]',
  };

  const severityDotColors: Record<string, string> = {
    critical: 'bg-[var(--ef-critical)]',
    warning: 'bg-[var(--ef-warning)]',
    info: 'bg-[var(--ef-purple-primary)]',
  };

  const timestamp = new Date(event.timestamp);
  const formattedTime = timestamp.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return (
    <div className="relative pl-16">
      {/* Dot */}
      <div
        className={`absolute left-0 top-2 flex h-4 w-4 items-center justify-center rounded-full ${severityDotColors[event.severity]} ring-4 ring-[var(--ef-background-secondary)]`}
      >
        {/* Icon inside dot */}
        <div className="flex h-full w-full items-center justify-center text-xs text-[var(--ef-text-primary)]">
          {eventTypeIcons[event.type] ? (
            <div className="text-xs">
              {React.cloneElement(
                eventTypeIcons[event.type] as React.ReactElement<{ className?: string }>,
                { className: 'w-2.5 h-2.5' }
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Card */}
      <div
        className={`rounded-lg border p-4 ${severityColors[event.severity]} ${severityTextColors[event.severity]}`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-2">
          <h4 className="font-semibold text-sm">{event.title}</h4>
          <span className="text-xs opacity-75 whitespace-nowrap ml-2">{formattedTime}</span>
        </div>

        {/* Description */}
        <p className="text-sm mb-3 opacity-90">{event.description}</p>

        {/* Details */}
        {event.invoiceNumber && (
          <div className="text-xs opacity-75 mb-2">
            Invoice: <span className="font-mono">{event.invoiceNumber}</span>
          </div>
        )}

        {/* Delta display */}
        {event.blockedAmountDelta !== undefined && (
          <DetailRow
            label="Blocked Amount Delta"
            value={formatCurrency(event.blockedAmountDelta)}
            isNegative={event.blockedAmountDelta < 0}
          />
        )}

        {event.atRiskAmountDelta !== undefined && (
          <DetailRow
            label="At-Risk Amount Delta"
            value={formatCurrency(event.atRiskAmountDelta)}
            isNegative={event.atRiskAmountDelta < 0}
          />
        )}

        {event.invoiceCountDelta !== undefined && (
          <DetailRow
            label="Invoice Count Delta"
            value={`+${event.invoiceCountDelta}`}
          />
        )}

        {/* Blocking reasons */}
        {event.newBlockingReasons && event.newBlockingReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t border-current border-opacity-20">
            <p className="text-xs font-semibold mb-1">New Blockers:</p>
            <ul className="text-xs space-y-1">
              {event.newBlockingReasons.map((reason, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-[var(--ef-critical)] mt-0.5">✕</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {event.resolvedBlockingReasons && event.resolvedBlockingReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t border-current border-opacity-20">
            <p className="text-xs font-semibold mb-1">Resolved Blockers:</p>
            <ul className="text-xs space-y-1">
              {event.resolvedBlockingReasons.map((reason, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-[var(--ef-success)] dark:text-[var(--ef-success-soft)] mt-0.5">✓</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Summary stat card
 */
function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: string;
}) {
  const icons: Record<string, React.ReactNode> = {
    status: <CheckCircle2 className="w-4 h-4" />,
    alert: <AlertCircle className="w-4 h-4" />,
    check: <CheckCircle2 className="w-4 h-4" />,
    file: <FileText className="w-4 h-4" />,
  };

  return (
    <div className="rounded-lg border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-panel)] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-[var(--ef-text-muted)]">{label}</span>
        <div className="text-[var(--ef-text-soft)]">{icons[icon]}</div>
      </div>
      <div className="text-2xl font-bold text-[var(--ef-text-primary)]">{value}</div>
    </div>
  );
}

/**
 * Detail row for displaying deltas
 */
function DetailRow({
  label,
  value,
  isNegative,
}: {
  label: string;
  value: string;
  isNegative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="opacity-75">{label}:</span>
      <span
        className={`font-mono font-semibold ${
          isNegative ? 'text-[var(--ef-success)] dark:text-[var(--ef-success-soft)]' : 'text-[var(--ef-critical)] dark:text-[var(--ef-critical)]'
        }`}
      >
        {isNegative ? '-' : '+'}
        {value}
      </span>
    </div>
  );
}

/**
 * Format currency for display
 */
function formatCurrency(amount: number): string {
  const absAmount = Math.abs(amount);
  if (absAmount >= 1000000) {
    return `$${(absAmount / 1000000).toFixed(1)}M`;
  }
  if (absAmount >= 1000) {
    return `$${(absAmount / 1000).toFixed(1)}K`;
  }
  return `$${absAmount.toFixed(0)}`;
}

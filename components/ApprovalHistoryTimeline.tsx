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
        <Clock className="w-12 h-12 text-gray-300 mb-3" />
        <p className="text-gray-500 text-sm">No approval history yet</p>
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
        <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-700" />

        <div className="space-y-6">
          {filteredEvents.map((event, index) => (
            <TimelineItem
              key={event.id}
              event={event}
              isFirst={index === 0}
              isLast={index === filteredEvents.length - 1}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-4 border-t border-gray-200 dark:border-gray-700">
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
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Individual timeline event
 */
function TimelineItem({ event, isFirst, isLast }: TimelineItemProps) {
  const severityColors: Record<string, string> = {
    critical: 'bg-red-100 dark:bg-red-900/30 border-red-200 dark:border-red-800',
    warning: 'bg-amber-100 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800',
    info: 'bg-blue-100 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800',
  };

  const severityTextColors: Record<string, string> = {
    critical: 'text-red-900 dark:text-red-100',
    warning: 'text-amber-900 dark:text-amber-100',
    info: 'text-blue-900 dark:text-blue-100',
  };

  const severityDotColors: Record<string, string> = {
    critical: 'bg-red-500',
    warning: 'bg-amber-500',
    info: 'bg-blue-500',
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
        className={`absolute left-0 top-2 w-4 h-4 rounded-full ${severityDotColors[event.severity]} ring-4 ring-white dark:ring-gray-900 flex items-center justify-center`}
      >
        {/* Icon inside dot */}
        <div className="text-white text-xs flex items-center justify-center w-full h-full">
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
                  <span className="text-red-500 mt-0.5">✕</span>
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
                  <span className="text-green-600 dark:text-green-400 mt-0.5">✓</span>
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
    <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-600 dark:text-gray-400 font-medium">{label}</span>
        <div className="text-gray-400 dark:text-gray-500">{icons[icon]}</div>
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
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
          isNegative ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
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

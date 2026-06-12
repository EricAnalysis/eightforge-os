'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

// ─── Types ───────────────────────────────────────────────────────────────

type Signal = {
  id: string;
  organization_id: string;
  signal_type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  description: string | null;
  severity: string;
  metrics: Record<string, any> | null;
  status: string;
  created_at: string;
};

// ─── Badge Components ─────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
    high: 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical)] border border-[var(--ef-critical-a40)]',
    medium: 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
    low: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  };
  const cls = map[severity] ?? 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning)] border border-[var(--ef-warning-a40)]',
    resolved: 'bg-[var(--ef-success-a20)] text-[var(--ef-success)] border border-[var(--ef-success-a40)]',
    ignored: 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]',
  };
  const cls = map[status] ?? 'bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ─── Signal Row Component ─────────────────────────────────────────────────

function SignalRow({ signal, onStatusChange }: { signal: Signal; onStatusChange: (id: string, newStatus: string) => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleResolve = async () => {
    setUpdateError(null);
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/signals/${signal.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      });
      if (!res.ok) {
        setUpdateError('Failed to resolve');
        return;
      }
      onStatusChange(signal.id, 'resolved');
    } catch {
      setUpdateError('Error');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleIgnore = async () => {
    setUpdateError(null);
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/signals/${signal.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ignored' }),
      });
      if (!res.ok) {
        setUpdateError('Failed to ignore');
        return;
      }
      onStatusChange(signal.id, 'ignored');
    } catch {
      setUpdateError('Error');
    } finally {
      setIsUpdating(false);
    }
  };

  const entityLink =
    signal.entity_type && signal.entity_id
      ? `/platform/${signal.entity_type}s/${signal.entity_id}`
      : null;

  const createdDate = new Date(signal.created_at).toLocaleString();

  return (
    <div className="border-b border-[var(--ef-surface-elevated)] last:border-0">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-3 py-3 px-2 cursor-pointer hover:bg-[var(--ef-surface-elevated)] transition-colors"
      >
        {/* Severity badge */}
        <SeverityBadge severity={signal.severity} />

        {/* Title */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-[var(--ef-text-primary)] truncate">
            {signal.title}
          </p>
        </div>

        {/* Signal type chip */}
        <div className="flex-shrink-0">
          <span className="inline-block rounded px-2 py-0.5 text-[11px] font-mono bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)] border border-[var(--ef-surface-elevated)]">
            {signal.signal_type}
          </span>
        </div>

        {/* Entity link if available */}
        {entityLink && (
          <div className="flex-shrink-0 text-[11px]">
            <Link
              href={entityLink}
              onClick={(e) => e.stopPropagation()}
              className="text-[var(--ef-purple-primary)] hover:underline"
            >
              {signal.entity_type} {signal.entity_id}
            </Link>
          </div>
        )}

        {/* Status badge */}
        <StatusBadge status={signal.status} />

        {/* Created date */}
        <div className="flex-shrink-0 text-[11px] text-[var(--ef-text-muted)] whitespace-nowrap">
          {createdDate}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="bg-[var(--ef-surface-elevated)] px-4 py-3 border-t border-[var(--ef-surface-elevated)]">
          {/* Description */}
          {signal.description && (
            <div className="mb-3">
              <p className="text-[11px] font-medium text-[var(--ef-text-muted)] mb-1">Description</p>
              <p className="text-[11px] text-[var(--ef-text-primary)]">{signal.description}</p>
            </div>
          )}

          {/* Metrics */}
          {signal.metrics && Object.keys(signal.metrics).length > 0 && (
            <div className="mb-3">
              <p className="text-[11px] font-medium text-[var(--ef-text-muted)] mb-2">Metrics</p>
              <div className="space-y-1">
                {Object.entries(signal.metrics).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--ef-text-muted)]">{key}:</span>
                    <span className="text-[11px] text-[var(--ef-text-primary)] font-mono">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          {signal.status === 'active' && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--ef-surface-elevated)]">
              <button
                onClick={handleResolve}
                disabled={isUpdating}
                className="text-[11px] px-2 py-1 rounded border border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] text-[var(--ef-success)] hover:bg-[var(--ef-success-a20)] disabled:opacity-60 transition-colors"
              >
                {isUpdating ? 'Updating...' : 'Resolve'}
              </button>
              <button
                onClick={handleIgnore}
                disabled={isUpdating}
                className="text-[11px] px-2 py-1 rounded border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] disabled:opacity-60 transition-colors"
              >
                {isUpdating ? 'Updating...' : 'Ignore'}
              </button>
              {updateError && (
                <span className="text-[11px] text-[var(--ef-critical)]">{updateError}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page Component ──────────────────────────────────────────────────

export default function SignalsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');

  // Fetch signals from Supabase
  const fetchSignals = async (orgId: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('signals')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });

      if (fetchError) {
        setError('Failed to load signals');
        setSignals([]);
      } else {
        setSignals((data || []) as Signal[]);
      }
    } catch {
      setError('Failed to load signals');
      setSignals([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchSignals(organizationId);
  }, [organizationId, orgLoading]);

  // Client-side filtering
  const filteredSignals = useMemo(() => {
    let list = signals;
    if (filterStatus) {
      list = list.filter((s) => s.status === filterStatus);
    }
    if (filterSeverity) {
      list = list.filter((s) => s.severity === filterSeverity);
    }
    return list;
  }, [signals, filterStatus, filterSeverity]);

  // Summary counts
  const summary = useMemo(() => {
    return {
      active: signals.filter((s) => s.status === 'active').length,
      resolved: signals.filter((s) => s.status === 'resolved').length,
      critical: signals.filter((s) => s.severity === 'critical').length,
    };
  }, [signals]);

  const hasActiveFilter = !!(filterStatus || filterSeverity);

  const handleStatusChange = (id: string, newStatus: string) => {
    setSignals((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: newStatus } : s))
    );
  };

  const isLoading = orgLoading || loading;

  return (
    <div className="space-y-4">
      {/* Header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">Signals</h2>
          <p className="text-xs text-[var(--ef-text-muted)]">
            Operational anomalies and exceptions surfaced during document processing. Signals are generated automatically when the system detects patterns that warrant attention.
          </p>
        </div>
      </section>

      {/* Summary counts */}
      {!isLoading && signals.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-text-muted)]">Active</p>
            <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{summary.active}</p>
          </div>
          <div className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-text-muted)]">Resolved</p>
            <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{summary.resolved}</p>
          </div>
          <div className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-text-muted)]">Critical</p>
            <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{summary.critical}</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Status</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
          <span className="font-medium text-[var(--ef-text-primary)]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        {hasActiveFilter && (
          <button
            type="button"
            onClick={() => {
              setFilterStatus('');
              setFilterSeverity('');
            }}
            className="rounded-md border border-[var(--ef-surface-elevated)] px-2 py-1.5 text-[11px] text-[var(--ef-text-muted)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Signals list */}
      <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        {error && (
          <div className="mb-3 rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2">
            <p className="text-[11px] font-medium text-[var(--ef-critical)]">{error}</p>
          </div>
        )}

        {isLoading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading...</p>
        ) : filteredSignals.length === 0 ? (
          <div className="py-5 text-center">
            <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">
              {hasActiveFilter ? 'No signals match the current filters' : 'No signals detected'}
            </p>
            <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
              {hasActiveFilter
                ? 'Try clearing the filters to see all signals.'
                : 'Signals appear here automatically when EightForge detects anomalies during document processing — such as rate mismatches, missing fields, or compliance flags.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--ef-surface-elevated)]">
            {filteredSignals.map((signal) => (
              <SignalRow
                key={signal.id}
                signal={signal}
                onStatusChange={handleStatusChange}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
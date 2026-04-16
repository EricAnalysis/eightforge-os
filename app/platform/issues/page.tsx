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
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-red-500/20 text-red-400 border border-red-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    resolved: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    ignored: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
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
    <div className="border-b border-[#1A1A3E] last:border-0">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-3 py-3 px-2 cursor-pointer hover:bg-[#12122E] transition-colors"
      >
        {/* Severity badge */}
        <SeverityBadge severity={signal.severity} />

        {/* Title */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-[#F5F7FA] truncate">
            {signal.title}
          </p>
        </div>

        {/* Signal type chip */}
        <div className="flex-shrink-0">
          <span className="inline-block rounded px-2 py-0.5 text-[11px] font-mono bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]">
            {signal.signal_type}
          </span>
        </div>

        {/* Entity link if available */}
        {entityLink && (
          <div className="flex-shrink-0 text-[11px]">
            <Link
              href={entityLink}
              onClick={(e) => e.stopPropagation()}
              className="text-[#8B5CFF] hover:underline"
            >
              {signal.entity_type} {signal.entity_id}
            </Link>
          </div>
        )}

        {/* Status badge */}
        <StatusBadge status={signal.status} />

        {/* Created date */}
        <div className="flex-shrink-0 text-[11px] text-[#8B94A3] whitespace-nowrap">
          {createdDate}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="bg-[#12122E] px-4 py-3 border-t border-[#1A1A3E]">
          {/* Description */}
          {signal.description && (
            <div className="mb-3">
              <p className="text-[11px] font-medium text-[#8B94A3] mb-1">Description</p>
              <p className="text-[11px] text-[#F5F7FA]">{signal.description}</p>
            </div>
          )}

          {/* Metrics */}
          {signal.metrics && Object.keys(signal.metrics).length > 0 && (
            <div className="mb-3">
              <p className="text-[11px] font-medium text-[#8B94A3] mb-2">Metrics</p>
              <div className="space-y-1">
                {Object.entries(signal.metrics).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[11px] text-[#8B94A3]">{key}:</span>
                    <span className="text-[11px] text-[#F5F7FA] font-mono">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          {signal.status === 'active' && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#1A1A3E]">
              <button
                onClick={handleResolve}
                disabled={isUpdating}
                className="text-[11px] px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-60 transition-colors"
              >
                {isUpdating ? 'Updating...' : 'Resolve'}
              </button>
              <button
                onClick={handleIgnore}
                disabled={isUpdating}
                className="text-[11px] px-2 py-1 rounded border border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3] hover:bg-[#1A1A3E] disabled:opacity-60 transition-colors"
              >
                {isUpdating ? 'Updating...' : 'Ignore'}
              </button>
              {updateError && (
                <span className="text-[11px] text-red-400">{updateError}</span>
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
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Signals</h2>
          <p className="text-xs text-[#8B94A3]">
            Operational anomalies and exceptions surfaced during document processing. Signals are generated automatically when the system detects patterns that warrant attention.
          </p>
        </div>
      </section>

      {/* Summary counts */}
      {!isLoading && signals.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2">
            <p className="text-[11px] font-medium text-[#8B94A3]">Active</p>
            <p className="text-sm font-semibold text-[#F5F7FA]">{summary.active}</p>
          </div>
          <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2">
            <p className="text-[11px] font-medium text-[#8B94A3]">Resolved</p>
            <p className="text-sm font-semibold text-[#F5F7FA]">{summary.resolved}</p>
          </div>
          <div className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2">
            <p className="text-[11px] font-medium text-[#8B94A3]">Critical</p>
            <p className="text-sm font-semibold text-[#F5F7FA]">{summary.critical}</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Status</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
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
            className="rounded-md border border-[#1A1A3E] px-2 py-1.5 text-[11px] text-[#8B94A3] hover:bg-[#1A1A3E] hover:text-[#F5F7FA]"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Signals list */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        {error && (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{error}</p>
          </div>
        )}

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading...</p>
        ) : filteredSignals.length === 0 ? (
          <div className="py-5 text-center">
            <p className="text-[12px] font-medium text-[#F5F7FA]">
              {hasActiveFilter ? 'No signals match the current filters' : 'No signals detected'}
            </p>
            <p className="mt-1 text-[11px] text-[#8B94A3]">
              {hasActiveFilter
                ? 'Try clearing the filters to see all signals.'
                : 'Signals appear here automatically when EightForge detects anomalies during document processing — such as rate mismatches, missing fields, or compliance flags.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#1A1A3E]">
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
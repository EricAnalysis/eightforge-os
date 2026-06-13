'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import {
  deriveSpreadsheetValidatorLifecycle,
  listUnresolvedStage1Findings,
  loadSpreadsheetValidatorOverrides,
  readValidationStatusFromSummaryJson,
  resolveTicketOverrideTargetId,
  saveSpreadsheetValidatorOverrides,
  type SpreadsheetFactWorkspaceDatasetSummary,
  type SpreadsheetValidatorLifecycleStatus,
} from '@/lib/spreadsheetDocumentReview';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function fmt$(amount: number | undefined | null): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtNum(n: number | undefined | null): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

const LIFECYCLE_LABEL: Record<SpreadsheetValidatorLifecycleStatus, string> = {
  not_reviewed: 'Not reviewed',
  in_review: 'In review',
  validated: 'Validated',
  blocked: 'Blocked',
  exceptions_approved: 'Exceptions approved',
};

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#7F90AA]">{label}</p>
      <p className="mt-1 text-[13px] font-semibold tabular-nums text-[#E5EDF7]">{value}</p>
    </div>
  );
}

export function SpreadsheetDatasetSummaryPanel({
  model,
  projectId,
  documentId,
}: {
  model: DocumentIntelligenceViewModel;
  projectId: string | null;
  documentId: string;
}) {
  const data = model.spreadsheetFactWorkspaceDatasetSummary;
  const [summaryRaw, setSummaryRaw] = useState<unknown>(null);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [evidence, setEvidence] = useState<ValidationEvidence[]>([]);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [overrideEpoch, setOverrideEpoch] = useState(0);

  useEffect(() => {
    const bump = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; documentId?: string }>).detail;
      if (detail?.projectId === projectId && detail?.documentId === documentId) {
        setOverrideEpoch((v) => v + 1);
      }
    };
    window.addEventListener('eightforge-spreadsheet-overrides-changed', bump as EventListener);
    return () => window.removeEventListener('eightforge-spreadsheet-overrides-changed', bump as EventListener);
  }, [projectId, documentId]);

  useEffect(() => {
    if (!projectId) {
      setSummaryRaw(null);
      setFindings([]);
      setEvidence([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setLoading(true);
      try {
        const [projectResult, findingsResult] = await Promise.all([
          supabase.from('projects').select('validation_summary_json').eq('id', projectId).maybeSingle(),
          supabase
            .from('project_validation_findings')
            .select('*')
            .eq('project_id', projectId)
            .eq('status', 'open'),
        ]);

        if (projectResult.error) throw new Error(projectResult.error.message);
        if (findingsResult.error) throw new Error(findingsResult.error.message);

        const openFindings = ((findingsResult.data ?? []) as ValidationFinding[]).filter(
          (f) => f.status === 'open',
        );

        let ev: ValidationEvidence[] = [];
        if (openFindings.length > 0) {
          const evidenceResult = await supabase
            .from('project_validation_evidence')
            .select('*')
            .in('finding_id', openFindings.map((f) => f.id));
          if (evidenceResult.error) throw new Error(evidenceResult.error.message);
          ev = (evidenceResult.data ?? []) as ValidationEvidence[];
        }

        if (cancelled) return;
        setSummaryRaw(isRecord(projectResult.data) ? projectResult.data.validation_summary_json ?? null : null);
        setFindings(openFindings);
        setEvidence(ev);
      } catch {
        if (!cancelled) {
          setSummaryRaw(null);
          setFindings([]);
          setEvidence([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId]);

  const overrideStore = useMemo(
    () => loadSpreadsheetValidatorOverrides(projectId, documentId),
    [projectId, documentId, overrideEpoch],
  );

  const evidenceByFindingId = useMemo(() => {
    const m = new Map<string, ValidationEvidence[]>();
    for (const ev of evidence) {
      const list = m.get(ev.finding_id) ?? [];
      list.push(ev);
      m.set(ev.finding_id, list);
    }
    return m;
  }, [evidence]);

  const validationStatus = readValidationStatusFromSummaryJson(summaryRaw);
  const evidenceForStage1 = useMemo(() => {
    const m = new Map<string, { record_id: string | null }[]>();
    for (const [findingId, list] of evidenceByFindingId) {
      m.set(
        findingId,
        list.map((row) => ({ record_id: row.record_id })),
      );
    }
    return m;
  }, [evidenceByFindingId]);

  const unresolved = useMemo(
    () => listUnresolvedStage1Findings(findings, evidenceForStage1, overrideStore),
    [findings, evidenceForStage1, overrideStore],
  );

  const hadValidatorRun = summaryRaw != null || findings.length > 0;
  const lifecycle = deriveSpreadsheetValidatorLifecycle({
    validationStatus,
    unresolvedActionableCount: unresolved.length,
    hadValidatorRun,
  });

  const stage1Href =
    projectId != null && projectId.length > 0
      ? `/platform/workspace/projects/${encodeURIComponent(projectId)}?tab=validator`
      : null;

  if (!data) return null;

  return (
    <div className="border-b border-white/8 bg-[#070F18] px-4 py-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">Dataset Summary</p>
        <p className="mt-1 text-[11px] text-[#8FA1BC]">
          Operational metrics from this ticket export.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <MetricCell label="Total Tickets" value={fmtNum(data.totalTickets)} />
        <MetricCell label="Total Net Tonnage" value={fmtNum(data.totalNetTonnage)} />
        <MetricCell label="Invoiced Tickets" value={fmtNum(data.invoicedTickets)} />
        <MetricCell label="Total Invoices" value={fmtNum(data.totalInvoices)} />
        <MetricCell label="Total $ Invoiced" value={fmt$(data.totalDollarInvoiced)} />
        <MetricCell label="Uninvoiced Lines" value={fmtNum(data.uninvoicedLines)} />
        <MetricCell label="Eligible" value={fmtNum(data.eligible)} />
        <MetricCell label="Ineligible" value={fmtNum(data.ineligible)} />
        <MetricCell label="Unknown Eligibility" value={fmtNum(data.unknownEligibility)} />
        <MetricCell label="Mobile Tickets" value={fmtNum(data.mobileTickets)} />
        <MetricCell label="Mobile Unit Tickets" value={fmtNum(data.mobileUnitTickets)} />
        <MetricCell label="Load Tickets" value={fmtNum(data.loadTickets)} />
        {data.unknownTicketTypeCount > 0 ? (
          <MetricCell label="Unknown Ticket Type" value={fmtNum(data.unknownTicketTypeCount)} />
        ) : null}
      </div>

      {projectId && unresolved.length > 0 ? (
        <details className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
          <summary className="cursor-pointer list-none text-[11px] font-semibold text-[#E5EDF7]">
            Stage 1 overrides · {unresolved.length} unresolved finding{unresolved.length !== 1 ? 's' : ''}
          </summary>
          <ul className="mt-2 space-y-3 border-t border-white/8 pt-3">
            {unresolved.slice(0, 12).map((finding) => (
              <li key={finding.id} className="text-[11px] text-[#B8C5DA]">
                <p className="font-medium text-[#E5EDF7]">
                  {finding.check_key}
                  <span className="ml-2 text-[#7F90AA]">({finding.severity})</span>
                </p>
                <OverrideFindingActions
                  projectId={projectId}
                  documentId={documentId}
                  finding={finding}
                  evidence={evidenceByFindingId.get(finding.id) ?? []}
                  onSaved={() => setOverrideEpoch((v) => v + 1)}
                />
              </li>
            ))}
          </ul>
          {unresolved.length > 12 ? (
            <p className="mt-2 text-[10px] text-[#5A7090]">Showing first 12. Resolve the rest in the project validator.</p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function OverrideFindingActions({
  projectId,
  documentId,
  finding,
  evidence,
  onSaved,
}: {
  projectId: string;
  documentId: string;
  finding: ValidationFinding;
  evidence: ValidationEvidence[];
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const ticketRecordId = resolveTicketOverrideTargetId(finding, evidence);

  const persist = async (scope: 'check' | 'ticket', targetId: string) => {
    const r = reason.trim();
    if (!r) return;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const label =
        user?.email?.trim()
        || user?.id?.trim()
        || 'unknown_user';
      const store = loadSpreadsheetValidatorOverrides(projectId, documentId);
      const row = {
        scope,
        targetId,
        reason: r,
        notes: notes.trim() || null,
        user: label,
        timestamp: new Date().toISOString(),
      };
      if (scope === 'check') {
        store.byCheck[finding.id] = row;
      } else {
        store.byTicket[targetId] = row;
      }
      saveSpreadsheetValidatorOverrides(projectId, documentId, store);
      setReason('');
      setNotes('');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        className="w-full rounded border border-white/10 bg-[#050A14] px-2 py-1 text-[11px] text-[#E5EDF7]"
      />
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        className="w-full rounded border border-white/10 bg-[#050A14] px-2 py-1 text-[11px] text-[#E5EDF7]"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving || reason.trim().length === 0}
          onClick={() => void persist('check', finding.id)}
          className="rounded border border-white/15 bg-white/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#93C5FD] hover:bg-white/[0.07] disabled:opacity-40"
        >
          Skip this finding
        </button>
        {ticketRecordId ? (
          <button
            type="button"
            disabled={saving || reason.trim().length === 0}
            onClick={() => void persist('ticket', ticketRecordId)}
            className="rounded border border-white/15 bg-white/[0.04] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#C4B5FD] hover:bg-white/[0.07] disabled:opacity-40"
          >
            Mark ticket approved
          </button>
        ) : null}
      </div>
    </div>
  );
}

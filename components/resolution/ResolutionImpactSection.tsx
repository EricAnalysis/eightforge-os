'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import type { ResolutionImpact } from '@/lib/resolution/resolutionImpact';
import type { ResolutionPreviewInput } from '@/lib/resolution/resolutionPreviewInput';
import { supabase } from '@/lib/supabaseClient';

/**
 * Projected impact of the operator's candidate action (B5-C). Displays what
 * the server computed by running the Validator with and without the action;
 * it computes, estimates and infers nothing itself. A preview is shown only
 * for the exact case state and candidate it was computed for: a change to the
 * candidate hides it, and a refreshed case recomputes it. It grants no
 * authority: submitting never depends on it.
 */

type PreviewState = Readonly<{
  requestKey: string;
  actionsKey: string;
  inputKey: string;
  impact: ResolutionImpact | null;
  error: string | null;
  loading: boolean;
}>;

function currency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function ResolutionImpactView({ impact }: { impact: ResolutionImpact }) {
  const [open, setOpen] = useState(false);
  if (impact.status !== 'available') {
    return (
      <div data-testid="resolution-impact-unavailable" className="text-xs text-[var(--ef-text-muted)]">
        <p className="text-[var(--ef-text-secondary)]">Impact cannot yet be computed for this action.</p>
        <p className="mt-1">{impact.reason}</p>
      </div>
    );
  }
  const cleared = impact.blockersBefore - impact.blockersAfter;
  const exposure = impact.financialExposureDelta;
  return (
    <div data-testid="resolution-impact-available" className="space-y-1 text-xs">
      <p className="text-[var(--ef-success)]">✓ Resolves {plural(impact.resolves.length, 'finding')}</p>
      {cleared > 0 ? <p className="text-[var(--ef-success)]">✓ Clears {plural(cleared, 'approval blocker')}</p> : null}
      {cleared < 0 ? <p className="text-[var(--ef-critical)]">+ Adds {plural(-cleared, 'approval blocker')}</p> : null}
      {cleared === 0 ? <p className="text-[var(--ef-text-secondary)]">Approval blockers unchanged ({impact.blockersBefore})</p> : null}
      {impact.resolvesCaseIds.length > 0 ? (
        <p className="text-[var(--ef-success)]">✓ Closes {plural(impact.resolvesCaseIds.length, 'case')} in this queue</p>
      ) : null}
      <p className="text-[var(--ef-text-secondary)]">Affects {plural(impact.affectedInvoiceLines.length, 'invoice line')}</p>
      <p className={impact.opens.length > 0 ? 'text-[var(--ef-critical)]' : 'text-[var(--ef-text-secondary)]'}>
        + Opens {plural(impact.opens.length, 'new finding')}
      </p>
      {impact.changes.length > 0 ? (
        <p className="text-[var(--ef-warning)]">~ Changes {plural(impact.changes.length, 'finding')}</p>
      ) : null}
      <p className="text-[var(--ef-text-muted)]">
        Open findings {impact.findingsBefore} → {impact.findingsAfter} · approval {impact.approvalBefore} → {impact.approvalAfter}
      </p>
      {exposure ? (
        <p className="text-[var(--ef-text-muted)]">
          At risk {currency(exposure.totalAtRiskAmount.before)} → {currency(exposure.totalAtRiskAmount.after)}
          {' · '}contract-supported {currency(exposure.totalContractSupportedAmount.before)} → {currency(exposure.totalContractSupportedAmount.after)}
        </p>
      ) : null}
      {impact.resolves.length + impact.opens.length + impact.changes.length > 0 ? (
        <div>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
            className="text-[var(--ef-purple-primary)] underline">
            {open ? 'Hide affected findings' : 'View affected findings'}
          </button>
          {open ? (
            <ul className="mt-1 space-y-1" data-testid="resolution-impact-findings">
              {impact.resolves.map((finding) => (
                <li key={`r:${finding.findingKey}`}>Resolves · {finding.title}{finding.blocksApproval ? ' (blocker)' : ''}</li>
              ))}
              {impact.opens.map((finding) => (
                <li key={`o:${finding.findingKey}`} className="text-[var(--ef-critical)]">
                  Opens · {finding.title}{finding.blocksApproval ? ' (blocker)' : ''}
                </li>
              ))}
              {impact.changes.map((finding) => (
                <li key={`c:${finding.findingKey}`}>
                  Changes · {finding.title} (
                  {finding.before.severity !== finding.after.severity
                    ? `${finding.before.severity} → ${finding.after.severity}`
                    : `found ${finding.before.actual ?? '—'} → ${finding.after.actual ?? '—'}`})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ResolutionImpactSection({ entry, input, automatic = false }: {
  entry: ResolutionCase;
  /** The candidate decision; null while it is incomplete. */
  input: ResolutionPreviewInput | null;
  /** Ask the server without a click (actions whose answer needs no candidate value). */
  automatic?: boolean;
}) {
  const [state, setState] = useState<PreviewState | null>(null);
  const actionsKey = JSON.stringify(entry.actions);
  const inputKey = JSON.stringify(input);

  const compute = useCallback(async () => {
    if (!input) return;
    const requestKey = `${actionsKey}|${inputKey}`;
    setState({ requestKey, actionsKey, inputKey, impact: null, error: null, loading: true });
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setState({ requestKey, actionsKey, inputKey, impact: null, error: 'Authentication required.', loading: false });
      return;
    }
    const response = await fetch(`/api/projects/${encodeURIComponent(entry.projectId)}/resolution-cases/impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ caseId: entry.caseId, input }),
    });
    const body = await response.json().catch(() => null) as ResolutionImpact | null;
    setState((current) => current?.requestKey !== requestKey ? current : {
      requestKey, actionsKey, inputKey, loading: false,
      impact: response.ok && body && body.caseId === entry.caseId ? body : null,
      error: response.ok ? null : 'Impact could not be computed.',
    });
  }, [actionsKey, entry.caseId, entry.projectId, input, inputKey]);

  // The case was refreshed from the server (new chain head or evidence): a
  // preview computed for the old state is recomputed, never reused.
  const caseChanged = state != null && state.actionsKey !== actionsKey && state.inputKey === inputKey;
  const shouldAutoLoad = automatic && input != null && state == null;
  useEffect(() => {
    if (!caseChanged && !shouldAutoLoad) return;
    void (async () => { await compute(); })();
  }, [caseChanged, compute, shouldAutoLoad]);

  const current = state && state.actionsKey === actionsKey && state.inputKey === inputKey ? state : null;
  const stale = state != null && !current;

  return (
    <section className="rounded border border-white/10 p-3" data-testid="resolution-impact" aria-live="polite">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">Projected impact</p>
      <div className="mt-2">
        {current?.loading ? <p className="text-xs text-[var(--ef-text-muted)]">Running the Validator with this change…</p> : null}
        {current?.error ? <p className="text-xs text-[var(--ef-critical)]">{current.error}</p> : null}
        {current?.impact ? <ResolutionImpactView impact={current.impact} /> : null}
        {stale && !current ? <p className="text-xs text-[var(--ef-text-muted)]">Changed since the last preview.</p> : null}
        {!automatic && !current?.loading ? (
          <button type="button" disabled={!input} onClick={() => void compute()}
            className="mt-2 rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)] disabled:opacity-50">
            {current?.impact ? 'Preview again' : 'Preview impact'}
          </button>
        ) : null}
        <p className="mt-2 text-[10px] text-[var(--ef-text-faint)]">
          Computed by the Validator in memory. Nothing is saved, and the preview is not approval.
        </p>
      </div>
    </section>
  );
}

'use client';

import { useEffect, useState } from 'react';

import { investigationUnavailableMessage, rankedActionLabels } from '@/lib/caseInvestigationView';
import { supabase } from '@/lib/supabaseClient';

/**
 * Operator-invoked Forgewing investigation of one Validator finding (P3b),
 * with its durable history (P3c). Non-authoritative: it explains and ranks
 * the case's own navigation actions. It offers no decision and no action
 * button; the operator acts through the case's existing controls.
 */

type Investigation = Readonly<{
  id?: string;
  diagnosis: string;
  rationale: string;
  rankedActionKinds: readonly string[];
  evidenceCount: number;
  model: string | null;
  createdAt: string | null;
}>;

type HistoryRow = Readonly<{
  id: string; diagnosis: string; rationale: string; ranked_action_kinds: string[];
  evidence_refs: unknown[]; model: string; created_at: string;
}>;

function fromHistory(row: HistoryRow): Investigation {
  return { id: row.id, diagnosis: row.diagnosis, rationale: row.rationale, rankedActionKinds: row.ranked_action_kinds,
    evidenceCount: Array.isArray(row.evidence_refs) ? row.evidence_refs.length : 0, model: row.model, createdAt: row.created_at };
}

async function authorizedFetch(url: string, init?: RequestInit): Promise<Response | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${session.access_token}` },
  });
}

export function CaseInvestigationPanel({ projectId, caseId }: { projectId: string; caseId: string }) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/resolution-cases/investigation`;
  const [latest, setLatest] = useState<Investigation | null>(null);
  const [earlier, setEarlier] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await authorizedFetch(`${endpoint}?caseId=${encodeURIComponent(caseId)}`);
      if (!response || !response.ok || cancelled) return;
      const body = await response.json().catch(() => ({})) as { investigations?: HistoryRow[] };
      const rows = body.investigations ?? [];
      if (cancelled) return;
      setLatest(rows[0] ? fromHistory(rows[0]) : null);
      setEarlier(Math.max(0, rows.length - 1));
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [endpoint, caseId]);

  const investigate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch(endpoint, { method: 'POST', body: JSON.stringify({ caseId }) });
      if (!response) {
        setMessage('Your session has expired. Please sign in again.');
        return;
      }
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok && body.status === 'proposed' && body.investigation && typeof body.investigation === 'object') {
        const result = body.investigation as { diagnosis: string; rationale: string; rankedActionKinds: string[];
          evidenceRefs: unknown[]; providerModel: string };
        if (latest) setEarlier((count) => count + 1);
        setLatest({ diagnosis: result.diagnosis, rationale: result.rationale, rankedActionKinds: result.rankedActionKinds,
          evidenceCount: result.evidenceRefs.length, model: result.providerModel, createdAt: new Date().toISOString() });
        return;
      }
      setMessage(investigationUnavailableMessage(body));
    } catch {
      setMessage('Forgewing case investigation is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const labels = latest ? rankedActionLabels(latest.rankedActionKinds) : [];
  return (
    <section className="space-y-2 rounded border border-[var(--ef-purple-primary-a30)] p-3" data-testid="forgewing-case-investigation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
          Forgewing investigation · Non-authoritative · Not a decision
        </p>
        <button type="button" disabled={busy} onClick={() => void investigate()}
          className="rounded border border-white/10 px-2 py-0.5 text-xs text-[var(--ef-text-primary)] disabled:opacity-50">
          {busy ? 'Investigating…' : latest ? 'Investigate again' : 'Investigate with Forgewing'}
        </button>
      </div>
      {message ? <p role="status" className="text-xs text-[var(--ef-text-secondary)]">{message}</p> : null}
      {latest ? (
        <div className="space-y-1 text-xs">
          <p className="text-[var(--ef-text-primary)]">{latest.diagnosis}</p>
          <p className="text-[var(--ef-text-secondary)]">{latest.rationale}</p>
          {labels.length > 0 ? (
            <ol className="list-decimal space-y-0.5 pl-4 text-[var(--ef-text-secondary)]">
              {labels.map((label) => <li key={label}>{label}</li>)}
            </ol>
          ) : null}
          <p className="text-[10px] text-[var(--ef-text-muted)]">
            Cites {latest.evidenceCount} case record{latest.evidenceCount === 1 ? '' : 's'}
            {latest.model ? ` · ${latest.model}` : ''}
            {latest.createdAt ? ` · ${new Date(latest.createdAt).toLocaleString()}` : ''}
            {earlier > 0 ? ` · ${earlier} earlier investigation${earlier === 1 ? '' : 's'} kept` : ''}
            . Use the controls below to act.
          </p>
        </div>
      ) : null}
    </section>
  );
}

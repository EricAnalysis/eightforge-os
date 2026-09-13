'use client';

import { useCallback, useEffect, useState } from 'react';

import { SourceEvidencePage } from '@/components/recovery/SourceEvidencePage';
import type { DocumentDiagnostic } from '@/lib/server/documentDiagnosticsRead';
import { supabase } from '@/lib/supabaseClient';

const SIGNED_URL_REUSE_MS = 240_000;

const STATE_LABEL: Record<DocumentDiagnostic['currentState'], string> = {
  detected: 'Detected',
  recovery_available: 'Recovery available',
  human_review_required: 'Human review required',
  reprocess_required: 'Reprocess required',
  unbound: 'Evidence unbound',
  blocked: 'Blocked',
  engineering_attention: 'Engineering attention',
  deferred: 'Review postponed',
  not_recovered: 'Not recovered',
  resolved: 'Resolved',
};

async function authorizedFetch(input: string): Promise<Response | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return fetch(input, { headers: { Authorization: `Bearer ${session.access_token}` } });
}
export function DiagnosticsPanel({ documentId }: { documentId: string }) {
  const [diagnostics, setDiagnostics] = useState<readonly DocumentDiagnostic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);
  const [source, setSource] = useState<{ url: string; expiresAt: number } | null>(null);

  const load = useCallback(async () => {
    const response = await authorizedFetch(
      `/api/internal/document-diagnostics?documentId=${encodeURIComponent(documentId)}`,
    );
    const body = await response?.json().catch(() => null);
    if (!response?.ok || !body?.ok) {
      setDiagnostics([]);
      setError(response?.status === 503 ? null : 'Diagnostics could not be loaded.');
      return;
    }
    setDiagnostics(body.diagnostics ?? []);
    setError(null);
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  const toggleEvidence = async (diagnostic: DocumentDiagnostic) => {
    if (openEvidenceId === diagnostic.diagnosticId) {
      setOpenEvidenceId(null);
      return;
    }
    if (!diagnostic.visualEvidence) return;
    setOpenEvidenceId(diagnostic.diagnosticId);
    if (source && Date.now() < source.expiresAt) return;
    const response = await authorizedFetch(`/api/documents/${encodeURIComponent(documentId)}/file`);
    const body = await response?.json().catch(() => null);
    if (!response?.ok || typeof body?.signedUrl !== 'string') {
      setOpenEvidenceId(null);
      setSource(null);
      setError('The authenticated source file could not be loaded.');
      return;
    }
    setSource({ url: body.signedUrl, expiresAt: Date.now() + SIGNED_URL_REUSE_MS });
  };

  if (diagnostics.length === 0 && !error) return null;
  const actionable = diagnostics.filter((entry) => entry.severity !== 'info').length;

  return <section className="rounded-lg border border-white/5 bg-[var(--ef-background-secondary)] p-4"
    data-testid="document-diagnostics-panel">
    <header className="mb-3">
      <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Failure diagnostics</h3>
      <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
        {actionable} actionable · {diagnostics.length} total. Diagnostics do not change document truth.
      </p>
    </header>
    {error ? <p className="text-xs text-[var(--ef-critical)]">{error}</p> : null}
    <div className="space-y-2">
      {diagnostics.map((diagnostic) => <details key={diagnostic.diagnosticId}
        open={diagnostic.severity !== 'info'}
        className="rounded border border-white/5 bg-[var(--ef-surface-elevated)] p-3">
        <summary className="cursor-pointer text-xs text-[var(--ef-text-primary)]">
          <span className="font-medium">{diagnostic.code.replaceAll('_', ' ')}</span>
          <span className="ml-2 text-[var(--ef-text-muted)]">
            {diagnostic.scope.physicalPageNumber ? `Page ${diagnostic.scope.physicalPageNumber} · ` : ''}
            {STATE_LABEL[diagnostic.currentState]}
          </span>
        </summary>
        <div className="mt-3 space-y-2 text-xs">
          <p className="whitespace-pre-wrap text-[var(--ef-text-primary)]">{diagnostic.summary}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--ef-text-muted)]">
            <dt>Severity</dt><dd>{diagnostic.severity}</dd>
            <dt>Recoverability</dt><dd>{diagnostic.recoverability.replaceAll('_', ' ')}</dd>
            <dt>Next</dt><dd>{diagnostic.recommendedNextAction.replaceAll('_', ' ')}</dd>
          </dl>
          <div className="flex flex-wrap gap-3">
            {diagnostic.recoveryProposalId ? <a
              href={`#recovery-proposal-${encodeURIComponent(diagnostic.recoveryProposalId)}`}
              className="text-[var(--ef-purple-accent)] underline">Open existing recovery review</a>
              : diagnostic.recoverability === 'recoverable_after_human_review'
                ? <span className="text-[var(--ef-warning)]">
                    Recovery exists for this failure type, but no proposal has been generated.
                  </span> : null}
            {diagnostic.visualEvidence ? <button type="button"
              className="text-[var(--ef-purple-accent)] underline"
              onClick={() => void toggleEvidence(diagnostic)}>
              {openEvidenceId === diagnostic.diagnosticId ? 'Hide evidence' : 'View evidence'}
            </button> : null}
          </div>
          {openEvidenceId === diagnostic.diagnosticId && source && diagnostic.visualEvidence
            ? <div className="flex h-[28rem] min-h-0 overflow-hidden rounded border border-white/5">
                <SourceEvidencePage sourceUrl={source.url} evidence={diagnostic.visualEvidence} />
              </div> : null}
        </div>
      </details>)}
    </div>
  </section>;
}

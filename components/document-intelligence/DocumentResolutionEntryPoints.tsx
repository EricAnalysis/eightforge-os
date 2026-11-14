'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { resolutionWorkspaceHref } from '@/lib/resolution/resolutionDeepLink';
import type { ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { supabase } from '@/lib/supabaseClient';

/** Current, server-derived priced-line cases for one document; navigation only. */
export function documentCorrectionCases(queue: ResolutionQueue, documentId: string): ResolutionCase[] {
  if (!documentId) return [];
  const order = queue.groups.flatMap((group) => group.caseIds);
  const byId = new Map(queue.cases.map((entry) => [entry.caseId, entry]));
  return order.flatMap((id) => {
    const entry = byId.get(id);
    return entry?.documentId === documentId && entry.sourceRefs.anchorKey
      && entry.actions.some((action) => action.kind === 'enter_reviewed_value' || action.kind === 'withdraw_reviewed_value')
      ? [entry] : [];
  });
}

export function DocumentResolutionCaseList({ projectId, documentId, cases, error = false }: {
  projectId: string; documentId: string; cases: readonly ResolutionCase[]; error?: boolean;
}) {
  if (cases.length === 0 && !error) return null;
  return <section className="rounded-2xl border border-white/10 bg-[var(--ef-background-secondary)] px-4 py-3"
    data-testid="document-resolution-entry-points">
    <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Source rows needing review</h3>
    {error ? <p className="mt-1 text-xs text-[var(--ef-warning)]">Current correction cases could not be loaded.</p> : null}
    <ul className="mt-2 space-y-2">
      {cases.map((entry) => <li key={entry.caseId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="min-w-0 text-[var(--ef-text-secondary)]">
          Page {entry.physicalPageNumber ?? '?'} · {entry.originalSourceText ?? entry.title}
          {entry.alsoUnresolved?.includes('category') || entry.kind === 'category_review' ? ' · Category review' : ''}
        </span>
        <Link href={resolutionWorkspaceHref(projectId, { caseId: entry.caseId,
          documentId, anchorKey: entry.sourceRefs.anchorKey })}
          className="shrink-0 font-semibold text-[var(--ef-purple-primary)] hover:underline">
          Review in Resolution Workspace
        </Link>
      </li>)}
    </ul>
  </section>;
}

export function DocumentResolutionEntryPoints({ projectId, documentId }: { projectId: string | null; documentId: string }) {
  const [cases, setCases] = useState<ResolutionCase[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const scope = `${projectId ?? ''}:${documentId}`;
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { if (!cancelled) { setCases([]); setLoadedScope(scope); setError(true); } return; }
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/resolution-cases`, {
          headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store',
        });
        if (!response.ok) throw new Error('Resolution queue unavailable');
        const queue = await response.json() as ResolutionQueue;
        if (queue.projectId !== projectId) throw new Error('Project identity mismatch');
        if (!cancelled) { setCases(documentCorrectionCases(queue, documentId)); setLoadedScope(scope); setError(false); }
      } catch { if (!cancelled) { setCases([]); setLoadedScope(scope); setError(true); } }
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [projectId, documentId, scope]);
  return projectId ? <DocumentResolutionCaseList projectId={projectId} documentId={documentId}
    cases={loadedScope === scope ? cases : []} error={loadedScope === scope && error} /> : null;
}

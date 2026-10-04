'use client';

import { Suspense, use } from 'react';
import { useSearchParams } from 'next/navigation';

import { ResolutionWorkspace } from '@/components/resolution/ResolutionWorkspace';

function Workspace({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  // A deep link names a record the linking surface holds; the workspace matches it against server-given cases.
  return (
    <ResolutionWorkspace projectId={projectId} link={{
      caseId: searchParams.get('case'),
      findingId: searchParams.get('finding'),
      documentId: searchParams.get('document'),
      anchorKey: searchParams.get('anchor'),
    }} />
  );
}

export default function ProjectResolvePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<p className="px-8 py-10 text-xs text-[var(--ef-text-muted)]">Loading resolution queue…</p>}>
      <Workspace projectId={id} />
    </Suspense>
  );
}

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { A3LinkageReviewWorkspace } from '@/components/evaluation/forgewing/A3LinkageReviewWorkspace';
import {
  A3_WORKSPACE_ERROR_COPY,
  isA3WorkspaceEnabled,
  loadA3WorkspaceSession,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';

export const dynamic = 'force-dynamic';

export default async function A3LinkageWorkspacePage() {
  const requestHeaders = await headers();
  if (!isA3WorkspaceEnabled({ host: requestHeaders.get('host') })) notFound();
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ef-background-primary)] p-8">
        <section className="max-w-xl rounded-2xl border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-8 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-critical)]">
            Local evaluation workspace
          </p>
          <h1 className="mt-3 text-xl font-semibold text-[var(--ef-text-primary)]">
            {A3_WORKSPACE_ERROR_COPY[loaded.code]}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--ef-text-secondary)]">
            Correct the local evaluation configuration and reload. No review decisions were loaded.
          </p>
        </section>
      </main>
    );
  }
  return <A3LinkageReviewWorkspace session={loaded.session} />;
}

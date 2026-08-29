import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { V2FieldLabelReviewWorkspace } from
  '@/components/evaluation/forgewing/V2FieldLabelReviewWorkspace';
import {
  V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY,
  isV2HumanLabelWorkspaceEnabled,
  loadV2HumanLabelWorkspace,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server';

export const dynamic = 'force-dynamic';

export default async function V2FieldLabelsPage() {
  const requestHeaders = await headers();
  if (!isV2HumanLabelWorkspaceEnabled({ host: requestHeaders.get('host') })) notFound();
  const loaded = loadV2HumanLabelWorkspace();
  if (!loaded.ok) {
    return <main className="flex min-h-screen items-center justify-center p-8">
      <section className="max-w-xl rounded-xl border border-red-500/30 bg-red-500/10 p-8 text-center">
        <p className="text-xs font-semibold uppercase">Local evaluation workspace</p>
        <h1 className="mt-3 text-xl font-semibold">
          {V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY[loaded.code]}
        </h1>
        <p className="mt-3 text-sm">Correct the provider-free replay configuration and reload.</p>
      </section>
    </main>;
  }
  return <V2FieldLabelReviewWorkspace session={loaded.loaded.session} />;
}

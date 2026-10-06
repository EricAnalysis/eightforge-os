import {
  resolveInvestigationContext,
  type InvestigationContext,
  type InvestigationPurpose,
} from '@/lib/resolution/investigationContext';
import { buildInvestigationSources } from '@/lib/server/investigationSources';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { loadProjectDocumentPrecedenceSnapshot, type ProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import {
  FORGEWING_CONTENT_CLASSES,
  resolveForgewingDataPolicy,
  type AiProviderContentClass,
} from '@/lib/server/forgewingGates';
import { readResolutionQueue, type ResolutionReadClient } from '@/lib/server/resolutionQueueRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Server read of one case's investigation context (Forgewing generalization,
 * phase 3). Composes, never recomputes: the case and its document's extraction
 * and reviewed state come from the resolution queue read; relationships from
 * the shared precedence resolver; for a provider purpose, the approved content
 * classes from the data-policy ledger. Read-only.
 */

export const DEFAULT_INVESTIGATION_TEXT_BUDGET = 12_000;

export type InvestigationContextReadResult =
  | Readonly<{ status: 'ok'; resolutionCase: ResolutionCase; context: InvestigationContext }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>;

export type InvestigationContextDependencies = Readonly<{
  admin?: ResolutionReadClient | null;
  readQueue?: typeof readResolutionQueue;
  loadPrecedence?: (query: { organizationId: string; projectId: string }) => Promise<ProjectDocumentPrecedenceSnapshot>;
  resolveDataPolicy?: typeof resolveForgewingDataPolicy;
  forgewingEnabled?: boolean;
}>;

/** Each content class approved on its own: the context transmits whatever the ledger approved. */
async function approvedContentClasses(
  admin: ResolutionReadClient,
  organizationId: string,
  resolveDataPolicy: typeof resolveForgewingDataPolicy,
): Promise<AiProviderContentClass[]> {
  const approved: AiProviderContentClass[] = [];
  for (const contentClass of FORGEWING_CONTENT_CLASSES) {
    const decision = await resolveDataPolicy(admin as never, { organizationId, provider: 'anthropic', contentClasses: [contentClass] });
    if (decision.approved) approved.push(contentClass);
  }
  return approved;
}

export async function readInvestigationContext(
  query: Readonly<{ organizationId: string; projectId: string; caseId: string; purpose: InvestigationPurpose; maxTransmittedTextChars?: number }>,
  dependencies: InvestigationContextDependencies = {},
): Promise<InvestigationContextReadResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as ResolutionReadClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const read = await (dependencies.readQueue ?? readResolutionQueue)(
    { organizationId: query.organizationId, projectId: query.projectId },
    { admin, ...(dependencies.forgewingEnabled !== undefined ? { forgewingEnabled: dependencies.forgewingEnabled } : {}) },
  );
  if (read.status !== 'ok') return read;
  const resolutionCase = read.queue.cases.find((entry) => entry.caseId === query.caseId);
  if (!resolutionCase) return { status: 'not_found' };
  const documentId = resolutionCase.documentId;

  let precedence: ProjectDocumentPrecedenceSnapshot | null = null;
  if (documentId) {
    try {
      precedence = await (dependencies.loadPrecedence
        ?? ((params) => loadProjectDocumentPrecedenceSnapshot(admin as never, params)))(
        { organizationId: query.organizationId, projectId: query.projectId });
    } catch {
      // Relationships are context, not authority: their absence is recorded as an omission.
      precedence = null;
    }
  }
  const sources = buildInvestigationSources({
    resolutionCase, cases: read.queue.cases, precedence,
    extractionDataByDocument: read.sources?.extractionDataByDocument,
    reviewedValuesByDocument: read.sources?.reviewedValuesByDocument,
  });

  const approved = query.purpose === 'provider_investigation'
    ? await approvedContentClasses(admin, query.organizationId,
      dependencies.resolveDataPolicy ?? resolveForgewingDataPolicy)
    : [];
  return {
    status: 'ok',
    resolutionCase,
    context: resolveInvestigationContext(resolutionCase, sources, {
      purpose: query.purpose,
      contentPolicy: { approvedContentClasses: approved },
      budget: { maxTransmittedTextChars: query.maxTransmittedTextChars ?? DEFAULT_INVESTIGATION_TEXT_BUDGET },
    }),
  };
}

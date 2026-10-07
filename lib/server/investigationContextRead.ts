import {
  resolveInvestigationContext,
  type InvestigationContentClass,
  type InvestigationContext,
  type InvestigationPurpose,
  type InvestigationSources,
} from '@/lib/resolution/investigationContext';
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

// Core declares its own content classes (it never consults a gate); the
// data-policy ledger's classes must be exactly these, or this fails to compile.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const CONTENT_CLASSES_MATCH: SameUnion<AiProviderContentClass, InvestigationContentClass> = true;
void CONTENT_CLASSES_MATCH;

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

function relationshipsFor(snapshot: ProjectDocumentPrecedenceSnapshot, documentId: string): InvestigationSources['documentRelationships'] {
  const resolved = snapshot.families.flatMap((family) => family.documents).find((document) => document.id === documentId) ?? null;
  return {
    family: resolved?.family ?? null,
    isGoverning: resolved?.is_governing ?? null,
    governingDocumentId: resolved?.governing_document_id ?? null,
    governingReason: resolved?.governing_reason ?? null,
    relationships: snapshot.relationships
      .filter((entry) => entry.source_document_id === documentId || entry.target_document_id === documentId)
      .map((entry) => ({ id: entry.id ?? null, type: entry.relationship_type,
        sourceDocumentId: entry.source_document_id, targetDocumentId: entry.target_document_id })),
  };
}

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

  const reviewed = documentId ? read.sources?.reviewedValuesByDocument.get(documentId) ?? null : null;
  let documentRelationships: InvestigationSources['documentRelationships'] = null;
  if (documentId) {
    try {
      const snapshot = await (dependencies.loadPrecedence
        ?? ((params) => loadProjectDocumentPrecedenceSnapshot(admin as never, params)))(
        { organizationId: query.organizationId, projectId: query.projectId });
      documentRelationships = relationshipsFor(snapshot, documentId);
    } catch {
      // Relationships are context, not authority: their absence is recorded as an omission.
      documentRelationships = null;
    }
  }

  const sources: InvestigationSources = {
    extractionData: documentId ? read.sources?.extractionDataByDocument.get(documentId) ?? null : null,
    reviewedTruth: reviewed ? {
      effective: reviewed.effective.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, value: entry.value,
        assertionId: entry.provenance.assertionId, physicalPageNumber: entry.provenance.physicalPageNumber })),
      held: reviewed.held.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, reason: entry.reason,
        assertionIds: entry.assertionIds })),
    } : null,
    findings: read.queue.cases
      .filter((entry) => entry.kind === 'validator_finding' && entry.finding && entry.documentId === documentId)
      .map((entry) => ({ id: entry.finding!.checkKey, ruleId: entry.finding!.ruleId, severity: entry.finding!.severity,
        summary: entry.problem, documentId: entry.documentId })),
    documentRelationships,
  };

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

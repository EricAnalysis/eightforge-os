import type { InvestigationSources } from '@/lib/resolution/investigationContext';
import type { DocumentReviewedValueState, ResolutionCase } from '@/lib/resolution/resolutionCases';
import type { ProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';

/**
 * The investigation sources of one case, from what the resolution queue read
 * already resolved (Forgewing generalization, phases 3-4). Shared by the
 * queue's automatic investigation and the context route, so both read a case
 * identically.
 */
export function buildInvestigationSources(params: Readonly<{
  resolutionCase: ResolutionCase;
  cases: readonly ResolutionCase[];
  extractionDataByDocument?: ReadonlyMap<string, unknown>;
  reviewedValuesByDocument?: ReadonlyMap<string, DocumentReviewedValueState>;
  precedence?: ProjectDocumentPrecedenceSnapshot | null;
}>): InvestigationSources {
  const documentId = params.resolutionCase.documentId;
  const reviewed = documentId ? params.reviewedValuesByDocument?.get(documentId) ?? null : null;
  const resolved = documentId && params.precedence
    ? params.precedence.families.flatMap((family) => family.documents).find((document) => document.id === documentId) ?? null
    : null;
  return {
    extractionData: documentId ? params.extractionDataByDocument?.get(documentId) ?? null : null,
    reviewedTruth: reviewed ? {
      effective: reviewed.effective.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, value: entry.value,
        assertionId: entry.provenance.assertionId, physicalPageNumber: entry.provenance.physicalPageNumber })),
      held: reviewed.held.map((entry) => ({ anchorKey: entry.anchorKey, factKey: entry.factKey, reason: entry.reason,
        assertionIds: entry.assertionIds })),
    } : null,
    findings: params.cases
      .filter((entry) => entry.kind === 'validator_finding' && entry.finding && entry.documentId === documentId)
      .map((entry) => ({ id: entry.finding!.checkKey, ruleId: entry.finding!.ruleId, severity: entry.finding!.severity,
        summary: entry.problem, documentId: entry.documentId })),
    documentRelationships: documentId && params.precedence ? {
      family: resolved?.family ?? null,
      isGoverning: resolved?.is_governing ?? null,
      governingDocumentId: resolved?.governing_document_id ?? null,
      governingReason: resolved?.governing_reason ?? null,
      relationships: params.precedence.relationships
        .filter((entry) => entry.source_document_id === documentId || entry.target_document_id === documentId)
        .map((entry) => ({ id: entry.id ?? null, type: entry.relationship_type,
          sourceDocumentId: entry.source_document_id, targetDocumentId: entry.target_document_id })),
    } : null,
  };
}

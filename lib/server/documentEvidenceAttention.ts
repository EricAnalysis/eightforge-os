import { pricedRowCategoryEvidence } from '@/lib/contracts/categoryReview';
import {
  reviewRequiredValueTargets,
  withheldPricedLineTargets,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { AttentionDiagnostic, DocumentEvidenceAttention } from '@/lib/resolution/resolutionCases';
import { extractionDocumentDiagnostics, type DocumentDiagnostic } from '@/lib/server/documentDiagnosticsRead';
import type { RecoveryReviewCandidate } from '@/lib/server/forgewingRecoveryReviewRead';

function attentionDiagnostic(diagnostic: DocumentDiagnostic): AttentionDiagnostic {
  return {
    diagnosticId: diagnostic.diagnosticId,
    code: diagnostic.code,
    attention: diagnostic.attention,
    recoverability: diagnostic.recoverability,
    recoveryType: diagnostic.recoveryType,
    severity: diagnostic.severity,
    summary: diagnostic.summary,
    physicalPageNumber: diagnostic.scope.physicalPageNumber,
    observationIds: diagnostic.evidenceRefs.flatMap((ref) => (ref.kind === 'observation' ? [ref.observationId] : [])),
    visual: diagnostic.visualEvidence,
    recoveryProposalId: diagnostic.recoveryProposalId,
  };
}

/**
 * Evidence EightForge knows it could not read, refused to publish or could not
 * interpret, for one document's preferred extraction: the same diagnostics the
 * document panel shows. Pure: shared by the resolution queue read and the
 * offline evidence inventory, so both derive cases from identical attention.
 */
export function documentEvidenceAttention(params: Readonly<{
  organizationId: string;
  documentId: string;
  extraction: Readonly<{ id?: string; created_at: string | null; data: Record<string, unknown> }>;
  proposals?: readonly RecoveryReviewCandidate[];
}>): DocumentEvidenceAttention {
  const { documentId, extraction } = params;
  const diagnostics = extractionDocumentDiagnostics({
    organizationId: params.organizationId,
    sourceDocumentId: documentId,
    extraction: extraction.data,
    extractionSnapshotId: String(extraction.id ?? `${documentId}:${extraction.created_at ?? ''}`),
    occurredAt: new Date(extraction.created_at ? Date.parse(extraction.created_at) || 0 : 0).toISOString(),
    proposals: params.proposals ?? [],
  });
  const pricedRows = pricedRowCategoryEvidence(extraction.data, documentId);
  return {
    diagnostics: diagnostics.map(attentionDiagnostic),
    withheldTargets: withheldPricedLineTargets(extraction.data, documentId),
    reviewRequiredTargets: reviewRequiredValueTargets(extraction.data, documentId),
    categoryReviewTargets: pricedRows.categoryReviewTargets,
    machineRowsByAnchor: pricedRows.machineRowsByAnchor,
  };
}

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { DiagnosticCode, DiagnosticEvidenceRef, DiagnosticScope }
  from '@/lib/diagnostics/failureDiagnostic';

function evidenceIdentity(ref: DiagnosticEvidenceRef): string {
  return hashCanonical(ref);
}

export function diagnosticId(input: Readonly<{
  code: DiagnosticCode;
  scope: DiagnosticScope;
  evidenceRefs: readonly DiagnosticEvidenceRef[];
}>): string {
  if (input.scope.physicalPageNumber !== null
    && input.scope.pageRepresentationDigest === null) {
    throw new Error('page_scoped_diagnostic_requires_page_representation_digest');
  }
  return hashCanonical({
    code: input.code,
    organizationId: input.scope.organizationId,
    sourceDocumentId: input.scope.sourceDocumentId,
    sourceArtifactId: input.scope.sourceArtifactId,
    physicalPageNumber: input.scope.physicalPageNumber,
    pageRepresentationDigest: input.scope.pageRepresentationDigest,
    evidenceIdentity: input.evidenceRefs.map(evidenceIdentity).sort(),
  });
}

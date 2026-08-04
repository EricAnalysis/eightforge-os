import { canonicalEvidenceRef, type CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

export type CanonicalFactReference = {
  readonly objectId: string;
  readonly fieldPath: string;
};

export type CanonicalValidationFactImpact = {
  readonly impactId: string;
  readonly findingId: string;
  readonly ruleId: string;
  readonly affectedFacts: readonly CanonicalFactReference[];
  readonly expectedCanonicalValue: string | null;
  readonly observedValue: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly evidenceReferenceIds: readonly string[];
  readonly exposureAmount: number | null;
  readonly approvalGateEffect: ValidationFinding['approval_gate_effect'];
  readonly requiredReviewAction: string | null;
  readonly findingStatus: ValidationFinding['status'];
};

export function mapValidationFindingToCanonicalFacts(input: {
  readonly finding: ValidationFinding;
  readonly evidence: readonly ValidationEvidence[];
  readonly affectedFacts: readonly CanonicalFactReference[];
}): CanonicalValidationFactImpact {
  return {
    impactId: `finding-impact:${input.finding.id}`,
    findingId: input.finding.id,
    ruleId: input.finding.rule_id,
    affectedFacts: [...input.affectedFacts],
    expectedCanonicalValue: input.finding.expected,
    observedValue: input.finding.actual,
    evidence: input.evidence.map((entry) => canonicalEvidenceRef({
      documentId: entry.source_document_id,
      page: entry.source_page,
      sourceAnchor: entry.record_id ?? entry.fact_id,
      extractionArtifactId: entry.record_id,
      rawSpan: entry.field_value,
    })),
    evidenceReferenceIds: [
      ...(input.finding.evidence_refs ?? []),
      ...input.evidence.map((entry) => entry.id),
    ],
    exposureAmount: input.finding.affected_amount ?? null,
    approvalGateEffect: input.finding.approval_gate_effect ?? null,
    requiredReviewAction: input.finding.required_action ?? input.finding.blocked_reason,
    findingStatus: input.finding.status,
  };
}

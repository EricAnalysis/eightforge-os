import { makeFinding, type ProjectValidatorInput, type ValidatorFindingResult } from '@/lib/validator/shared';

/**
 * Human-review authority diagnostics (Forgewing resolution layer B3.1).
 *
 * Human-reviewed values are final authority for their physical target. When
 * that authority cannot be applied cleanly, the run says so instead of failing
 * silently:
 * - a machine pricing row withheld because it cannot be proven to be a
 *   different physical line than a human-reviewed row. It is never
 *   double-counted, and it is never dropped without a trace;
 * - a reviewed value held for re-review: the page was re-extracted differently,
 *   competing reviews exist, or the review cites no source observation.
 *
 * Supersession itself (a machine row replaced by the human-reviewed row for
 * the same observations) is normal operation. It is recorded on the reviewed
 * row's receipt, not raised as a finding.
 */

export const PACK_HUMAN_REVIEW_INTEGRITY = 'human_review_integrity';
export const RULE_HUMAN_REVIEW_MACHINE_ROW_WITHHELD = 'HUMAN_REVIEW_MACHINE_RATE_ROW_WITHHELD';
export const RULE_HUMAN_REVIEWED_VALUE_HELD = 'HUMAN_REVIEWED_VALUE_HELD_FOR_REREVIEW';

const HELD_REASON_TEXT: Record<string, string> = {
  page_representation_changed: 'the page was re-extracted into a different representation',
  page_representation_unverifiable: 'the current page representation cannot be verified',
  ambiguous_competing_assertions: 'more than one reviewed value competes for the same target',
  source_observations_required: 'the review cites no source observation',
  invalid_asserted_value: 'the reviewed value is incomplete',
};

export function runHumanReviewIntegrityRules(input: ProjectValidatorInput): ValidatorFindingResult[] {
  const diagnostics = input.humanReviewDiagnostics;
  if (!diagnostics) return [];
  const withheld = diagnostics.withheldRows.map((row) => makeFinding({
    projectId: input.project.id,
    ruleId: RULE_HUMAN_REVIEW_MACHINE_ROW_WITHHELD,
    category: 'financial_integrity',
    severity: 'warning',
    subjectType: 'contract_rate_row',
    subjectId: `${row.documentId}:${row.row_id}`,
    field: 'human_review',
    expected: 'machine row provably distinct from human-reviewed rows',
    actual: `withheld: same ${row.physical_page_number == null ? 'document, page unknown' : `page ${row.physical_page_number}`} `
      + `as human-reviewed assertion(s) ${row.assertionIds.join(', ')}`,
    decisionEligible: true,
    actionEligible: true,
    evidence: [{
      evidence_type: 'human_review_withheld_machine_row',
      source_document_id: row.documentId,
      source_page: row.physical_page_number,
      record_id: row.row_id,
      field_name: 'rate',
      field_value: { rate: row.rate, unit: row.unit, description: row.description, raw_text: row.raw_text,
        source_kind: row.source_kind, seam: row.seam, assertion_ids: row.assertionIds },
      note: 'Machine rate row withheld from pricing: it carries no source observations, so it cannot be proven to be '
        + 'a different physical line than the human-reviewed row(s) on this page. Not double-counted; review it or '
        + 'enter a reviewed value for it.',
    }],
  }));
  const held = diagnostics.heldAssertions.map((entry) => makeFinding({
    projectId: input.project.id,
    ruleId: RULE_HUMAN_REVIEWED_VALUE_HELD,
    category: 'financial_integrity',
    severity: 'warning',
    subjectType: 'human_fact_assertion',
    subjectId: `${entry.documentId}:${entry.factKey}:${entry.anchorKey}`,
    field: entry.factKey,
    expected: 'effective human-reviewed value',
    actual: `held: ${HELD_REASON_TEXT[entry.reason] ?? entry.reason}`,
    decisionEligible: true,
    actionEligible: true,
    evidence: entry.assertionIds.map((assertionId) => ({
      evidence_type: 'human_fact_assertion',
      source_document_id: entry.documentId,
      record_id: `human_fact_assertion:${assertionId}`,
      field_name: entry.factKey,
      field_value: { reason: entry.reason, anchor_key: entry.anchorKey },
      note: `Human-reviewed value not applied: ${HELD_REASON_TEXT[entry.reason] ?? entry.reason}. `
        + 'Review it again against the current page.',
    })),
  }));
  return [...withheld, ...held];
}

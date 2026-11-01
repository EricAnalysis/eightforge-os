import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { EvidenceState, FindingAssessment, ProjectEvidenceAssessment } from '@/lib/projectIntelligence/evidenceAssessment';
import { allowlistRuleId } from '@/lib/resolution/frictionSignalAllowlist';
import type { OrchestratorRootCauseCategoryKey } from '@/lib/shared/orchestratorTaxonomy';

/**
 * The internal side output of project intelligence: what one operator's question
 * suggests about the product (conceptually the Forgewing improvement signal).
 * Structurally separate from the operator recommendation: neither type contains
 * the other, the operator response never carries one, and only a platform
 * reviewer can read them.
 *
 * Non-authoritative, evidence-backed, review-required. It holds codes and record
 * identifiers only (the friction-signal rule), so no customer text can reach
 * engineering through it, and it is derived from the deterministic reading, never
 * from a model's words. It cannot change code, truth, rules, relationships,
 * mappings, severity or configuration: it has no field or path that could.
 *
 * One signal is one observation, not a pattern. Recurrence across projects is the
 * friction report's job; future Orchestrator work consumes approved signals.
 */

export const PRODUCT_SIGNAL_CATEGORIES = [
  'extraction',
  'relationship_precedence',
  'missing_source',
  'validator_logic',
  'mapping_configuration',
  'project_data_quality',
  'unresolved_other',
] as const;
export type ProductSignalCategory = typeof PRODUCT_SIGNAL_CATEGORIES[number];

const ROOT_CAUSE_BY_CATEGORY: Readonly<Record<ProductSignalCategory, OrchestratorRootCauseCategoryKey | null>> = Object.freeze({
  extraction: 'extraction_issue',
  relationship_precedence: 'relationship_governance_issue',
  missing_source: null,
  validator_logic: 'validation_rule_issue',
  mapping_configuration: 'mapping_issue',
  project_data_quality: null,
  unresolved_other: null,
});

export type ProductImprovementSignal = Readonly<{
  schemaVersion: 'product_improvement_signal_v1';
  authority: 'non_authoritative';
  audience: 'internal';
  reviewRequired: true;
  category: ProductSignalCategory;
  /** A fixed code, never prose from a document or a model. */
  code: string;
  orchestratorRootCause: OrchestratorRootCauseCategoryKey | null;
  /** A catalogue rule id or the sentinel. */
  ruleId: string;
  evidenceState: EvidenceState;
  /** Typed references: a UUID, or the digest of anything else. */
  recordRefs: readonly string[];
}>;

const SIGNAL_BY_STATE: Readonly<Partial<Record<EvidenceState, Readonly<{ category: ProductSignalCategory; code: string }>>>> = Object.freeze({
  source_missing: { category: 'missing_source', code: 'source_absent_from_project' },
  source_present_unread: { category: 'extraction', code: 'source_present_not_read' },
  source_present_relationship_unresolved: { category: 'relationship_precedence', code: 'source_present_relationship_may_block_validator' },
  likely_system_issue: { category: 'validator_logic', code: 'source_present_linked_still_flagged' },
});

/** Non-gap rules whose finding suggests something about mapping or source data, by next step. */
function nonGapSignal(entry: FindingAssessment): Readonly<{ category: ProductSignalCategory; code: string }> | null {
  if (entry.ruleId === 'FINANCIAL_RATE_CODE_MISSING') return { category: 'mapping_configuration', code: 'billing_code_not_mapped_to_schedule' };
  if (entry.nextSteps[0] === 'correct_source_data') return { category: 'project_data_quality', code: 'source_data_needs_correction' };
  if (entry.confidence === 'low') return { category: 'unresolved_other', code: 'finding_without_catalogue_explanation' };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function recordRef(id: string): string {
  return UUID.test(id) ? id.toLowerCase() : `sha256:${hashCanonical(id)}`;
}

export function deriveProductImprovementSignals(assessment: ProjectEvidenceAssessment): ProductImprovementSignal[] {
  const entries = [...(assessment.primary ? [assessment.primary] : []), ...assessment.others];
  return entries.flatMap((entry) => {
    const signal = SIGNAL_BY_STATE[entry.state] ?? nonGapSignal(entry);
    if (!signal) return [];
    return [{
      schemaVersion: 'product_improvement_signal_v1' as const,
      authority: 'non_authoritative' as const,
      audience: 'internal' as const,
      reviewRequired: true as const,
      category: signal.category,
      code: signal.code,
      orchestratorRootCause: ROOT_CAUSE_BY_CATEGORY[signal.category],
      ruleId: allowlistRuleId(entry.ruleId ?? ''),
      evidenceState: entry.state,
      recordRefs: entry.evidenceRecordIds.slice(0, 10).map(recordRef),
    }];
  });
}

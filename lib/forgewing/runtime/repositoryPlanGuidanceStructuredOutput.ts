// Anthropic JSON Schema companion to the stricter canonical Zod/post-provider
// validator in repositoryPlanGuidance.ts. Every object is closed and every field
// typed at the provider boundary; the canonical validator alone enforces every
// count, length, uniqueness and alternative.
//
// Provider compatibility (2026-11-06, claude-sonnet-4-6 probes): the API rejects
// `maxItems` and `oneOf` in a structured-output schema, so neither is sent. The
// removed item bounds are enforced by repositoryPlanGuidance.ts (`.max(...)`).
// `regressionGates` uses `anyOf`: its two alternatives are closed objects with
// disjoint `gate` values (const 'evidence_test' versus enum typecheck|build), so
// no value can match both and `anyOf` admits exactly what `oneOf` did. Exclusivity
// is still enforced by the canonical `z.discriminatedUnion('gate', ...)`.
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const evidenceId = { type: 'string', pattern: '^ev_[a-f0-9]{64}$' };
const recommendationId = { type: 'string', pattern: '^rec_[a-f0-9]{64}$' };
const classification = { type: 'string', enum: ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY'] };
const recommendationKind = { type: 'string', enum: [
  'reuse_existing_rule', 'extend_existing_rule', 'add_new_authored_rule', 'rule_engine_architecture_gap',
  'existing_document_type_context', 'extraction_seam_candidate', 'operator_taxonomy_decision_still_required',
  'reuse_recovery_pattern', 'recovery_architecture_gap', 'operator_recovery_decision_still_required',
  'task_authority_gap', 'organization_identity_unresolved', 'no_implementation_required',
] };
const stringArray = (items: object) => ({ type: 'array', items });

export const REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['classification', 'stepGuidance', 'operatorDecisionSuggestions', 'unresolvedGlobalQuestions', 'insufficientEvidence'],
  properties: {
    classification,
    stepGuidance: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['stepId', 'recommendationKind', 'recommendationId', 'capabilitySummary', 'summary', 'evidenceRefs',
        'existingSeamEvaluation', 'architectureRisks', 'regressionGates', 'stopConditions', 'unresolvedQuestions'],
      properties: {
        stepId: text(120), recommendationKind, recommendationId, capabilitySummary: text(120), summary: text(2_000),
        evidenceRefs: stringArray(evidenceId),
        existingSeamEvaluation: { type: 'string', enum: ['existing_seam_cited', 'no_existing_seam_found_in_bounded_evidence'] },
        architectureRisks: stringArray(text(500)),
        regressionGates: { type: 'array', items: { anyOf: [
          { type: 'object', additionalProperties: false, required: ['gate', 'evidenceRef'],
            properties: { gate: { const: 'evidence_test' }, evidenceRef: evidenceId } },
          { type: 'object', additionalProperties: false, required: ['gate'],
            properties: { gate: { type: 'string', enum: ['typecheck', 'build'] } } },
        ] } },
        stopConditions: stringArray({ type: 'string', enum: ['authority_boundary_unclear', 'canonical_truth_owner_unclear',
          'operator_decision_required', 'evidence_scope_insufficient', 'repository_context_stale', 'migration_required',
          'execution_authority_required'] }),
        unresolvedQuestions: stringArray(text(500)),
      },
    } },
    operatorDecisionSuggestions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['stepId', 'decisionType', 'suggestedValue', 'rationale', 'evidenceRefs'],
      properties: { stepId: text(120), decisionType: { type: 'string', enum: ['source_document_taxonomy',
        'recovery_vocabulary_unresolved'] }, suggestedValue: text(500), rationale: text(1_000),
      evidenceRefs: { type: 'array', minItems: 1, items: evidenceId } },
    } },
    unresolvedGlobalQuestions: stringArray(text(500)),
    insufficientEvidence: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['stepId', 'reason'], properties: { stepId: text(120), reason: { const: 'no_eligible_repository_evidence' } } } },
  },
} as const;

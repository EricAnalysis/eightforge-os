/**
 * Deterministic structural validation for Forgewing pricing proposal V2 (Phase A).
 *
 * SCOPE BOUNDARY — this module judges SHAPE ONLY:
 *   valid field identity, exact evidence membership, contribution cardinality,
 *   enum legality, duplicate detection, conditional missingEvidence rules,
 *   foreign/cross-field evidence, and source-field eligibility.
 *
 * It deliberately does NOT judge whether a marker token is `type_marker`,
 * whether a numeric token is `value_token`, whether a dash is
 * `placeholder_absence`, or whether a semantic role matches human truth. Those
 * are evaluation concerns and must never be decided here. In particular this
 * module never inspects authored or primitive TEXT to infer a contribution.
 *
 * It also never lets `sourceFieldRole` (deterministic source structure) imply
 * or validate `semanticRole` (model assertion).
 */
import { z } from 'zod';

import {
  deriveSourceFieldId,
  ForgewingPricingInterpretationProposalV2Schema,
  ForgewingSourceFieldContextSchema,
  ForgewingSourceFieldInputSchema,
  ForgewingSourceFieldRoleSchema,
  isValueBearingContributionRole,
  type ForgewingPricingInterpretationProposalV2,
  type ForgewingSourceFieldContext,
  type ForgewingSourceFieldInput,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';

const boundedIdentifier = z.string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, 'identifier must not contain surrounding whitespace');

const eligibilityCellSchema = z.object({
  observationId: boundedIdentifier,
  physicalPageNumber: z.number().int().positive(),
  rowObservationId: boundedIdentifier.optional(),
  diagnosticOnly: z.boolean().optional(),
}).strict();

const eligibilityGroupSchema = z.object({
  sourceCellRole: ForgewingSourceFieldRoleSchema,
  sourceObservationIds: z.array(boundedIdentifier).min(1).max(16),
  authoredRawText: z.string().min(1).max(4_000),
}).strict();

export const ForgewingV2EligibilityInputSchema = z.object({
  context: ForgewingSourceFieldContextSchema,
  cells: z.array(eligibilityCellSchema).min(1).max(64),
  sourceCellGroups: z.array(eligibilityGroupSchema).max(16).optional(),
}).strict();

export type ForgewingV2EligibilityInput = z.infer<typeof ForgewingV2EligibilityInputSchema>;

export type ForgewingV2IneligibilityReason =
  | 'eligibility_input_contract_violation'
  | 'source_cell_groups_absent'
  | 'empty_group_membership'
  | 'unknown_group_member'
  | 'duplicate_group_membership'
  | 'incomplete_group_closure'
  | 'diagnostic_only_member'
  | 'cross_row_contamination'
  | 'cross_page_membership'
  | 'duplicate_source_field_identity';

export type ForgewingV2EligibilityResult =
  | Readonly<{ eligible: true; fields: readonly ForgewingSourceFieldInput[] }>
  | Readonly<{ eligible: false; reasons: readonly ForgewingV2IneligibilityReason[] }>;

/**
 * Determines whether a reconstructed row exposes authored source fields that V2
 * may interpret.
 *
 * V2 has NO primitive-grain fallback. When grouping is absent or incomplete the
 * row is ineligible and no fields are produced; callers must abstain rather than
 * degrade to one interpretation per extraction primitive.
 */
export function evaluateForgewingV2FieldEligibility(
  input: unknown,
): ForgewingV2EligibilityResult {
  const parsed = ForgewingV2EligibilityInputSchema.safeParse(input);
  if (!parsed.success) {
    return { eligible: false, reasons: ['eligibility_input_contract_violation'] };
  }
  const { context, cells, sourceCellGroups } = parsed.data;
  const reasons = new Set<ForgewingV2IneligibilityReason>();

  const cellById = new Map(cells.map((cell) => [cell.observationId, cell]));
  if (cellById.size !== cells.length) reasons.add('eligibility_input_contract_violation');
  if (!sourceCellGroups || sourceCellGroups.length === 0) {
    reasons.add('source_cell_groups_absent');
    return { eligible: false, reasons: [...reasons].sort() };
  }

  const claimed = new Set<string>();
  for (const group of sourceCellGroups) {
    if (group.sourceObservationIds.length === 0) reasons.add('empty_group_membership');
    if (new Set(group.sourceObservationIds).size !== group.sourceObservationIds.length) {
      reasons.add('duplicate_group_membership');
    }
    for (const id of group.sourceObservationIds) {
      const cell = cellById.get(id);
      if (!cell) { reasons.add('unknown_group_member'); continue; }
      if (claimed.has(id)) reasons.add('duplicate_group_membership');
      claimed.add(id);
      if (cell.diagnosticOnly === true) reasons.add('diagnostic_only_member');
      if (cell.rowObservationId !== undefined
        && cell.rowObservationId !== context.rowObservationId) {
        reasons.add('cross_row_contamination');
      }
      if (cell.physicalPageNumber !== context.physicalPageNumber) {
        reasons.add('cross_page_membership');
      }
    }
  }
  // Groups must exactly partition the admitted cells: no unclaimed primitive
  // may be silently dropped from reasoning.
  if (claimed.size !== cells.length) reasons.add('incomplete_group_closure');

  if (reasons.size > 0) return { eligible: false, reasons: [...reasons].sort() };

  const fields: ForgewingSourceFieldInput[] = sourceCellGroups.map((group) => ({
    sourceFieldId: deriveSourceFieldId({
      sourceDocumentId: context.sourceDocumentId,
      sourceArtifactId: context.sourceArtifactId,
      physicalPageNumber: context.physicalPageNumber,
      rowObservationId: context.rowObservationId,
      sourceFieldRole: group.sourceCellRole,
      sourceObservationIds: group.sourceObservationIds,
    }),
    sourceFieldRole: group.sourceCellRole,
    authoredRawText: group.authoredRawText,
    sourceObservationIds: [...group.sourceObservationIds],
    physicalPageNumber: context.physicalPageNumber,
  }));

  const fieldIds = fields.map((field) => field.sourceFieldId);
  if (new Set(fieldIds).size !== fieldIds.length) {
    return { eligible: false, reasons: ['duplicate_source_field_identity'] };
  }
  return { eligible: true, fields };
}

export type ForgewingV2ViolationCode =
  | 'validation_input_contract_violation'
  | 'proposal_schema_rejected'
  | 'candidate_identity_mismatch'
  | 'source_field_identity_mismatch'
  | 'source_field_context_mismatch'
  | 'duplicate_source_field_identity'
  | 'duplicate_source_observation_membership'
  | 'unknown_source_field_id'
  | 'duplicate_source_field_interpretation'
  | 'missing_source_field_interpretation'
  | 'row_confidence_state_mismatch'
  | 'contribution_membership_mismatch'
  | 'duplicate_contribution_observation'
  | 'foreign_contribution_observation'
  | 'cross_field_contribution_observation'
  | 'incompatible_contribution_roles';

export type ForgewingV2ValidationResult =
  | Readonly<{ status: 'valid'; proposal: ForgewingPricingInterpretationProposalV2 }>
  | Readonly<{ status: 'rejected'; violations: readonly ForgewingV2ViolationCode[] }>;

/** Structural validation of a V2 proposal against its frozen eligible fields. */
export function validateForgewingPricingInterpretationProposalV2(params: {
  candidateId: string;
  context: ForgewingSourceFieldContext;
  eligibleFields: readonly ForgewingSourceFieldInput[];
  proposal: unknown;
}): ForgewingV2ValidationResult {
  const parsedContext = ForgewingSourceFieldContextSchema.safeParse(params.context);
  const parsedFields = z.array(ForgewingSourceFieldInputSchema).min(1).max(16)
    .safeParse(params.eligibleFields);
  if (!parsedContext.success || !parsedFields.success) {
    return { status: 'rejected', violations: ['validation_input_contract_violation'] };
  }
  const parsed = ForgewingPricingInterpretationProposalV2Schema.safeParse(params.proposal);
  if (!parsed.success) return { status: 'rejected', violations: ['proposal_schema_rejected'] };
  const proposal = parsed.data;
  const context = parsedContext.data;
  const eligibleFields = parsedFields.data;
  const violations = new Set<ForgewingV2ViolationCode>();

  if (proposal.candidateId !== params.candidateId) violations.add('candidate_identity_mismatch');

  const fieldById = new Map<string, ForgewingSourceFieldInput>();
  const membershipOwner = new Map<string, string>();
  for (const field of eligibleFields) {
    const expectedId = deriveSourceFieldId({ ...context, sourceFieldRole: field.sourceFieldRole,
      sourceObservationIds: field.sourceObservationIds });
    if (field.sourceFieldId !== expectedId) violations.add('source_field_identity_mismatch');
    if (field.physicalPageNumber !== context.physicalPageNumber) {
      violations.add('source_field_context_mismatch');
    }
    if (fieldById.has(field.sourceFieldId)) violations.add('duplicate_source_field_identity');
    fieldById.set(field.sourceFieldId, field);
    for (const id of field.sourceObservationIds) {
      if (membershipOwner.has(id)) violations.add('duplicate_source_observation_membership');
      membershipOwner.set(id, field.sourceFieldId);
    }
  }

  if (proposal.rowInterpretationState === 'insufficient_evidence' && proposal.confidence !== null) {
    violations.add('row_confidence_state_mismatch');
  }

  const seenFieldIds = new Set<string>();
  for (const interpretation of proposal.fieldInterpretations) {
    if (seenFieldIds.has(interpretation.sourceFieldId)) {
      violations.add('duplicate_source_field_interpretation');
    }
    seenFieldIds.add(interpretation.sourceFieldId);

    const field = fieldById.get(interpretation.sourceFieldId);
    if (!field) {
      // Fail closed: no fuzzy matching, no text or geometry recovery.
      violations.add('unknown_source_field_id');
      continue;
    }

    if (interpretation.interpretationState === 'insufficient_evidence') {
      // The discriminated-union schema owns abstention shape. Deterministic
      // validation owns identity, exact eligible-field coverage, and evidence
      // closure; it does not duplicate unreachable post-schema diagnostics.
      continue;
    }

    const contributionIds = interpretation.contributions.map((item) => item.observationId);
    if (new Set(contributionIds).size !== contributionIds.length) {
      violations.add('duplicate_contribution_observation');
    }
    const roleByObservation = new Map<string, Set<string>>();
    for (const contribution of interpretation.contributions) {
      const owner = membershipOwner.get(contribution.observationId);
      if (owner === undefined) {
        violations.add('foreign_contribution_observation');
      } else if (owner !== field.sourceFieldId) {
        violations.add('cross_field_contribution_observation');
      }
      const roles = roleByObservation.get(contribution.observationId) ?? new Set<string>();
      roles.add(contribution.contributionRole);
      roleByObservation.set(contribution.observationId, roles);
    }
    // Generic incompatibility: one anchor cannot both mark absence and carry
    // the field's value. Text is never consulted to reach this conclusion.
    for (const roles of roleByObservation.values()) {
      if (roles.has('placeholder_absence')
        && [...roles].some((role) => isValueBearingContributionRole(
          role as Parameters<typeof isValueBearingContributionRole>[0]))) {
        violations.add('incompatible_contribution_roles');
      }
    }
    // Non-abstaining fields must account for membership EXACTLY: same set, same
    // cardinality, no omissions, no extras. Ordering carries no meaning.
    const expected = new Set(field.sourceObservationIds);
    const actual = new Set(contributionIds);
    if (expected.size !== actual.size
      || [...expected].some((id) => !actual.has(id))) {
      violations.add('contribution_membership_mismatch');
    }
  }

  if ([...fieldById.keys()].some((id) => !seenFieldIds.has(id))) {
    violations.add('missing_source_field_interpretation');
  }

  return violations.size > 0
    ? { status: 'rejected', violations: [...violations].sort() }
    : { status: 'valid', proposal };
}

export type ForgewingV2JoinedFieldInterpretation = Readonly<{
  sourceFieldId: string;
  sourceFieldRole: ForgewingSourceFieldInput['sourceFieldRole'];
  authoredRawText: string;
  evidenceObservationIds: readonly string[];
  semanticRole: string;
  interpretationState: string;
  confidence: number | null;
  contributions: readonly Readonly<{ observationId: string; contributionRole: string }>[];
  rationaleCodes: readonly string[];
  missingEvidence?: readonly Readonly<{ code: string; description?: string }>[];
}>;

/**
 * Attaches deterministic source metadata the provider never supplied. Evidence
 * membership comes from the frozen source field, so a model can neither widen
 * nor shrink it.
 */
export function joinForgewingPricingInterpretationProposalV2(params: {
  candidateId: string;
  context: ForgewingSourceFieldContext;
  eligibleFields: readonly ForgewingSourceFieldInput[];
  proposal: unknown;
}): Readonly<{
  proposalVersion: ForgewingPricingInterpretationProposalV2['proposalVersion'];
  candidateId: string;
  authority: 'non_authoritative';
  numericAmountStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL';
  sourceDocumentId: string;
  sourceArtifactId: string;
  rowObservationId: string;
  physicalPageNumber: number;
  rowInterpretationState: string;
  confidence: number | null;
  fieldInterpretations: readonly ForgewingV2JoinedFieldInterpretation[];
}> {
  const validation = validateForgewingPricingInterpretationProposalV2(params);
  if (validation.status !== 'valid') {
    throw new Error(`forgewing_v2_join_requires_validated_proposal:${validation.violations.join(',')}`);
  }
  const proposal = validation.proposal;
  const fieldById = new Map(params.eligibleFields.map((field) => [field.sourceFieldId, field]));
  return {
    proposalVersion: proposal.proposalVersion,
    candidateId: proposal.candidateId,
    authority: 'non_authoritative',
    numericAmountStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL',
    sourceDocumentId: params.context.sourceDocumentId,
    sourceArtifactId: params.context.sourceArtifactId,
    rowObservationId: params.context.rowObservationId,
    physicalPageNumber: params.context.physicalPageNumber,
    rowInterpretationState: proposal.rowInterpretationState,
    confidence: proposal.confidence,
    fieldInterpretations: proposal.fieldInterpretations.map((interpretation) => {
      const field = fieldById.get(interpretation.sourceFieldId);
      if (!field) throw new Error('forgewing_v2_join_requires_validated_proposal');
      return {
        sourceFieldId: field.sourceFieldId,
        sourceFieldRole: field.sourceFieldRole,
        authoredRawText: field.authoredRawText,
        evidenceObservationIds: [...field.sourceObservationIds],
        semanticRole: interpretation.semanticRole,
        interpretationState: interpretation.interpretationState,
        confidence: interpretation.confidence,
        contributions: interpretation.contributions.map((contribution) => ({ ...contribution })),
        rationaleCodes: [...interpretation.rationaleCodes],
        ...('missingEvidence' in interpretation
          ? { missingEvidence: interpretation.missingEvidence.map((entry) => ({ ...entry })) }
          : {}),
      };
    }),
  };
}

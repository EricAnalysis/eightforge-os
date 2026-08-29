/** Opt-in provider-free structural acceptance against exact real source bytes. */
import { describe, expect, it } from 'vitest';

import { deriveSourceFieldId,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import { evaluateForgewingV2FieldEligibility,
  validateForgewingPricingInterpretationProposalV2 } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2Validation';
import { joinPreparedForgewingPricingProposalV2 } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2';
import { runForgewingPricingProposalV2PhaseB,
  type ForgewingPricingProposalV2PhaseBReport } from
  '@/scripts/evaluation/runForgewingPricingProposalV2PhaseB';

const tdotPath = process.env.TDOT_PHASE1_SOURCE_PDF?.trim();
const dnPath = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
const configured = Boolean(tdotPath && dnPath);

describe.skipIf(!configured)('REAL SOURCE: Forgewing pricing proposal V2 Phase B', () => {
  it('prepares TDOT and DN twice with exact identity, closure, isolation, and zero provider calls',
    async () => {
      const report = await runForgewingPricingProposalV2PhaseB([
        { sourcePdfPath: tdotPath!, corpusKind: 'real_unlabelled_smoke',
          expectedSourceSha256: '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a',
          documentType: 'contract', authoritativeRatePageRanges: [{ start: 46, end: 46 }] },
        { sourcePdfPath: dnPath!, corpusKind: 'real_unlabelled_smoke',
          expectedSourceSha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
          documentType: 'contract', authoritativeRatePageRanges: [{ start: 106, end: 106 }] },
      ]);
      expect(report).toMatchObject({ authority: 'non_authoritative_preparation', providerCalls: 0,
        promotionEvidence: false, promotionAuthorized: false,
        combinedDuplicateSourceFieldIds: [] });
      const [tdot, dn] = report.sources.map((source) => source.preparation);
      expect(tdot!.source).toMatchObject({
        sourceSha256: '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a',
        sourceByteLength: 1_063_619, physicalPageCount: 46 });
      expect(tdot).toMatchObject({ reconstruction: { totalRows: 32, diagnosticCount: 0 },
        v1Compatibility: { candidateCount: 2, orderingDeterministic: true },
        rowAccounting: { completeSourceCellGroupRows: 2, eligibleRows: 2, ineligibleRows: 30,
          ineligibilityReasonCounts: { not_evidence_admitted_for_v2: 30 } },
        fields: { count: 8, roleDistribution: { description: 2, unit: 2,
          origin_destination: 2, rate: 2 }, duplicateSourceFieldIds: [],
        exactMembershipClosureFailures: 0 }, acceptedDiagnosticOverlapIds: [] });
      expect(dn!.source).toMatchObject({
        sourceSha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
        sourceByteLength: 3_895_497, physicalPageCount: 131 });
      expect(dn).toMatchObject({ reconstruction: { totalRows: 21, diagnosticCount: 14,
        diagnosticReasonCounts: { ambiguous_row_assignment: 13, unsupported_trailing_line: 1 },
        crossPageInferencePerformed: false, diagnosticRowLinkagePerformed: false },
      v1Compatibility: { candidateCount: 3, orderingDeterministic: true },
      rowAccounting: { completeSourceCellGroupRows: 3, eligibleRows: 3, ineligibleRows: 18,
        ineligibilityReasonCounts: { not_evidence_admitted_for_v2: 18 } },
      fields: { count: 9, roleDistribution: { description: 3, unit: 3, rate: 3 },
        duplicateSourceFieldIds: [], exactMembershipClosureFailures: 0 },
      acceptedDiagnosticOverlapIds: [] });
      expect(dn!.reconstruction.diagnosticObservationIds).toHaveLength(15);
      expect(report.sources.every((source) => source.deterministicReplay
        && source.v1CandidateDigestStable)).toBe(true);
      expect(report.combinedSourceFieldCount).toBe(17);

      verifyRealPreparedFields(report);
    }, 300_000);
});

type PreparedRow = ForgewingPricingProposalV2PhaseBReport['sources'][number]['preparation']['rows'][number];

function proposalFor(row: PreparedRow) {
  return { proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: row.candidateId, rowInterpretationState: 'observed' as const, confidence: 0.8,
    fieldInterpretations: row.fields.map(({ field }) => ({ sourceFieldId: field.sourceFieldId,
      semanticRole: 'unknown' as const, interpretationState: 'observed' as const, confidence: 0.5,
      contributions: field.sourceObservationIds.map((observationId) => ({ observationId,
        contributionRole: 'unknown_contribution' as const })),
      rationaleCodes: ['missing_semantic_context' as const] })) };
}

function eligibilityInput(row: PreparedRow) {
  return { context: row.context,
    cells: row.fields.flatMap((entry) => entry.primitiveEvidence.map((primitive) => ({
      observationId: primitive.observationId, physicalPageNumber: primitive.physicalPageNumber,
      rowObservationId: row.rowObservationId, diagnosticOnly: false }))),
    sourceCellGroups: row.fields.map(({ field }) => ({ sourceCellRole: field.sourceFieldRole,
      sourceObservationIds: [...field.sourceObservationIds], authoredRawText: field.authoredRawText })) };
}

function verifyRealPreparedFields(report: ForgewingPricingProposalV2PhaseBReport): void {
  const allRows = report.sources.flatMap((source) => source.preparation.rows);
  for (const row of allRows) for (const { field } of row.fields) {
    const identity = { ...row.context, sourceFieldRole: field.sourceFieldRole,
      sourceObservationIds: field.sourceObservationIds };
    expect(deriveSourceFieldId(identity)).toBe(field.sourceFieldId);
    expect(deriveSourceFieldId({ ...identity,
      sourceObservationIds: [...field.sourceObservationIds].reverse() })).toBe(field.sourceFieldId);
    for (const variant of [
      { sourceDocumentId: `${row.context.sourceDocumentId}-other` },
      { sourceArtifactId: `${row.context.sourceArtifactId}-other` },
      { physicalPageNumber: row.context.physicalPageNumber + 1 },
      { rowObservationId: `${row.context.rowObservationId}-other` },
      { sourceFieldRole: field.sourceFieldRole === 'rate' ? 'unit' as const : 'rate' as const },
      { sourceObservationIds: [...field.sourceObservationIds, 'foreign-member'] },
    ]) expect(deriveSourceFieldId({ ...identity, ...variant })).not.toBe(field.sourceFieldId);
  }

  const row = allRows[0]!;
  const fields = row.fields.map((entry) => entry.field);
  const proposal = proposalFor(row);
  expect(validateForgewingPricingInterpretationProposalV2({ candidateId: row.candidateId,
    context: row.context, eligibleFields: fields, proposal })).toMatchObject({ status: 'valid' });
  expect(joinPreparedForgewingPricingProposalV2({ row, proposal })).toMatchObject({
    authority: 'non_authoritative', numericAmountStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL',
    sourceDocumentId: row.context.sourceDocumentId, sourceArtifactId: row.context.sourceArtifactId });

  const forged = { ...fields[0]!, sourceFieldId: 'forgewing-source-field-real-forged' };
  const forgedProposal = { ...proposal, fieldInterpretations: proposal.fieldInterpretations.map(
    (interpretation, index) => index === 0
      ? { ...interpretation, sourceFieldId: forged.sourceFieldId } : interpretation) };
  const forgedResult = validateForgewingPricingInterpretationProposalV2({
    candidateId: row.candidateId, context: row.context,
    eligibleFields: [forged, ...fields.slice(1)], proposal: forgedProposal });
  expect(forgedResult.status === 'rejected' && forgedResult.violations)
    .toContain('source_field_identity_mismatch');
  const duplicatedIdentity = validateForgewingPricingInterpretationProposalV2({
    candidateId: row.candidateId, context: row.context,
    eligibleFields: [fields[0]!, fields[0]!, ...fields.slice(1)], proposal });
  expect(duplicatedIdentity.status === 'rejected' && duplicatedIdentity.violations)
    .toContain('duplicate_source_field_identity');
  const omitted = validateForgewingPricingInterpretationProposalV2({ candidateId: row.candidateId,
    context: row.context, eligibleFields: fields,
    proposal: { ...proposal, fieldInterpretations: proposal.fieldInterpretations.slice(1) } });
  expect(omitted.status === 'rejected' && omitted.violations)
    .toContain('missing_source_field_interpretation');

  const baseInput = eligibilityInput(row);
  const withoutGroups = evaluateForgewingV2FieldEligibility({ context: baseInput.context,
    cells: baseInput.cells });
  expect(withoutGroups.eligible === false && withoutGroups.reasons)
    .toContain('source_cell_groups_absent');
  expect(withoutGroups).not.toHaveProperty('fields');
  const incomplete = evaluateForgewingV2FieldEligibility({ ...baseInput,
    sourceCellGroups: baseInput.sourceCellGroups.slice(1) });
  expect(incomplete.eligible === false && incomplete.reasons).toContain('incomplete_group_closure');
  const duplicate = evaluateForgewingV2FieldEligibility({ ...baseInput,
    sourceCellGroups: [...baseInput.sourceCellGroups,
      { ...baseInput.sourceCellGroups[0]!, sourceCellRole: 'unknown' }] });
  expect(duplicate.eligible === false && duplicate.reasons).toContain('duplicate_group_membership');
  const unknown = evaluateForgewingV2FieldEligibility({ ...baseInput,
    sourceCellGroups: [{ ...baseInput.sourceCellGroups[0]!,
      sourceObservationIds: ['foreign-observation'] }, ...baseInput.sourceCellGroups.slice(1)] });
  expect(unknown.eligible === false && unknown.reasons).toContain('unknown_group_member');
  const diagnosticId = report.sources[1]!.preparation.reconstruction.diagnosticObservationIds[0]!;
  const diagnostic = evaluateForgewingV2FieldEligibility({ ...baseInput,
    cells: [...baseInput.cells, { observationId: diagnosticId,
      physicalPageNumber: row.context.physicalPageNumber,
      rowObservationId: row.rowObservationId, diagnosticOnly: true }],
    sourceCellGroups: [{ ...baseInput.sourceCellGroups[0]!,
      sourceObservationIds: [...baseInput.sourceCellGroups[0]!.sourceObservationIds, diagnosticId] },
    ...baseInput.sourceCellGroups.slice(1)] });
  expect(diagnostic.eligible === false && diagnostic.reasons).toContain('diagnostic_only_member');
  const crossRowSource = allRows.find((candidate) => candidate.rowObservationId !== row.rowObservationId)!;
  const crossPrimitive = crossRowSource.fields[0]!.primitiveEvidence[0]!;
  const crossRow = evaluateForgewingV2FieldEligibility({ ...baseInput,
    cells: [...baseInput.cells, { observationId: crossPrimitive.observationId,
      physicalPageNumber: row.context.physicalPageNumber,
      rowObservationId: crossRowSource.rowObservationId }],
    sourceCellGroups: [{ ...baseInput.sourceCellGroups[0]!, sourceObservationIds: [
      ...baseInput.sourceCellGroups[0]!.sourceObservationIds, crossPrimitive.observationId] },
    ...baseInput.sourceCellGroups.slice(1)] });
  expect(crossRow.eligible === false && crossRow.reasons).toContain('cross_row_contamination');
  const crossPage = evaluateForgewingV2FieldEligibility({ ...baseInput,
    cells: baseInput.cells.map((cell, index) => index === 0
      ? { ...cell, physicalPageNumber: row.context.physicalPageNumber + 1 } : cell) });
  expect(crossPage.eligible === false && crossPage.reasons).toContain('cross_page_membership');
}

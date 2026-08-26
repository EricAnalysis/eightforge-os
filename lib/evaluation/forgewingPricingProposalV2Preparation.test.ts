/** SYNTHETIC STRUCTURE TESTS ONLY. No provider or semantic truth assertions. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { deriveSourceFieldId,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  type ForgewingPricingInterpretationProposalV2 } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import { evaluateForgewingV2FieldEligibility } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2Validation';
import { forgewingV2EligibilityInputForCandidate, joinPreparedForgewingPricingProposalV2,
  prepareForgewingPricingProposalV2FromCorpus,
  writeForgewingPricingProposalV2PreparationArtifact } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2';
import type { ForgewingPricingCorpusPreparation } from
  '@/scripts/evaluation/runForgewingPricingCorpus';

function candidate(): ForgewingPricingCorpusPreparation['candidates'][number] {
  return { organizationId: 'synthetic-org', sourceDocumentId: 'synthetic-document',
    sourceArtifactId: 'synthetic-artifact', extractionSnapshotId: 'synthetic-snapshot',
    pricingScope: { scopeKind: 'authoritative', eligibility: 'canonical_eligible',
      eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'synthetic-scope' },
    rowObservation: { observationId: 'page_priced_schedule:p3:r1', rawText: 'synthetic row',
      deterministicState: 'unresolved', physicalPageNumber: 3,
      cells: [
        { observationId: 'obs-description', rawText: 'Synthetic work', columnIndex: 0,
          readingOrder: 0, sourceDocumentId: 'synthetic-document',
          sourceArtifactId: 'synthetic-artifact', physicalPageNumber: 3,
          sourceLayer: 'pdf_native_text', artifactLocalIndex: 2 },
        { observationId: 'obs-rate-marker', rawText: '$', columnIndex: 1,
          readingOrder: 1, sourceDocumentId: 'synthetic-document',
          sourceArtifactId: 'synthetic-artifact', physicalPageNumber: 3,
          sourceLayer: 'pdf_native_text', artifactLocalIndex: 2 },
        { observationId: 'obs-rate-value', rawText: '2.00', columnIndex: 1,
          readingOrder: 2, sourceDocumentId: 'synthetic-document',
          sourceArtifactId: 'synthetic-artifact', physicalPageNumber: 3,
          sourceLayer: 'pdf_native_text', artifactLocalIndex: 2 },
      ],
      sourceCellGroups: [
        { sourceCellRole: 'description', sourceObservationIds: ['obs-description'],
          authoredRawText: 'Synthetic work' },
        { sourceCellRole: 'rate', sourceObservationIds: ['obs-rate-marker', 'obs-rate-value'],
          authoredRawText: '$ 2.00' },
      ] } };
}

function preparation(): ForgewingPricingCorpusPreparation {
  const input = candidate();
  return { source: { sourcePdfPath: 'synthetic.pdf', sourceSha256: 'a'.repeat(64),
    sourceByteLength: 100, sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId, extractionSnapshotId: input.extractionSnapshotId },
  runtime: { model: 'synthetic-model', promptTemplateId: 'v1-task',
    promptTemplateVersion: 'v1-prompt', proposalSchemaVersion: 'v1-schema' },
  candidates: [input], pricingLayoutObservations: [], sourcePhysicalPageCount: 4,
  pricedScheduleReconstruction: { parser_version: 'priced_schedule_reconstruction_v1', pages: [{
    physical_page_number: 3, header_raw_text: 'header', header_y: 1, columns: [],
    rows: [{ row_index: 1, physical_page_number: 3, cells: [], raw_text: 'synthetic row',
      x_min: 0, x_max: 1, y_min: 0, y_max: 1 },
    { row_index: 2, physical_page_number: 3, cells: [], raw_text: 'not admitted',
      x_min: 0, x_max: 1, y_min: 0, y_max: 1 }],
    rejected_spines: [], unassigned_lines: [],
  }] }, orderingDeterministic: true } as unknown as ForgewingPricingCorpusPreparation;
}

describe('SYNTHETIC: provider-free V2 preparation', () => {
  it('prepares exact authored fields while accounting for upstream-ineligible rows', () => {
    const source = preparation();
    const result = prepareForgewingPricingProposalV2FromCorpus(source);
    expect(result).toMatchObject({ authority: 'non_authoritative_preparation', providerCalls: 0,
      promotionEvidence: false, rowAccounting: { completeSourceCellGroupRows: 1,
        eligibleRows: 1, ineligibleRows: 1,
        ineligibilityReasonCounts: { not_evidence_admitted_for_v2: 1 } },
      fields: { count: 2, roleDistribution: { description: 1, rate: 1 },
        duplicateSourceFieldIds: [], exactMembershipClosureFailures: 0 },
      v1Compatibility: { candidateCount: 1,
        candidateDigestSha256: hashCanonical(source.candidates) } });
    expect(result.rows[0]!.fields.flatMap((field) => field.field.sourceObservationIds).sort())
      .toEqual(['obs-description', 'obs-rate-marker', 'obs-rate-value']);
  });

  it('fails closed on every group/context mutation without primitive fallback', () => {
    const input = forgewingV2EligibilityInputForCandidate(candidate()) as {
      context: Record<string, unknown>; cells: Array<Record<string, unknown>>;
      sourceCellGroups: Array<{ sourceCellRole: string; sourceObservationIds: string[];
        authoredRawText: string }> };
    const cases: readonly [unknown, string][] = [
      [{ context: input.context, cells: input.cells }, 'source_cell_groups_absent'],
      [{ ...input, sourceCellGroups: [input.sourceCellGroups[0]!] }, 'incomplete_group_closure'],
      [{ ...input, sourceCellGroups: [...input.sourceCellGroups,
        { ...input.sourceCellGroups[0]!, sourceCellRole: 'unit' }] }, 'duplicate_group_membership'],
      [{ ...input, sourceCellGroups: [{ ...input.sourceCellGroups[0]!,
        sourceObservationIds: ['obs-foreign'] }, input.sourceCellGroups[1]!] }, 'unknown_group_member'],
      [{ ...input, cells: input.cells.map((cell, index) => index === 0
        ? { ...cell, diagnosticOnly: true } : cell) }, 'diagnostic_only_member'],
      [{ ...input, cells: input.cells.map((cell, index) => index === 0
        ? { ...cell, rowObservationId: 'other-row' } : cell) }, 'cross_row_contamination'],
      [{ ...input, cells: input.cells.map((cell, index) => index === 0
        ? { ...cell, physicalPageNumber: 4 } : cell) }, 'cross_page_membership'],
    ];
    for (const [mutated, reason] of cases) {
      const result = evaluateForgewingV2FieldEligibility(mutated);
      expect(result.eligible).toBe(false);
      expect(result.eligible === false && result.reasons).toContain(reason);
      expect(result).not.toHaveProperty('fields');
    }
  });

  it('keeps authored display text outside identity and joins runtime-owned primitive metadata', () => {
    const prepared = prepareForgewingPricingProposalV2FromCorpus(preparation());
    const row = prepared.rows[0]!;
    const description = row.fields.find((entry) => entry.field.sourceFieldRole === 'description')!;
    expect(deriveSourceFieldId({ ...row.context, sourceFieldRole: description.field.sourceFieldRole,
      sourceObservationIds: description.field.sourceObservationIds }))
      .toBe(description.field.sourceFieldId);
    expect(deriveSourceFieldId({ ...row.context, sourceFieldRole: description.field.sourceFieldRole,
      sourceObservationIds: description.field.sourceObservationIds }))
      .toBe(deriveSourceFieldId({ ...row.context, sourceFieldRole: description.field.sourceFieldRole,
        sourceObservationIds: [...description.field.sourceObservationIds].reverse() }));
    const proposal = { proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
      candidateId: row.candidateId, rowInterpretationState: 'observed', confidence: 0.8,
      fieldInterpretations: row.fields.map(({ field }) => ({ sourceFieldId: field.sourceFieldId,
        semanticRole: 'unknown', interpretationState: 'observed', confidence: 0.5,
        contributions: field.sourceObservationIds.map((observationId) =>
          ({ observationId, contributionRole: 'unknown_contribution' })),
        rationaleCodes: ['missing_semantic_context'] })) } satisfies
      ForgewingPricingInterpretationProposalV2;
    const joined = joinPreparedForgewingPricingProposalV2({ row, proposal });
    expect(joined).toMatchObject({ authority: 'non_authoritative',
      sourceDocumentId: 'synthetic-document', sourceArtifactId: 'synthetic-artifact',
      rowObservationId: 'page_priced_schedule:p3:r1',
      numericAmountStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL' });
    expect(joined.rawPrimitiveEvidence).toHaveLength(3);
    expect(JSON.stringify(proposal)).not.toContain('Synthetic work');
  });

  it('writes a new immutable artifact and refuses overwrite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgewing-v2-phase-b-'));
    const outputPath = join(directory, 'report.json');
    const payload = prepareForgewingPricingProposalV2FromCorpus(preparation());
    const written = writeForgewingPricingProposalV2PreparationArtifact({ outputPath, payload });
    expect(written.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({ providerCalls: 0 });
    expect(() => writeForgewingPricingProposalV2PreparationArtifact({ outputPath, payload }))
      .toThrow();
  });
});

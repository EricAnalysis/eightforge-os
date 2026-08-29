/** Provider-free Phase B preparation for Forgewing pricing proposal V2. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  type ForgewingPricingInterpretationProposalV2,
  type ForgewingSourceFieldContext,
  type ForgewingSourceFieldInput } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import { evaluateForgewingV2FieldEligibility,
  joinForgewingPricingInterpretationProposalV2,
  type ForgewingV2IneligibilityReason } from
  '@/lib/forgewing/proposal/pricingInterpretationProposalV2Validation';
import type { ForgewingPricingInterpretationInput } from
  '@/lib/forgewing/tasks/pricingInterpretation';
import { prepareForgewingPricingCorpus,
  type ForgewingPricingCorpusEntry,
  type ForgewingPricingCorpusPreparation } from
  '@/scripts/evaluation/runForgewingPricingCorpus';

export const FORGEWING_PRICING_PROPOSAL_V2_PREPARATION_VERSION =
  'forgewing-pricing-proposal-v2-preparation-v1' as const;

export type ForgewingV2PreparedPrimitive = Readonly<{
  observationId: string;
  rawText: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  sourceLayer: string;
  artifactLocalIndex: number | null;
}>;

export type ForgewingV2PreparedField = Readonly<{
  field: ForgewingSourceFieldInput;
  authoredRawTextDisplayOnly: string;
  primitiveEvidence: readonly ForgewingV2PreparedPrimitive[];
}>;

export type ForgewingV2PreparedRow = Readonly<{
  candidateId: string;
  rowObservationId: string;
  context: ForgewingSourceFieldContext;
  fields: readonly ForgewingV2PreparedField[];
  exactMembershipClosure: true;
}>;

type PhaseBRowReason = ForgewingV2IneligibilityReason
  | 'not_evidence_admitted_for_v2';

export type ForgewingPricingProposalV2Preparation = Readonly<{
  reportVersion: typeof FORGEWING_PRICING_PROPOSAL_V2_PREPARATION_VERSION;
  authority: 'non_authoritative_preparation';
  providerCalls: 0;
  promotionEvidence: false;
  promotionAuthorized: false;
  source: ForgewingPricingCorpusPreparation['source'] & Readonly<{ physicalPageCount: number }>;
  proposalVersion: typeof FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION;
  reconstruction: Readonly<{
    parserVersion: string;
    totalRows: number;
    diagnosticCount: number;
    diagnosticReasonCounts: Readonly<Record<string, number>>;
    diagnosticObservationIds: readonly string[];
    diagnosticRowLinkagePerformed: false;
    crossPageInferencePerformed: false;
  }>;
  v1Compatibility: Readonly<{
    candidateCount: number;
    candidateDigestSha256: string;
    orderingDeterministic: boolean;
  }>;
  rowAccounting: Readonly<{
    completeSourceCellGroupRows: number;
    eligibleRows: number;
    ineligibleRows: number;
    ineligibilityReasonCounts: Readonly<Record<PhaseBRowReason, number>>;
  }>;
  fields: Readonly<{
    count: number;
    roleDistribution: Readonly<Record<string, number>>;
    sourceFieldIds: readonly string[];
    duplicateSourceFieldIds: readonly string[];
    exactMembershipClosureFailures: number;
    diagnosticMemberFailures: number;
    crossRowFailures: number;
    crossPageFailures: number;
  }>;
  acceptedDiagnosticOverlapIds: readonly string[];
  rows: readonly ForgewingV2PreparedRow[];
  preparationDigestSha256: string;
}>;

function reconstructionRowId(page: number, rowIndex: number): string {
  return `page_priced_schedule:p${page}:r${rowIndex}`;
}

function diagnosticInventory(preparation: ForgewingPricingCorpusPreparation): Readonly<{
  count: number; reasonCounts: Readonly<Record<string, number>>; observationIds: readonly string[] }> {
  const entries = preparation.pricedScheduleReconstruction.pages.flatMap((page) => [
    ...page.rejected_spines.map((entry) => ({ reason: entry.reason, refs: entry.source_refs })),
    ...page.unassigned_lines.map((entry) => ({ reason: entry.reason, refs: entry.source_refs })),
  ]);
  const reasonCounts: Record<string, number> = {};
  for (const entry of entries) reasonCounts[entry.reason] = (reasonCounts[entry.reason] ?? 0) + 1;
  const observationIds = [...new Set(entries.flatMap((entry) => entry.refs.flatMap((ref) =>
    typeof ref.observation_id === 'string' && ref.observation_id.length > 0
      ? [ref.observation_id] : [])))].sort((a, b) => a.localeCompare(b, 'en-US'));
  return { count: entries.length, reasonCounts, observationIds };
}

function preparedPrimitive(cell: ForgewingPricingInterpretationInput['rowObservation']['cells'][number]):
ForgewingV2PreparedPrimitive {
  if (!cell.sourceDocumentId || !cell.sourceArtifactId
    || !cell.physicalPageNumber || !cell.sourceLayer) {
    throw new Error(`forgewing_v2_primitive_provenance_incomplete:${cell.observationId}`);
  }
  return { observationId: cell.observationId, rawText: cell.rawText,
    sourceDocumentId: cell.sourceDocumentId, sourceArtifactId: cell.sourceArtifactId,
    physicalPageNumber: cell.physicalPageNumber, sourceLayer: cell.sourceLayer,
    artifactLocalIndex: cell.artifactLocalIndex ?? null };
}

export function forgewingV2EligibilityInputForCandidate(
  candidate: ForgewingPricingInterpretationInput,
  diagnosticObservationIds: ReadonlySet<string> = new Set<string>(),
): Readonly<Record<string, unknown>> {
  const row = candidate.rowObservation;
  return { context: { sourceDocumentId: candidate.sourceDocumentId,
    sourceArtifactId: candidate.sourceArtifactId, rowObservationId: row.observationId,
    physicalPageNumber: row.physicalPageNumber },
  cells: row.cells.map((cell) => ({ observationId: cell.observationId,
    physicalPageNumber: cell.physicalPageNumber, rowObservationId: row.observationId,
    diagnosticOnly: diagnosticObservationIds.has(cell.observationId) })),
  ...(row.sourceCellGroups ? { sourceCellGroups: row.sourceCellGroups } : {}) };
}

export function prepareForgewingPricingProposalV2FromCorpus(
  preparation: ForgewingPricingCorpusPreparation,
): ForgewingPricingProposalV2Preparation {
  if (!Number.isSafeInteger(preparation.sourcePhysicalPageCount)
    || preparation.sourcePhysicalPageCount < 1) {
    throw new Error('forgewing_v2_source_page_count_unavailable');
  }
  const reconstructionRows = preparation.pricedScheduleReconstruction.pages.flatMap((page) =>
    page.rows.map((row) => ({ rowId: reconstructionRowId(page.physical_page_number, row.row_index) })));
  const reconstructionRowIds = new Set(reconstructionRows.map((row) => row.rowId));
  const diagnostics = diagnosticInventory(preparation);
  const diagnosticIds = new Set(diagnostics.observationIds);
  const acceptedIds = new Set(preparation.candidates.flatMap((candidate) =>
    candidate.rowObservation.cells.map((cell) => cell.observationId)));
  const acceptedDiagnosticOverlapIds = [...acceptedIds].filter((id) => diagnosticIds.has(id))
    .sort((a, b) => a.localeCompare(b, 'en-US'));
  const rows: ForgewingV2PreparedRow[] = [];
  const reasonCounts: Partial<Record<PhaseBRowReason, number>> = {};
  const addReason = (reason: PhaseBRowReason): void => {
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  };

  for (const candidate of preparation.candidates) {
    const row = candidate.rowObservation;
    if (!reconstructionRowIds.has(row.observationId)) {
      throw new Error('forgewing_v2_preparation_candidate_without_reconstructed_row');
    }
    const input = forgewingV2EligibilityInputForCandidate(candidate, diagnosticIds);
    const context = input.context as ForgewingSourceFieldContext;
    const eligibility = evaluateForgewingV2FieldEligibility(input);
    if (!eligibility.eligible) {
      eligibility.reasons.forEach(addReason);
      continue;
    }
    const cellById = new Map(row.cells.map((cell) => [cell.observationId, cell]));
    const fields = eligibility.fields.map((field): ForgewingV2PreparedField => ({ field,
      authoredRawTextDisplayOnly: field.authoredRawText,
      primitiveEvidence: field.sourceObservationIds.map((id) => {
        const cell = cellById.get(id);
        if (!cell) throw new Error('forgewing_v2_preparation_field_member_missing');
        return preparedPrimitive(cell);
      }) })).sort((left, right) => left.field.sourceFieldId.localeCompare(
      right.field.sourceFieldId, 'en-US'));
    const flattened = fields.flatMap((field) => field.field.sourceObservationIds);
    if (new Set(flattened).size !== row.cells.length
      || row.cells.some((cell) => !flattened.includes(cell.observationId))) {
      throw new Error('forgewing_v2_preparation_membership_closure_failed');
    }
    rows.push({ candidateId: hashCanonical(candidate), rowObservationId: row.observationId,
      context, fields, exactMembershipClosure: true });
  }
  rows.sort((left, right) => left.rowObservationId.localeCompare(right.rowObservationId, 'en-US'));
  const unmatchedReconstructionRows = reconstructionRows.length - preparation.candidates.length;
  for (let index = 0; index < unmatchedReconstructionRows; index += 1) {
    addReason('not_evidence_admitted_for_v2');
  }
  const sourceFieldIds = rows.flatMap((row) => row.fields.map((entry) => entry.field.sourceFieldId));
  const duplicates = [...new Set(sourceFieldIds.filter((id, index) =>
    sourceFieldIds.indexOf(id) !== index))].sort((a, b) => a.localeCompare(b, 'en-US'));
  const roleDistribution: Record<string, number> = {};
  for (const row of rows) for (const { field } of row.fields) {
    roleDistribution[field.sourceFieldRole] = (roleDistribution[field.sourceFieldRole] ?? 0) + 1;
  }
  const base = {
    reportVersion: FORGEWING_PRICING_PROPOSAL_V2_PREPARATION_VERSION,
    authority: 'non_authoritative_preparation' as const, providerCalls: 0 as const,
    promotionEvidence: false as const, promotionAuthorized: false as const,
    source: { ...preparation.source, physicalPageCount: preparation.sourcePhysicalPageCount },
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    reconstruction: { parserVersion: preparation.pricedScheduleReconstruction.parser_version,
      totalRows: reconstructionRows.length, diagnosticCount: diagnostics.count,
      diagnosticReasonCounts: diagnostics.reasonCounts,
      diagnosticObservationIds: diagnostics.observationIds,
      diagnosticRowLinkagePerformed: false as const, crossPageInferencePerformed: false as const },
    v1Compatibility: { candidateCount: preparation.candidates.length,
      candidateDigestSha256: hashCanonical(preparation.candidates),
      orderingDeterministic: preparation.orderingDeterministic },
    rowAccounting: { completeSourceCellGroupRows: preparation.candidates.filter((candidate) =>
      (candidate.rowObservation.sourceCellGroups?.length ?? 0) > 0).length,
    eligibleRows: rows.length, ineligibleRows: reconstructionRows.length - rows.length,
    ineligibilityReasonCounts: reasonCounts as Readonly<Record<PhaseBRowReason, number>> },
    fields: { count: sourceFieldIds.length, roleDistribution,
      sourceFieldIds: [...sourceFieldIds].sort((a, b) => a.localeCompare(b, 'en-US')),
      duplicateSourceFieldIds: duplicates, exactMembershipClosureFailures: 0,
      diagnosticMemberFailures: reasonCounts.diagnostic_only_member ?? 0,
      crossRowFailures: reasonCounts.cross_row_contamination ?? 0,
      crossPageFailures: reasonCounts.cross_page_membership ?? 0 },
    acceptedDiagnosticOverlapIds, rows,
  };
  if (duplicates.length > 0 || acceptedDiagnosticOverlapIds.length > 0) {
    throw new Error('forgewing_v2_preparation_identity_or_diagnostic_collision');
  }
  return { ...base, preparationDigestSha256: hashCanonical(base) };
}

export async function prepareForgewingPricingProposalV2(
  entry: ForgewingPricingCorpusEntry,
): Promise<ForgewingPricingProposalV2Preparation> {
  return prepareForgewingPricingProposalV2FromCorpus(await prepareForgewingPricingCorpus(entry));
}

export function joinPreparedForgewingPricingProposalV2(params: {
  row: ForgewingV2PreparedRow;
  proposal: ForgewingPricingInterpretationProposalV2;
}): ReturnType<typeof joinForgewingPricingInterpretationProposalV2> & Readonly<{
  rawPrimitiveEvidence: readonly ForgewingV2PreparedPrimitive[] }> {
  const eligibleFields = params.row.fields.map((entry) => entry.field);
  const joined = joinForgewingPricingInterpretationProposalV2({ candidateId: params.row.candidateId,
    context: params.row.context, eligibleFields, proposal: params.proposal });
  return { ...joined, rawPrimitiveEvidence: params.row.fields.flatMap((entry) =>
    entry.primitiveEvidence) };
}

export function implementationIdentity(): Readonly<{ commit: string; worktreeDirty: boolean }> {
  const git = (args: readonly string[]) => execFileSync('git', [...args], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return { commit: git(['rev-parse', 'HEAD']),
    worktreeDirty: git(['status', '--porcelain', '--untracked-files=no']).length > 0 };
}

export function writeForgewingPricingProposalV2PreparationArtifact(params: {
  outputPath: string;
  payload: unknown;
}): Readonly<{ path: string; sha256: string }> {
  const outputPath = resolve(params.outputPath);
  const bytes = `${canonicalJson(params.payload)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, { encoding: 'utf8', flag: 'wx' });
  const reread = readFileSync(outputPath, 'utf8');
  if (reread !== bytes) throw new Error('forgewing_v2_preparation_artifact_readback_mismatch');
  return { path: outputPath, sha256: sha256Hex(Buffer.from(reread, 'utf8')) };
}

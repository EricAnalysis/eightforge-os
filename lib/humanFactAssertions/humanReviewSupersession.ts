import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { HumanReviewReceipt, SupersededMachineRow } from '@/lib/humanFactAssertions/humanReviewReceipt';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  reviewedContractPricingRows,
  type CurrentDocumentEvidence,
  type EffectiveRegionAssertion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * HUMAN_REVIEWED is final authority for the physical source target it is bound
 * to (Forgewing resolution layer B3.1).
 *
 * One matcher decides every machine or fallback pricing row against the
 * effective human-reviewed rate rows, using source-bound evidence only:
 * document, physical page and source observations. Text, description or rate
 * similarity is never consulted. The decision is applied at two seams, both
 * calling the same matcher:
 * - the assembled-row list that legacy pricing, canonical truth and Project
 *   Truth publication all consume;
 * - the legacy-only fallback projections (persisted rate rows and
 *   `facts.rate_table`), which never enter assembly.
 *
 * Outcomes for a machine row:
 * - distinct: proven to be a different physical target, so it stays.
 * - superseded: it shares source observations with a reviewed row. The reviewed
 *   row wins, and the machine row's values are kept in the reviewed row's
 *   receipt as provenance.
 * - unprovable: it is in the same document as a reviewed row, but has no
 *   observations and is on the same page or an unknown page. It cannot be
 *   proven distinct, so it is withheld from pricing, never double-counted, and
 *   surfaced as a diagnostic.
 */

export type HumanReviewTarget = Readonly<{
  assertionId: string;
  documentId: string;
  physicalPageNumber: number;
  observationIds: ReadonlySet<string>;
}>;

export type MachineRowSourceBinding =
  | Readonly<{ kind: 'observations'; observationIds: readonly string[]; physicalPageNumber: number | null }>
  | Readonly<{ kind: 'page_only'; physicalPageNumber: number }>
  | Readonly<{ kind: 'unbound' }>;

export type HumanReviewDecision =
  | Readonly<{ kind: 'distinct' }>
  | Readonly<{ kind: 'superseded'; assertionIds: readonly string[] }>
  | Readonly<{ kind: 'unprovable'; assertionIds: readonly string[] }>;

/** A machine row as the matcher sees it, from either seam. */
export type MachinePricingRowIdentity = Readonly<{
  documentId: string;
  rowId: string | null;
  physicalPageNumber: number | null;
  /** Observations the row itself cites (`pricing_cell_evidence`), when it carries them. */
  cellObservationIds: readonly string[] | null;
}>;

export type HumanReviewWithheldRow = SupersededMachineRow & Readonly<{
  documentId: string;
  seam: 'assembled' | 'legacy_fallback';
  assertionIds: readonly string[];
}>;

const PAGE_PRICED_ROW_ID = /^page_priced_schedule:p(\d+):r(\d+)$/;

function positivePage(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Binds a machine row to its source evidence. Never by content. */
export function bindMachinePricingRow(
  row: MachinePricingRowIdentity,
  evidence: CurrentDocumentEvidence | undefined,
): MachineRowSourceBinding {
  if (row.cellObservationIds && row.cellObservationIds.length > 0) {
    return { kind: 'observations', observationIds: row.cellObservationIds, physicalPageNumber: row.physicalPageNumber };
  }
  const match = row.rowId ? PAGE_PRICED_ROW_ID.exec(row.rowId) : null;
  if (match && evidence) {
    const ids = evidence.reconstructionRowObservationIds.get(`${match[1]}:${match[2]}`);
    if (ids && ids.length > 0) {
      return { kind: 'observations', observationIds: ids, physicalPageNumber: Number(match[1]) };
    }
  }
  return row.physicalPageNumber != null
    ? { kind: 'page_only', physicalPageNumber: row.physicalPageNumber }
    : { kind: 'unbound' };
}

export function decideAgainstHumanReview(
  documentId: string,
  binding: MachineRowSourceBinding,
  targets: readonly HumanReviewTarget[],
): HumanReviewDecision {
  const sameDocument = targets.filter((target) => target.documentId === documentId);
  if (sameDocument.length === 0) return { kind: 'distinct' };
  if (binding.kind === 'observations') {
    const overlapping = sameDocument.filter((target) =>
      binding.observationIds.some((id) => target.observationIds.has(id)));
    return overlapping.length > 0
      ? { kind: 'superseded', assertionIds: overlapping.map((target) => target.assertionId).sort() }
      // Observation identity proves a different physical target, even on the same page.
      : { kind: 'distinct' };
  }
  const contested = binding.kind === 'page_only'
    ? sameDocument.filter((target) => target.physicalPageNumber === binding.physicalPageNumber)
    : sameDocument;
  return contested.length > 0
    ? { kind: 'unprovable', assertionIds: contested.map((target) => target.assertionId).sort() }
    : { kind: 'distinct' };
}

export function humanReviewTargets(params: {
  effective: readonly EffectiveRegionAssertion[];
  rateDocumentIds: ReadonlySet<string>;
}): HumanReviewTarget[] {
  return params.effective.flatMap((entry) =>
    entry.factKey === CONTRACT_RATE_ROW_FACT_KEY && params.rateDocumentIds.has(entry.documentId)
      && entry.provenance.sourceObservationIds.length > 0
      ? [{
          assertionId: entry.provenance.assertionId,
          documentId: entry.documentId,
          physicalPageNumber: entry.provenance.physicalPageNumber,
          observationIds: new Set(entry.provenance.sourceObservationIds),
        }]
      : []);
}

function recordValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] != null) return record[key];
  return null;
}

/** Identity of a legacy fallback record (persisted rate row or `facts.rate_table` entry). */
export function legacyFallbackRowIdentity(record: Record<string, unknown>, documentId: string): MachinePricingRowIdentity {
  const evidence = Array.isArray(record.pricing_cell_evidence) ? record.pricing_cell_evidence : [];
  const ids = evidence.flatMap((group) => {
    const values = (group as { source_observation_ids?: unknown } | null)?.source_observation_ids;
    return Array.isArray(values) ? values.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  });
  const rowId = recordValue(record, ['row_id', 'id']);
  return {
    documentId,
    rowId: typeof rowId === 'string' ? rowId : null,
    physicalPageNumber: positivePage(recordValue(record, ['page', 'source_page', 'page_number'])),
    cellObservationIds: ids.length > 0 ? [...new Set(ids)] : null,
  };
}

function summaryOfAssembledRow(row: ContractPricingAssemblyRow): SupersededMachineRow {
  return {
    row_id: row.id,
    source_kind: row.sourceKind ?? null,
    physical_page_number: row.page,
    description: row.sourceDescription ?? row.description ?? null,
    unit: row.unit,
    rate: row.rate,
    raw_text: row.rawText ?? null,
  };
}

export function summaryOfLegacyRecord(record: Record<string, unknown>, identity: MachinePricingRowIdentity): SupersededMachineRow {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const rate = recordValue(record, ['rate_amount', 'rate']);
  return {
    row_id: identity.rowId ?? 'legacy_fallback_row',
    source_kind: text(recordValue(record, ['source_kind'])) ?? 'legacy_fallback',
    physical_page_number: identity.physicalPageNumber,
    description: text(recordValue(record, ['source_description', 'description', 'material_type'])),
    unit: text(recordValue(record, ['unit_type', 'unit'])),
    rate: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
    raw_text: text(recordValue(record, ['raw_text', 'rate_raw'])),
  };
}

/**
 * The legacy fallback gate: the same matcher, applied where legacy pricing
 * reads rows that never entered assembly. Pure decisions; the pricing builder
 * records what it withheld or superseded.
 */
export type HumanReviewPricingGate = Readonly<{
  targets: readonly HumanReviewTarget[];
  decideLegacyRecord(record: Record<string, unknown>, documentId: string): Readonly<{
    decision: HumanReviewDecision;
    identity: MachinePricingRowIdentity;
  }>;
}>;

export const NO_HUMAN_REVIEW_GATE: HumanReviewPricingGate = Object.freeze({
  targets: [],
  decideLegacyRecord: (_record: Record<string, unknown>, documentId: string) => ({
    decision: { kind: 'distinct' } as const,
    identity: { documentId, rowId: null, physicalPageNumber: null, cellObservationIds: null },
  }),
});

export type HumanReviewedPricing = Readonly<{
  /** Machine rows that stay, then the reviewed rows. One list for every consumer. */
  rows: readonly ContractPricingAssemblyRow[];
  withheld: readonly HumanReviewWithheldRow[];
  gate: HumanReviewPricingGate;
}>;

/**
 * Applies human-reviewed authority to the assembled pricing rows. This is the
 * single seam before legacy and canonical projection.
 */
export function applyHumanReviewedPricing(params: {
  machineRows: readonly ContractPricingAssemblyRow[];
  effective: readonly EffectiveRegionAssertion[];
  rateDocumentIds: ReadonlySet<string>;
  currentEvidenceByDocumentId: ReadonlyMap<string, CurrentDocumentEvidence>;
}): HumanReviewedPricing {
  const targets = humanReviewTargets({ effective: params.effective, rateDocumentIds: params.rateDocumentIds });
  const gate: HumanReviewPricingGate = {
    targets,
    decideLegacyRecord(record, documentId) {
      const identity = legacyFallbackRowIdentity(record, documentId);
      const binding = bindMachinePricingRow(identity, params.currentEvidenceByDocumentId.get(documentId));
      return { decision: decideAgainstHumanReview(documentId, binding, targets), identity };
    },
  };
  if (targets.length === 0) {
    return {
      rows: [...params.machineRows, ...reviewedContractPricingRows(params)],
      withheld: [],
      gate,
    };
  }

  const kept: ContractPricingAssemblyRow[] = [];
  const supersededBy = new Map<string, SupersededMachineRow[]>();
  const withheld: HumanReviewWithheldRow[] = [];
  for (const row of params.machineRows) {
    const documentId = row.sourceDocumentId;
    if (!documentId) {
      kept.push(row);
      continue;
    }
    const identity: MachinePricingRowIdentity = {
      documentId, rowId: row.id, physicalPageNumber: positivePage(row.page), cellObservationIds: null,
    };
    const decision = decideAgainstHumanReview(
      documentId, bindMachinePricingRow(identity, params.currentEvidenceByDocumentId.get(documentId)), targets);
    if (decision.kind === 'distinct') {
      kept.push(row);
    } else if (decision.kind === 'superseded') {
      for (const assertionId of decision.assertionIds) {
        supersededBy.set(assertionId, [...(supersededBy.get(assertionId) ?? []), summaryOfAssembledRow(row)]);
      }
    } else {
      withheld.push({ ...summaryOfAssembledRow(row), documentId, seam: 'assembled', assertionIds: decision.assertionIds });
    }
  }

  // The reviewed row carries what it superseded: original machine values stay inspectable.
  const reviewed = reviewedContractPricingRows(params).map((row) => {
    const receipt = row.humanReview!;
    const superseded = supersededBy.get(receipt.assertion_id) ?? [];
    return superseded.length === 0 ? row : {
      ...row,
      humanReview: { ...receipt, superseded_machine_rows: superseded } satisfies HumanReviewReceipt,
    };
  });
  return { rows: [...kept, ...reviewed], withheld, gate };
}

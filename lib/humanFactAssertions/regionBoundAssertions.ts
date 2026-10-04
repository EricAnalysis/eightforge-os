import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { pricingAuthoritativePage } from '@/lib/extraction/pdf/pricedScheduleAuthority';
import type { HumanReviewReceipt } from '@/lib/humanFactAssertions/humanReviewReceipt';
import { HUMAN_REVIEWED_EVIDENCE_PREFIX } from '@/lib/validator/humanReviewedEvidence';
import { isSupportedPricedScheduleVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';
import type { PricedSchedulePage } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * Region-bound human-reviewed values (Forgewing resolution layer B3).
 *
 * An operator asserts a value for an exact source region that deterministic
 * extraction did not produce or could not prove. The assertion lives on the
 * existing append-only `human_fact_assertions` ledger. This module decides,
 * deterministically and fail-closed, which assertions are effective now.
 *
 * Authority classes:
 * - DETERMINISTIC: produced by extraction.
 * - AI_PROPOSED: a Forgewing proposal. It is never stored on this ledger and
 *   never effective.
 * - HUMAN_REVIEWED: every effective result here. It wins over machine values
 *   for the same target, and it keeps its full provenance so every consumer
 *   can show it as human-reviewed.
 *
 * This is EightForge Core. It never consults the Forgewing entitlement.
 */

export const HUMAN_FACT_ASSERTIONS_TABLE = 'human_fact_assertions' as const;
export const RECORD_REGION_BOUND_ASSERTION_RPC = 'record_region_bound_human_fact_assertion' as const;

/** A reviewed priced row the schedule should contain but extraction did not produce. */
export const CONTRACT_RATE_ROW_FACT_KEY = 'contract_rate_row' as const;

export type RegionBoundReviewOrigin =
  | 'operator_entered'
  | 'ai_proposed_operator_approved'
  | 'ai_proposed_operator_modified';

export type RegionBox = Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>;
export type SourceRegion = Readonly<{ coordinate_space: string; boxes: readonly RegionBox[] }>;

/** The persisted row, as selected. Treated as untrusted until parsed. */
export type HumanFactAssertionRow = Readonly<{
  id: string;
  organization_id: string;
  source_document_id: string | null;
  fact_key: string;
  asserted_value: unknown;
  source_binding: string;
  supersedes_assertion_id: string | null;
  actor_id: string;
  reason: string;
  asserted_at: string;
  status: string;
  source_artifact_id: string | null;
  physical_page_number: number | null;
  source_region: unknown;
  page_representation_digest: string | null;
  parser_version: string | null;
  source_observation_ids: readonly string[] | null;
  original_source_text: string | null;
  anchor_key: string | null;
  review_origin: string | null;
  forgewing_proposal_id: string | null;
}>;

export const HUMAN_FACT_ASSERTION_SELECT = [
  'id', 'organization_id', 'source_document_id', 'fact_key', 'asserted_value', 'source_binding',
  'supersedes_assertion_id', 'actor_id', 'reason', 'asserted_at', 'status', 'source_artifact_id',
  'physical_page_number', 'source_region', 'page_representation_digest', 'parser_version',
  'source_observation_ids', 'original_source_text', 'anchor_key', 'review_origin', 'forgewing_proposal_id',
].join(', ');

/** Everything a consumer needs to show the value as human-reviewed and trace it to source. */
export type HumanReviewedProvenance = Readonly<{
  authority: 'human_reviewed';
  assertionId: string;
  /** Oldest first, ending with assertionId. Superseded history is never dropped. */
  chainAssertionIds: readonly string[];
  supersedesAssertionId: string | null;
  actorId: string;
  reason: string;
  assertedAt: string;
  reviewOrigin: RegionBoundReviewOrigin;
  forgewingProposalId: string | null;
  sourceDocumentId: string;
  sourceArtifactId: string | null;
  physicalPageNumber: number;
  sourceRegion: SourceRegion;
  pageRepresentationDigest: string;
  parserVersion: string | null;
  sourceObservationIds: readonly string[];
  /** What extraction read at this region, if anything. Never rewritten. */
  originalSourceText: string | null;
}>;

export type EffectiveRegionAssertion = Readonly<{
  documentId: string;
  factKey: string;
  anchorKey: string;
  value: unknown;
  provenance: HumanReviewedProvenance;
}>;

export type HeldRegionAssertionReason =
  /** The page the operator reviewed has been re-extracted into a different representation. */
  | 'page_representation_changed'
  /** The current page representation is unknown, so equivalence cannot be proven. */
  | 'page_representation_unverifiable'
  /** More than one active value competes for the same target. None is chosen. */
  | 'ambiguous_competing_assertions'
  /** A reviewed rate row cites no source observation, so its physical target cannot be bound. */
  | 'source_observations_required'
  /** The asserted value does not have the shape its fact key requires. */
  | 'invalid_asserted_value';

export type HeldRegionAssertion = Readonly<{
  reason: HeldRegionAssertionReason;
  documentId: string;
  factKey: string;
  anchorKey: string;
  assertionIds: readonly string[];
}>;

/** What the current extraction of one document presents, read from its persisted layers. */
export type CurrentDocumentEvidence = Readonly<{
  pageRepresentationDigestByPage: ReadonlyMap<number, string>;
  /**
   * Observation ids of every reconstructed row, keyed `${page}:${rowIndex}`.
   * Binds a machine pricing row (`page_priced_schedule:p{page}:r{rowIndex}`)
   * to the exact source observations it was built from.
   */
  reconstructionRowObservationIds: ReadonlyMap<string, readonly string[]>;
}>;

export type RegionAssertionResolution = Readonly<{
  effective: readonly EffectiveRegionAssertion[];
  held: readonly HeldRegionAssertion[];
}>;

type ParsedRow = Readonly<{
  row: HumanFactAssertionRow;
  documentId: string;
  anchorKey: string;
  provenance: Omit<HumanReviewedProvenance, 'chainAssertionIds'>;
}>;

const REVIEW_ORIGINS = new Set<string>([
  'operator_entered', 'ai_proposed_operator_approved', 'ai_proposed_operator_modified',
]);
const DIGEST = /^[0-9a-f]{64}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseRegion(value: unknown): SourceRegion | null {
  const record = asRecord(value);
  if (!record || typeof record.coordinate_space !== 'string' || !Array.isArray(record.boxes)
    || record.boxes.length === 0) return null;
  const boxes: RegionBox[] = [];
  for (const entry of record.boxes) {
    const box = asRecord(entry);
    if (!box) return null;
    const { x_min, x_max, y_min, y_max } = box;
    if (![x_min, x_max, y_min, y_max].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if ((x_min as number) > (x_max as number) || (y_min as number) > (y_max as number)) return null;
    boxes.push({ x_min: x_min as number, x_max: x_max as number, y_min: y_min as number, y_max: y_max as number });
  }
  return { coordinate_space: record.coordinate_space, boxes };
}

/** Only complete region-bound rows parse. Anything else is not a region-bound assertion. */
function parseRow(row: HumanFactAssertionRow): ParsedRow | null {
  if (row.source_binding !== 'region_bound') return null;
  const region = parseRegion(row.source_region);
  if (!row.source_document_id || !row.anchor_key || !region
    || typeof row.physical_page_number !== 'number' || !Number.isInteger(row.physical_page_number)
    || row.physical_page_number < 1
    || typeof row.page_representation_digest !== 'string' || !DIGEST.test(row.page_representation_digest)
    || !row.review_origin || !REVIEW_ORIGINS.has(row.review_origin)
    || (row.status !== 'active' && row.status !== 'withdrawn')) return null;
  return {
    row,
    documentId: row.source_document_id,
    anchorKey: row.anchor_key,
    provenance: {
      authority: 'human_reviewed',
      assertionId: row.id,
      supersedesAssertionId: row.supersedes_assertion_id,
      actorId: row.actor_id,
      reason: row.reason,
      assertedAt: row.asserted_at,
      reviewOrigin: row.review_origin as RegionBoundReviewOrigin,
      forgewingProposalId: row.forgewing_proposal_id,
      sourceDocumentId: row.source_document_id,
      sourceArtifactId: row.source_artifact_id,
      physicalPageNumber: row.physical_page_number,
      sourceRegion: region,
      pageRepresentationDigest: row.page_representation_digest,
      parserVersion: row.parser_version,
      sourceObservationIds: [...(row.source_observation_ids ?? [])],
      originalSourceText: row.original_source_text,
    },
  };
}

export type ReviewedRateRowValue = Readonly<{
  description: string;
  unit_type: string;
  rate_amount: number;
  /** Optional. Without it canonical truth keeps the row in review, as for any row. */
  category: string | null;
}>;

export function parseReviewedRateRowValue(value: unknown): ReviewedRateRowValue | null {
  const record = asRecord(value);
  if (!record) return null;
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const unitType = typeof record.unit_type === 'string' ? record.unit_type.trim() : '';
  const rate = record.rate_amount;
  if (!description || !unitType || typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  const category = typeof record.category === 'string' && record.category.trim() ? record.category.trim() : null;
  return { description, unit_type: unitType, rate_amount: rate, category };
}

function chainKey(entry: ParsedRow): string {
  return JSON.stringify([entry.row.organization_id, entry.documentId, entry.row.fact_key, entry.anchorKey]);
}

/**
 * Decides which region-bound assertions are effective against the documents'
 * current extraction. Deterministic for any input order. Fail-closed:
 * - a chain with more than one head is ambiguous, and none of its values is used;
 * - a withdrawn head contributes no value;
 * - a head whose reviewed page digest differs from the current page, or
 *   cannot be compared, is held for re-review and never silently reapplied;
 * - two effective values for one document field across different anchors
 *   are ambiguous, and neither is used.
 */
export function resolveRegionBoundAssertions(params: {
  rows: readonly HumanFactAssertionRow[];
  currentEvidenceByDocumentId: ReadonlyMap<string, CurrentDocumentEvidence>;
}): RegionAssertionResolution {
  const parsed = params.rows.flatMap((row) => {
    const entry = parseRow(row);
    return entry ? [entry] : [];
  });
  const supersededIds = new Set(parsed.flatMap((entry) =>
    entry.row.supersedes_assertion_id ? [entry.row.supersedes_assertion_id] : []));
  const byId = new Map(parsed.map((entry) => [entry.row.id, entry] as const));
  const chains = new Map<string, ParsedRow[]>();
  for (const entry of parsed) {
    const key = chainKey(entry);
    chains.set(key, [...(chains.get(key) ?? []), entry]);
  }

  const held: HeldRegionAssertion[] = [];
  const candidates: EffectiveRegionAssertion[] = [];
  const holdOf = (reason: HeldRegionAssertionReason, entry: ParsedRow, ids: readonly string[]): HeldRegionAssertion => ({
    reason, documentId: entry.documentId, factKey: entry.row.fact_key, anchorKey: entry.anchorKey,
    assertionIds: [...ids].sort(),
  });

  for (const chain of chains.values()) {
    const heads = chain.filter((entry) => !supersededIds.has(entry.row.id));
    if (heads.length !== 1) {
      held.push(holdOf('ambiguous_competing_assertions', chain[0]!, heads.map((entry) => entry.row.id)));
      continue;
    }
    const head = heads[0]!;
    if (head.row.status === 'withdrawn') continue;
    const evidence = params.currentEvidenceByDocumentId.get(head.documentId);
    const currentDigest = evidence?.pageRepresentationDigestByPage.get(head.provenance.physicalPageNumber) ?? null;
    if (currentDigest == null) {
      held.push(holdOf('page_representation_unverifiable', head, [head.row.id]));
      continue;
    }
    if (currentDigest !== head.provenance.pageRepresentationDigest) {
      held.push(holdOf('page_representation_changed', head, [head.row.id]));
      continue;
    }
    if (head.row.fact_key === CONTRACT_RATE_ROW_FACT_KEY) {
      if (!parseReviewedRateRowValue(head.row.asserted_value)) {
        held.push(holdOf('invalid_asserted_value', head, [head.row.id]));
        continue;
      }
      // Human review supersedes machine rows only on source-bound proof, which
      // needs the reviewed row's own observations.
      if (head.provenance.sourceObservationIds.length === 0) {
        held.push(holdOf('source_observations_required', head, [head.row.id]));
        continue;
      }
    }
    const chainAssertionIds: string[] = [];
    for (let cursor: ParsedRow | undefined = head; cursor; ) {
      chainAssertionIds.unshift(cursor.row.id);
      const previous: string | null = cursor.row.supersedes_assertion_id;
      cursor = previous ? byId.get(previous) : undefined;
      if (cursor && chainAssertionIds.includes(cursor.row.id)) break;
    }
    candidates.push({
      documentId: head.documentId,
      factKey: head.row.fact_key,
      anchorKey: head.anchorKey,
      value: head.row.asserted_value,
      provenance: { ...head.provenance, chainAssertionIds },
    });
  }

  // Reviewed rate rows are distinct rows, but two of them may not claim the
  // same source observation: one priced line is one row.
  const rateRows = candidates.filter((entry) => entry.factKey === CONTRACT_RATE_ROW_FACT_KEY);
  const claimed = new Map<string, EffectiveRegionAssertion[]>();
  for (const row of rateRows) {
    for (const id of new Set(row.provenance.sourceObservationIds)) {
      const key = JSON.stringify([row.documentId, id]);
      claimed.set(key, [...(claimed.get(key) ?? []), row]);
    }
  }
  const contested = new Set([...claimed.values()].filter((rows) => rows.length > 1).flat());
  const effective: EffectiveRegionAssertion[] = rateRows.filter((row) => !contested.has(row));
  for (const row of contested) {
    held.push({
      reason: 'ambiguous_competing_assertions', documentId: row.documentId, factKey: row.factKey,
      anchorKey: row.anchorKey, assertionIds: [row.provenance.assertionId],
    });
  }

  // A document field holds one value.
  const fieldGroups = new Map<string, EffectiveRegionAssertion[]>();
  for (const candidate of candidates) {
    if (candidate.factKey === CONTRACT_RATE_ROW_FACT_KEY) continue;
    const key = JSON.stringify([candidate.documentId, candidate.factKey]);
    fieldGroups.set(key, [...(fieldGroups.get(key) ?? []), candidate]);
  }
  for (const group of fieldGroups.values()) {
    const values = new Set(group.map((entry) => JSON.stringify(entry.value)));
    if (values.size > 1) {
      held.push({
        reason: 'ambiguous_competing_assertions', documentId: group[0]!.documentId,
        factKey: group[0]!.factKey, anchorKey: group.map((entry) => entry.anchorKey).sort().join(','),
        assertionIds: group.map((entry) => entry.provenance.assertionId).sort(),
      });
      continue;
    }
    // Equal values on several anchors: one deterministic representative.
    effective.push([...group].sort((left, right) => left.anchorKey.localeCompare(right.anchorKey, 'en-US'))[0]!);
  }

  const order = (left: { documentId: string; factKey: string; anchorKey: string },
    right: { documentId: string; factKey: string; anchorKey: string }) =>
    left.documentId.localeCompare(right.documentId, 'en-US')
    || left.factKey.localeCompare(right.factKey, 'en-US')
    || left.anchorKey.localeCompare(right.anchorKey, 'en-US');
  return {
    effective: effective.sort(order),
    held: held.sort((left, right) => order(left, right) || left.reason.localeCompare(right.reason, 'en-US')),
  };
}

/**
 * Reads what the current extraction presents from the persisted extraction
 * blob the Validator already loads: per-page representation digests from the
 * coverage layer, and the observations deterministic pricing admitted.
 */
export function currentDocumentEvidenceFromExtractionData(data: unknown): CurrentDocumentEvidence {
  const extraction = asRecord(asRecord(data)?.extraction);
  const pdf = asRecord(asRecord(extraction?.content_layers_v1)?.pdf);
  const digests = new Map<number, string>();
  const coveragePages = asRecord(pdf?.page_extraction_coverage_v1)?.pages;
  if (Array.isArray(coveragePages)) {
    for (const entry of coveragePages) {
      const page = asRecord(entry);
      const number = page?.page_number;
      const digest = page?.page_representation_digest;
      if (typeof number !== 'number' || typeof digest !== 'string' || !DIGEST.test(digest)) continue;
      // A page listed twice with different digests cannot be proven; drop it.
      if (digests.has(number) && digests.get(number) !== digest) digests.set(number, '');
      else digests.set(number, digest);
    }
  }
  for (const [page, digest] of [...digests]) if (!digest) digests.delete(page);

  const rowObservations = new Map<string, readonly string[]>();
  const reconstruction = asRecord(pdf?.priced_schedule_reconstruction_v1);
  const version = reconstruction?.parser_version;
  if (isSupportedPricedScheduleVersion(version) && Array.isArray(reconstruction?.pages)) {
    for (const page of reconstruction.pages as PricedSchedulePage[]) {
      // The rows pricing actually consumed, exactly as contract rate rows read them.
      const authoritative = asRecord(page) ? pricingAuthoritativePage(page, version) : null;
      for (const row of authoritative?.rows ?? []) {
        const ids = [...new Set((row.cells ?? []).flatMap((cell) =>
          (cell.source_refs ?? []).flatMap((ref) => (ref?.observation_id ? [ref.observation_id] : []))))];
        rowObservations.set(`${page.physical_page_number}:${row.row_index}`, ids);
      }
    }
  }
  return { pageRepresentationDigestByPage: digests, reconstructionRowObservationIds: rowObservations };
}

function formatValue(value: unknown): string {
  const rate = parseReviewedRateRowValue(value);
  if (rate) return `${rate.description} · ${rate.unit_type} · ${rate.rate_amount}`;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Operator-facing provenance label. Shows the original extraction reading,
 * the Forgewing suggestion when one existed and differed, and the final
 * human-reviewed value. Nothing earlier in the chain is hidden.
 */
export function describeHumanReviewedValue(params: {
  value: unknown;
  provenance: HumanReviewedProvenance;
  /** The Forgewing proposal's value, resolved from its own non-authoritative record. */
  forgewingSuggestedValue?: unknown;
}): string {
  const parts = [`${HUMAN_REVIEWED_EVIDENCE_PREFIX} value: ${formatValue(params.value)}`];
  parts.push(params.provenance.originalSourceText != null
    ? `extraction read "${params.provenance.originalSourceText}"`
    : 'extraction produced no value');
  if (params.forgewingSuggestedValue !== undefined
    && JSON.stringify(params.forgewingSuggestedValue) !== JSON.stringify(params.value)) {
    parts.push(`Forgewing suggested ${formatValue(params.forgewingSuggestedValue)}; operator entered ${formatValue(params.value)}`);
  }
  parts.push(`page ${params.provenance.physicalPageNumber}`);
  parts.push(`assertion ${params.provenance.assertionId}`);
  if (params.provenance.chainAssertionIds.length > 1) {
    parts.push(`supersedes ${params.provenance.chainAssertionIds.length - 1} earlier review(s)`);
  }
  parts.push(`reason: ${params.provenance.reason}`);
  return parts.join(' · ');
}

export function humanReviewReceiptOf(provenance: HumanReviewedProvenance): HumanReviewReceipt {
  return {
    status: 'human_reviewed',
    assertion_id: provenance.assertionId,
    chain_assertion_ids: [...provenance.chainAssertionIds],
    review_origin: provenance.reviewOrigin,
    forgewing_proposal_id: provenance.forgewingProposalId,
    actor_id: provenance.actorId,
    reason: provenance.reason,
    asserted_at: provenance.assertedAt,
    source_document_id: provenance.sourceDocumentId,
    physical_page_number: provenance.physicalPageNumber,
    page_representation_digest: provenance.pageRepresentationDigest,
    source_observation_ids: [...provenance.sourceObservationIds],
    original_source_text: provenance.originalSourceText,
  };
}

/**
 * Effective reviewed rate rows as pricing-assembly rows, for documents that
 * are rate sources in this execution. They join the one assembled-row list
 * that both the legacy Validator projection and canonical truth consume, so
 * reviewed pricing reaches both through the existing shared builders and
 * never through a parallel path.
 */
export function reviewedContractPricingRows(params: {
  effective: readonly EffectiveRegionAssertion[];
  rateDocumentIds: ReadonlySet<string>;
}): ContractPricingAssemblyRow[] {
  return params.effective.flatMap((entry) => {
    if (entry.factKey !== CONTRACT_RATE_ROW_FACT_KEY || !params.rateDocumentIds.has(entry.documentId)) return [];
    const value = parseReviewedRateRowValue(entry.value);
    if (!value) return [];
    const id = `human_fact_assertion:${entry.provenance.assertionId}`;
    const row: ContractPricingAssemblyRow = {
      id,
      sourceDocumentId: entry.documentId,
      sourceDescription: value.description,
      authoredEquivalenceKey: null,
      category: value.category,
      description: value.description,
      route: null,
      distanceBand: null,
      unit: value.unit_type,
      rate: value.rate_amount,
      page: entry.provenance.physicalPageNumber,
      sourceAnchor: id,
      confidence: 'high',
      sourceKind: 'human_reviewed_assertion',
      sourceQuality: 'clean',
      // Not an authored correction: an operator reviewed the source region.
      authoredValueCorrection: false,
      // What extraction actually read there, kept as the observed raw value.
      ...(entry.provenance.originalSourceText != null ? { rawText: entry.provenance.originalSourceText } : {}),
      humanReview: humanReviewReceiptOf(entry.provenance),
    };
    return [row];
  });
}

/** Effective document-field assertions, one per (document, field). */
export function reviewedDocumentFieldAssertions(
  effective: readonly EffectiveRegionAssertion[],
): EffectiveRegionAssertion[] {
  return effective.filter((entry) => entry.factKey !== CONTRACT_RATE_ROW_FACT_KEY);
}

export type VerifiedRegionEvidence =
  | Readonly<{
      status: 'verified';
      /** Joined raw text of the cited observations, in the order cited; null when none were cited. */
      originalSourceText: string | null;
      sourceArtifactId: string | null;
      parserVersion: string | null;
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'page_representation_not_current' | 'page_representation_unknown' | 'unknown_source_observation';
    }>;

/**
 * Server-side check that an operator's region binds the evidence the current
 * extraction actually presents. The page digest must be current, and every
 * cited observation must exist on that page. The original source text is read
 * from the persisted observations, never taken from the caller, so a reviewed
 * value can never misstate what extraction read.
 */
export function verifyRegionEvidence(params: {
  extractionData: unknown;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  sourceObservationIds: readonly string[];
}): VerifiedRegionEvidence {
  const current = currentDocumentEvidenceFromExtractionData(params.extractionData);
  const digest = current.pageRepresentationDigestByPage.get(params.physicalPageNumber);
  if (!digest) return { status: 'rejected', reason: 'page_representation_unknown' };
  if (digest !== params.pageRepresentationDigest) return { status: 'rejected', reason: 'page_representation_not_current' };

  const pdf = asRecord(asRecord(asRecord(asRecord(params.extractionData)?.extraction)?.content_layers_v1)?.pdf);
  const layer = asRecord(pdf?.layout_observations_v1);
  const byId = new Map<string, string | null>();
  for (const entry of Array.isArray(layer?.observations) ? layer.observations : []) {
    const observation = asRecord(entry);
    if (!observation || typeof observation.id !== 'string' || typeof observation.raw_text !== 'string'
      || observation.physical_page_number !== params.physicalPageNumber) continue;
    // An id defined twice is ambiguous and unusable.
    byId.set(observation.id, byId.has(observation.id) ? null : observation.raw_text);
  }
  const texts: string[] = [];
  for (const id of params.sourceObservationIds) {
    const text = byId.get(id);
    if (text == null) return { status: 'rejected', reason: 'unknown_source_observation' };
    texts.push(text);
  }
  const reconstructionVersion = asRecord(pdf?.priced_schedule_reconstruction_v1)?.parser_version;
  return {
    status: 'verified',
    originalSourceText: texts.length > 0 ? texts.join(' ') : null,
    sourceArtifactId: typeof layer?.source_artifact_id === 'string' ? layer.source_artifact_id : null,
    parserVersion: typeof reconstructionVersion === 'string' ? reconstructionVersion : null,
  };
}

/** A priced line extraction recorded but could not read as a table row, offered for operator review. */
export type RegionAssertionEntryTarget = Readonly<{
  anchorKey: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  unresolvedReason: string;
  rawText: string;
  sourceObservationIds: readonly string[];
  sourceRegion: SourceRegion;
}>;

/**
 * Entry targets for reviewed rate rows: the priced lines B2 recorded on pages
 * deterministic reconstruction could not read, on pages whose current
 * representation is known. Derived on the server from the current extraction,
 * so the client never supplies an anchor of its own.
 */
export function regionAssertionEntryTargets(extractionData: unknown): RegionAssertionEntryTarget[] {
  const current = currentDocumentEvidenceFromExtractionData(extractionData);
  const pdf = asRecord(asRecord(asRecord(asRecord(extractionData)?.extraction)?.content_layers_v1)?.pdf);
  const unresolved = asRecord(pdf?.priced_schedule_reconstruction_v1)?.unresolved_pages;
  if (!Array.isArray(unresolved)) return [];
  const targets: RegionAssertionEntryTarget[] = [];
  for (const entry of unresolved) {
    const page = asRecord(entry);
    const pageNumber = page?.physical_page_number;
    if (typeof pageNumber !== 'number' || !Array.isArray(page?.priced_lines)) continue;
    const digest = current.pageRepresentationDigestByPage.get(pageNumber);
    if (!digest) continue;
    for (const lineEntry of page.priced_lines) {
      const line = asRecord(lineEntry);
      const refs = Array.isArray(line?.source_refs) ? line.source_refs.map(asRecord) : [];
      const ids = refs.flatMap((ref) => typeof ref?.observation_id === 'string' ? [ref.observation_id] : []);
      const boxes = refs.flatMap((ref) => ref && [ref.x_min, ref.x_max, ref.y_min, ref.y_max].every((n) => typeof n === 'number')
        ? [{ x_min: ref.x_min as number, x_max: ref.x_max as number, y_min: ref.y_min as number, y_max: ref.y_max as number }]
        : []);
      // Only lines whose every token carries an observation identity can be bound exactly.
      if (ids.length === 0 || ids.length !== refs.length || typeof line?.raw_text !== 'string' || typeof line?.y !== 'number') continue;
      targets.push({
        anchorKey: `p${pageNumber}:priced_line:${hashCanonical(ids).slice(0, 32)}`,
        physicalPageNumber: pageNumber,
        pageRepresentationDigest: digest,
        unresolvedReason: typeof page.reason === 'string' ? page.reason : 'unresolved',
        rawText: line.raw_text,
        sourceObservationIds: ids,
        sourceRegion: { coordinate_space: 'source', boxes },
      });
    }
  }
  return targets;
}

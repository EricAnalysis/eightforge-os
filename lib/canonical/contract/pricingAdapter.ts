/**
 * Adapter: already-assembled `ContractPricingAssemblyRow` → canonical candidate.
 *
 * Boundary rules for this file:
 *
 *   - It does NOT call `assembleContractPricingRows`. It accepts rows the
 *     caller already produced, so it cannot influence assembler behaviour and
 *     cannot see rows the assembler discarded (see the report's row-loss §).
 *   - It NEVER filters. `adaptAssembledPricingRows` returns exactly one
 *     candidate per input row, in input order.
 *   - It never guesses. A value the source did not carry stays `null`, and a
 *     missing value is never promoted to `not_applicable`.
 *   - It never assigns synthetic provenance. `extractor` is read only from
 *     observed geometry metadata; it is never inferred from `sourceKind`,
 *     because a source-family name is not evidence of an observing engine.
 *   - `sourceKind` / `sourceQuality` are preserved verbatim as opaque
 *     provenance. Nothing in `lib/canonical/**` branches on their values.
 *
 * Additive and unreachable from production in this slice.
 */

import {
  contractPricingScopedRowId,
  type ContractPricingAssemblyRow,
  type ContractPricingRowMergeDiagnostic,
} from '@/lib/contracts/contractPricingAssembly';
import type { GeometryCellRef, TableCellGeometry } from '@/lib/extraction/tableGeometry';
import {
  asCanonicalExtractor,
  canonicalBoundingBox,
  canonicalEvidenceRef,
  dedupeEvidenceRefs,
  type CanonicalEvidenceRef,
} from '@/lib/canonical/truth/envelope';
import {
  normalizeCanonicalDescription,
  type CanonicalContractPricingCandidate,
  type CanonicalGoverningDocumentRef,
  type CanonicalPricingContent,
  type CanonicalPricingMergeDiagnostic,
  type CanonicalRateScheduleRef,
} from '@/lib/canonical/contract/pricing';

/** Default identity recorded on every candidate this adapter emits. */
export const CONTRACT_PRICING_ASSEMBLY_ADAPTER_ID = 'contract_pricing_assembly_row:v1';

/**
 * Placeholder descriptions the upstream assembler substitutes when it could not
 * recover readable text.
 *
 * This is a contract with the ADAPTER'S OWN SOURCE, not a document assumption:
 * it names no category, page, table, rate, or filename, and it is overridable.
 * Treating the sentinel as a real description would publish a placeholder as
 * canonical truth; ignoring it entirely would lose the fact that the assembler
 * saw something unreadable, which is why it is retained in `rawValues`.
 */
export const DEFAULT_UNRESOLVED_DESCRIPTION_SENTINELS: readonly string[] = [
  'Raw row needs review',
];

export type ContractPricingAdapterContext = {
  readonly documentId?: string | null;
  readonly projectId?: string | null;
  readonly rateSchedule?: CanonicalRateScheduleRef | null;
  readonly governingDocument?: CanonicalGoverningDocumentRef | null;
  readonly adapterId?: string;
  readonly unresolvedDescriptionSentinels?: readonly string[];
};

// ─── Evidence construction ───────────────────────────────────────────────────

function boundingBoxFromGeometry(geometry: TableCellGeometry) {
  const box = canonicalBoundingBox({
    x0: geometry.x_min ?? null,
    y0: geometry.y_min ?? null,
    x1: geometry.x_max ?? null,
    y1: geometry.y_max ?? null,
    // Legacy table geometry does not prove page-normalized coordinates.
    // Asserting normalization would be synthetic provenance.
    coordinateSpace: 'unspecified',
  });
  return box.x0 == null && box.y0 == null && box.x1 == null && box.y1 == null ? null : box;
}

function evidenceFromGeometryRef(
  ref: GeometryCellRef,
  context: ContractPricingAdapterContext,
  sourceDocumentId: string | null,
): CanonicalEvidenceRef {
  const geometry = ref.geometry;
  return canonicalEvidenceRef({
    documentId: geometry.source_document_id ?? sourceDocumentId ?? context.documentId ?? null,
    page: geometry.page_number ?? null,
    boundingBox: boundingBoxFromGeometry(geometry),
    rawSpan: ref.text ?? geometry.text ?? null,
    sourceAnchor: geometry.anchor_id ?? null,
    tableKey: geometry.table_id ?? null,
    rowIndex: geometry.row_index ?? null,
    cellIndex: geometry.cell_index ?? null,
    extractor: asCanonicalExtractor(geometry.source_type),
    // No per-cell recognition confidence survives to this layer. Null, not 1.
    recognitionConfidence: null,
  });
}

/**
 * Row-level evidence, deterministic:
 *   1. the row's own anchor/page reference, when either is present;
 *   2. one reference per geometry ref, in input order.
 * Duplicates are removed keeping first-seen order.
 */
function buildEvidence(
  row: ContractPricingAssemblyRow,
  context: ContractPricingAdapterContext,
): readonly CanonicalEvidenceRef[] {
  const refs: CanonicalEvidenceRef[] = [];

  if (row.sourceAnchor != null || row.page != null) {
    refs.push(
      canonicalEvidenceRef({
        // The row's own source document wins over the assembly-wide context:
        // rows assembled from an attached price sheet must anchor to that
        // sheet, not to the governing contract.
        documentId: row.sourceDocumentId ?? context.documentId ?? null,
        page: row.page,
        sourceAnchor: row.sourceAnchor,
        rawSpan: row.rawText ?? null,
        // The assembler records no observing engine at row level.
        extractor: null,
        recognitionConfidence: null,
      }),
    );
  }

  for (const geometryRef of row.geometryRefs ?? []) {
    refs.push(evidenceFromGeometryRef(geometryRef, context, row.sourceDocumentId ?? null));
  }

  const physicalAliases = [...new Set(row.sourceAliasDocumentIds ?? [])]
    .filter((documentId) => documentId !== row.sourceDocumentId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const primaryRefs = dedupeEvidenceRefs(refs);
  const aliasRefs = physicalAliases.flatMap((documentId) =>
    primaryRefs.map((ref) => ({ ...ref, documentId })));
  return dedupeEvidenceRefs([...primaryRefs, ...aliasRefs]);
}

// ─── Merge diagnostics ───────────────────────────────────────────────────────

function adaptMergeDiagnostic(
  diagnostic: ContractPricingRowMergeDiagnostic,
): CanonicalPricingMergeDiagnostic {
  return {
    droppedRowId: diagnostic.droppedRowId,
    droppedSourceKind: diagnostic.droppedSourceKind ?? null,
    droppedSourceAnchor: diagnostic.droppedSourceAnchor ?? null,
    droppedRate: diagnostic.droppedRate ?? null,
    droppedDescription: diagnostic.droppedDescription ?? null,
    droppedQualityScore: diagnostic.droppedQualityScore ?? null,
    winningRowId: diagnostic.winningRowId,
    winningQualityScore: diagnostic.winningQualityScore ?? null,
    reason: diagnostic.reason,
    comparisonMethod: diagnostic.comparisonMethod,
  };
}

// ─── Pricing-content classification ──────────────────────────────────────────

/**
 * The single structural predicate in this adapter.
 *
 * A candidate with no rate, no unit, no quantity, no total, no rate code, no
 * pass-through state and no category carries no pricing-bearing dimension at
 * all. That is a statement about the record's shape, not about any document.
 */
function classifyPricingContent(
  input: {
    readonly rate: number | null;
    readonly unit: string | null;
    readonly quantity: number | null;
    readonly totalAmount: number | null;
    readonly rateCode: string | null;
    readonly passThrough: boolean | null;
    readonly category: string | null;
  },
): CanonicalPricingContent {
  const bearsPricing =
    input.rate != null
    || input.unit != null
    || input.quantity != null
    || input.totalAmount != null
    || input.rateCode != null
    || input.passThrough != null
    || input.category != null;
  return bearsPricing ? 'pricing' : 'non_pricing';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Adapt a single assembled row. Never returns null: an unusable row still
 * becomes a candidate so it stays addressable downstream.
 */
export function adaptAssembledPricingRow(
  row: ContractPricingAssemblyRow,
  ordinal: number,
  context: ContractPricingAdapterContext = {},
): CanonicalContractPricingCandidate {
  const sentinels = context.unresolvedDescriptionSentinels
    ?? DEFAULT_UNRESOLVED_DESCRIPTION_SENTINELS;
  const rawDescription = nonEmpty(row.description);
  const descriptionIsSentinel =
    rawDescription != null && sentinels.includes(rawDescription);
  const description = descriptionIsSentinel ? null : rawDescription;
  // Carried straight through from assembly. When the display value is the
  // sentinel this is what still holds the real line item, so it — not
  // `description` — is what semantic identity downstream is built from.
  const sourceDescription = nonEmpty(row.sourceDescription ?? null);

  const evidence = buildEvidence(row, context);

  // Fields the current assembler simply does not carry. They stay null; they
  // are neither invented nor marked inapplicable.
  const rateCode: string | null = null;
  const passThrough: boolean | null = null;

  const category = nonEmpty(row.category);
  const unit = nonEmpty(row.unit);
  const rate = finiteOrNull(row.rate);
  const quantity = finiteOrNull(row.quantity);
  const totalAmount = finiteOrNull(row.totalAmount);

  return {
    // Document-scoped: the bare physical row id collides across two documents
    // carrying the same extracted table, which would silently merge or shadow
    // rows that belong to different sources.
    candidateId: contractPricingScopedRowId(row),
    ordinal,

    rateSchedule: context.rateSchedule ?? null,
    governingDocument: context.governingDocument ?? null,

    rateCode,
    category,
    subcategory: null,
    description,
    sourceDescription,
    // Normalized from SOURCE truth, not the display value: this field is the
    // comparison-facing representation, and normalizing the sentinel would key
    // every unreadable row to the same string.
    normalizedDescription: normalizeCanonicalDescription(sourceDescription),
    unit,
    rate,
    // The assembler carries no currency. Defaulting to USD would fill an
    // absent field, so it stays null.
    currency: null,

    pricingMethod: null,
    materialType: null,
    serviceType: null,
    origin: null,
    destination: null,
    route: nonEmpty(row.route),
    distanceBand: nonEmpty(row.distanceBand),
    pricingDimensions: row.pricingDimensions ?? null,
    pricingDimensionSources: row.pricingDimensionSources ?? null,
    equipmentType: null,
    personnelClassification: null,
    sizeOrDiameterBand: null,

    quantity,
    totalAmount,

    passThrough,
    markup: null,
    minimumCharge: null,
    maximumOrNteAmount: null,
    effectivePeriod: null,
    applicabilityConditions: [],
    exclusions: [],

    sourceFamily: {
      adapterId: context.adapterId ?? CONTRACT_PRICING_ASSEMBLY_ADAPTER_ID,
      // Opaque provenance. Never read by a resolution or approval rule.
      sourceKind: row.sourceKind ?? null,
      sourceQuality: row.sourceQuality ?? null,
      ...(row.logicalSourceIdentity != null
        ? { logicalSourceIdentity: row.logicalSourceIdentity }
        : {}),
      ...(row.sourceAliasDocumentIds != null
        ? { physicalDocumentIds: [...row.sourceAliasDocumentIds] }
        : {}),
    },
    rawValues: {
      // The sentinel is retained here so the fact that the assembler saw
      // unreadable content is not lost.
      description: rawDescription,
      rawText: nonEmpty(row.rawText ?? null),
      rawCells: [],
      quantityText: nonEmpty(row.quantityText ?? null),
    },
    evidence,
    mergeDiagnostics: (row.mergeDiagnostics ?? []).map(adaptMergeDiagnostic),
    authoredCorrection: row.authoredValueCorrection === true,
    // Preserved verbatim as a LABEL. The upstream scale is uncalibrated, so it
    // is never converted into a number.
    extractionConfidenceLabel: row.confidence ?? null,
    // No calibrated numeric confidence exists upstream of this adapter.
    observedConfidence: null,

    pricingContent: classifyPricingContent({
      rate,
      unit,
      quantity,
      totalAmount,
      rateCode,
      passThrough,
      category,
    }),
  };
}

/**
 * Adapt a list of assembled rows.
 *
 * Guarantees: output length === input length, input order preserved, and no
 * row is dropped for any reason — including an unresolved category.
 */
export function adaptAssembledPricingRows(
  rows: readonly ContractPricingAssemblyRow[] | null | undefined,
  context: ContractPricingAdapterContext = {},
): readonly CanonicalContractPricingCandidate[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => adaptAssembledPricingRow(row, index, context));
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

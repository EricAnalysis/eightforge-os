/**
 * Canonical physical-page provenance for page-derived extraction artifacts.
 *
 * The operator-visible page coordinate is the 1-based physical page position in
 * the uploaded source artifact. Extraction layers (native PDF text, OCR, table
 * artifacts) each carry their own local ordering, and today that local ordering
 * is flattened into a bare `page: number` by the time pricing sees it — after
 * which an OCR page 173 and a native-text page 173 are indistinguishable.
 *
 * This module defines the smallest representation that keeps the distinction
 * auditable. It is pure: nothing here reads or writes persistence, and nothing
 * here is wired into pricing eligibility yet.
 *
 * Proof discipline: a coordinate is only `resolved_physical_page` when
 * something actually establishes the artifact-to-physical mapping. Array
 * position, ordinal inference, and "the layer counts happen to match the page
 * count" are explicitly NOT proof — a truncated layer can align for its first N
 * entries and diverge afterwards without any count revealing it.
 */

/** Extraction layer that produced a page-derived artifact. */
import type { SourceArtifact, SourceArtifactId } from '@/lib/extraction/domain/types';

export type PageSourceLayer =
  | 'pdf_page_render'
  | 'pdf_native_text'
  | 'ocr'
  | 'table_artifact'
  | 'legacy';

type ProvenPageSourceLayer = Exclude<PageSourceLayer, 'legacy'>;

/**
 * Whether the artifact's physical source page is proven.
 *
 * `legacy_unproven` is distinct from `unresolved_physical_page`: the former
 * records evidence written before provenance was captured at all, the latter
 * records evidence whose mapping was attempted and could not be established.
 * Collapsing them would lose the difference between "never proven" and
 * "cannot be proven".
 */
export type PhysicalPageMappingState =
  | 'resolved_physical_page'
  | 'unresolved_physical_page'
  | 'conflicting_physical_page_mapping'
  | 'legacy_unproven';

/** Why a resolved mapping is trusted. Never a count or an array position. */
export type PhysicalPageMappingBasis =
  | 'extractor_iterated_physical_page'
  | 'persisted_explicit_mapping'
  | 'inherited_from_proven_parent'
  | 'unproven';

const physicalPageCoordinateBrand: unique symbol = Symbol('PhysicalPageCoordinate');

type PhysicalPageCoordinateBase = Readonly<{
  readonly [physicalPageCoordinateBrand]: true;
  /** Physical document record the evidence came from. */
  sourceDocumentId: string | null;
  /**
   * Immutable source-artifact identity when one exists, binding provenance to
   * bytes rather than to a mutable document row. Never fabricated: absent
   * identity stays null.
   */
  sourceArtifactId: string | null;
  sourceLayer: PageSourceLayer;
  /** The layer's own ordinal. Deliberately separate from the physical page. */
  artifactLocalIndex: number | null;
}>;

type ResolvedPhysicalPageCoordinate = PhysicalPageCoordinateBase & Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: SourceArtifactId;
  physicalPageNumber: number;
  sourceLayer: ProvenPageSourceLayer;
  mappingState: 'resolved_physical_page';
  mappingBasis: Exclude<PhysicalPageMappingBasis, 'unproven'>;
  legacyPageValue: null;
  totalPhysicalPages: number;
}>;

type UnprovenPhysicalPageCoordinate = PhysicalPageCoordinateBase & Readonly<{
  physicalPageNumber: null;
  mappingState: Exclude<PhysicalPageMappingState, 'resolved_physical_page'>;
  mappingBasis: 'unproven';
  /** Compatibility-only bare legacy page label; never a layer ordinal. */
  legacyPageValue: number | null;
  totalPhysicalPages: number | null;
}>;

export type PhysicalPageCoordinate =
  | ResolvedPhysicalPageCoordinate
  | UnprovenPhysicalPageCoordinate;

export type PhysicalPageCoordinateRehydrationContext = Readonly<{
  /** Owning persisted row bindings. These are evidence, not defaults for a resolved claim. */
  sourceDocumentId: string;
  sourceArtifactId: string;
  page: number;
  /** True for artifact schemas whose rows must carry a coordinate. */
  requiresProvenance: boolean;
  /** Layer independently known by the caller, when available. */
  expectedSourceLayer?: PageSourceLayer;
  /** Fail-closed layer used only for a rejected/unavailable coordinate. */
  fallbackSourceLayer: PageSourceLayer;
  artifactLocalIndex?: number | null;
}>;

export type PhysicalPageCoordinateRehydrationRejection =
  | 'missing_required_coordinate'
  | 'malformed_coordinate'
  | 'unknown_mapping_state'
  | 'unknown_mapping_basis'
  | 'unknown_source_layer'
  | 'missing_required_field'
  | 'invalid_integer'
  | 'page_out_of_bounds'
  | 'document_mismatch'
  | 'artifact_mismatch'
  | 'page_mismatch'
  | 'artifact_local_index_mismatch'
  | 'source_layer_mismatch'
  | 'invalid_resolved_claim'
  | 'invalid_unproven_claim';

export type RehydratePhysicalPageCoordinateResult =
  | Readonly<{
      status: 'rehydrated';
      coordinate: PhysicalPageCoordinate;
    }>
  | Readonly<{
      status: 'historical_absence';
      coordinate: PhysicalPageCoordinate;
    }>
  | Readonly<{
      status: 'rejected';
      reason: PhysicalPageCoordinateRehydrationRejection;
      coordinate: PhysicalPageCoordinate;
    }>;

type BoundSourceArtifact = Pick<SourceArtifact, 'id' | 'source_document_id'>;

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeLocalIndex(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const MAPPING_STATES: readonly PhysicalPageMappingState[] = [
  'resolved_physical_page',
  'unresolved_physical_page',
  'conflicting_physical_page_mapping',
  'legacy_unproven',
];

const MAPPING_BASES: readonly PhysicalPageMappingBasis[] = [
  'extractor_iterated_physical_page',
  'persisted_explicit_mapping',
  'inherited_from_proven_parent',
  'unproven',
];

const SOURCE_LAYERS: readonly PageSourceLayer[] = [
  'pdf_page_render',
  'pdf_native_text',
  'ocr',
  'table_artifact',
  'legacy',
];

function rejectedCoordinate(
  context: PhysicalPageCoordinateRehydrationContext,
): PhysicalPageCoordinate {
  if (context.fallbackSourceLayer === 'legacy') {
    return legacyPageCoordinate({
      sourceDocumentId: context.sourceDocumentId,
      sourceArtifactId: context.sourceArtifactId,
      legacyPageValue: context.page,
    });
  }
  return unresolvedPhysicalPageCoordinate({
    sourceDocumentId: context.sourceDocumentId,
    sourceArtifactId: context.sourceArtifactId,
    sourceLayer: context.fallbackSourceLayer,
    artifactLocalIndex: context.artifactLocalIndex,
  });
}

function rejectedRehydration(
  context: PhysicalPageCoordinateRehydrationContext,
  reason: PhysicalPageCoordinateRehydrationRejection,
): RehydratePhysicalPageCoordinateResult {
  return Object.freeze({
    status: 'rejected' as const,
    reason,
    coordinate: rejectedCoordinate(context),
  });
}

function rehydratedResolvedCoordinate(params: {
  sourceDocumentId: string;
  sourceArtifactId: SourceArtifactId;
  physicalPageNumber: number;
  totalPhysicalPages: number;
  sourceLayer: ProvenPageSourceLayer;
  artifactLocalIndex: number | null;
  mappingBasis: Exclude<PhysicalPageMappingBasis, 'unproven'>;
}): PhysicalPageCoordinate {
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId: params.sourceDocumentId,
    sourceArtifactId: params.sourceArtifactId,
    physicalPageNumber: params.physicalPageNumber,
    sourceLayer: params.sourceLayer,
    artifactLocalIndex: params.artifactLocalIndex,
    mappingState: 'resolved_physical_page' as const,
    mappingBasis: params.mappingBasis,
    legacyPageValue: null,
    totalPhysicalPages: params.totalPhysicalPages,
  }) as PhysicalPageCoordinate;
}

/**
 * Coordinate for an artifact produced by an extractor that iterated real
 * physical pages and recorded the physical index it was reading.
 *
 * This is the only constructor that mints `extractor_iterated_physical_page`,
 * so callers cannot claim that basis without going through a physical page
 * number. A non-positive or non-integer page is treated as unresolved rather
 * than coerced.
 */
export function physicalPageFromExtractorIteration(params: {
  readonly sourceArtifact: BoundSourceArtifact;
  readonly physicalPageNumber: number;
  readonly totalPhysicalPages: number;
  readonly sourceLayer: ProvenPageSourceLayer;
  readonly artifactLocalIndex?: number | null;
}): PhysicalPageCoordinate {
  const sourceDocumentId = normalizeId(params.sourceArtifact.source_document_id);
  const sourceArtifactId = normalizeId(params.sourceArtifact.id) as SourceArtifactId | null;
  const totalPhysicalPages = resolveTotalPhysicalPages(params.totalPhysicalPages);
  const resolved = sourceDocumentId != null
    && sourceArtifactId != null
    && totalPhysicalPages != null
    && isPositiveInteger(params.physicalPageNumber)
    && params.physicalPageNumber <= totalPhysicalPages;
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId,
    sourceArtifactId,
    physicalPageNumber: resolved ? params.physicalPageNumber : null,
    sourceLayer: params.sourceLayer,
    artifactLocalIndex: normalizeLocalIndex(params.artifactLocalIndex),
    mappingState: resolved ? 'resolved_physical_page' : 'unresolved_physical_page',
    mappingBasis: resolved ? 'extractor_iterated_physical_page' : 'unproven',
    legacyPageValue: null,
    totalPhysicalPages,
  }) as PhysicalPageCoordinate;
}

/**
 * Coordinate for an artifact whose physical page comes from an explicitly
 * persisted mapping rather than from the extractor's own iteration.
 */
export function physicalPageFromPersistedMapping(params: {
  readonly sourceArtifact: BoundSourceArtifact;
  readonly physicalPageNumber: number;
  readonly totalPhysicalPages: number;
  readonly sourceLayer: ProvenPageSourceLayer;
  readonly artifactLocalIndex?: number | null;
}): PhysicalPageCoordinate {
  const sourceDocumentId = normalizeId(params.sourceArtifact.source_document_id);
  const sourceArtifactId = normalizeId(params.sourceArtifact.id) as SourceArtifactId | null;
  const totalPhysicalPages = resolveTotalPhysicalPages(params.totalPhysicalPages);
  const resolved = sourceDocumentId != null
    && sourceArtifactId != null
    && totalPhysicalPages != null
    && isPositiveInteger(params.physicalPageNumber)
    && params.physicalPageNumber <= totalPhysicalPages;
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId,
    sourceArtifactId,
    physicalPageNumber: resolved ? params.physicalPageNumber : null,
    sourceLayer: params.sourceLayer,
    artifactLocalIndex: normalizeLocalIndex(params.artifactLocalIndex),
    mappingState: resolved ? 'resolved_physical_page' : 'unresolved_physical_page',
    mappingBasis: resolved ? 'persisted_explicit_mapping' : 'unproven',
    legacyPageValue: null,
    totalPhysicalPages,
  }) as PhysicalPageCoordinate;
}

/**
 * Coordinate for pre-provenance evidence that carries only a bare page integer.
 *
 * The integer is retained so existing surfaces keep displaying what they always
 * displayed, but the state is `legacy_unproven` and the page is NOT promoted to
 * `physicalPageNumber` — nothing about a bare integer establishes which layer
 * produced it or which physical page it denotes.
 */
export function legacyPageCoordinate(params: {
  readonly sourceDocumentId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly legacyPageValue?: number | null;
}): PhysicalPageCoordinate {
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId: normalizeId(params.sourceDocumentId),
    sourceArtifactId: normalizeId(params.sourceArtifactId),
    physicalPageNumber: null,
    sourceLayer: 'legacy',
    artifactLocalIndex: null,
    mappingState: 'legacy_unproven',
    mappingBasis: 'unproven',
    legacyPageValue: isPositiveInteger(params.legacyPageValue)
      ? params.legacyPageValue
      : null,
    totalPhysicalPages: null,
  }) as PhysicalPageCoordinate;
}

/** Newly attempted mapping that could not be proven; distinct from legacy evidence. */
export function unresolvedPhysicalPageCoordinate(params: {
  readonly sourceDocumentId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceLayer: ProvenPageSourceLayer;
  readonly artifactLocalIndex?: number | null;
}): PhysicalPageCoordinate {
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId: normalizeId(params.sourceDocumentId),
    sourceArtifactId: normalizeId(params.sourceArtifactId),
    physicalPageNumber: null,
    sourceLayer: params.sourceLayer,
    artifactLocalIndex: normalizeLocalIndex(params.artifactLocalIndex),
    mappingState: 'unresolved_physical_page',
    mappingBasis: 'unproven',
    legacyPageValue: null,
    totalPhysicalPages: null,
  }) as PhysicalPageCoordinate;
}

/**
 * Coordinate for a derived artifact (fragment, cell, row, chain, candidate)
 * that inherits its physical page from an already-proven parent.
 *
 * Inheritance only carries proof forward from a resolved parent; an unproven or
 * conflicting parent yields an unproven child rather than laundering the
 * parent's uncertainty into a resolved state.
 */
export function inheritPhysicalPageCoordinate(
  parent: PhysicalPageCoordinate,
  child: {
    readonly sourceLayer: ProvenPageSourceLayer;
    readonly artifactLocalIndex?: number | null;
  },
): PhysicalPageCoordinate {
  const parentMappingState = (parent as { mappingState: PhysicalPageMappingState }).mappingState;
  const inheritable = isResolvedPhysicalPage(parent);
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId: parent.sourceDocumentId,
    sourceArtifactId: parent.sourceArtifactId,
    physicalPageNumber: inheritable ? parent.physicalPageNumber : null,
    sourceLayer: child.sourceLayer,
    artifactLocalIndex: normalizeLocalIndex(child.artifactLocalIndex),
    // `sourceLayer` describes the artifact carrying this coordinate, and a
    // derived child is never the `legacy` layer. `legacy_unproven` therefore
    // cannot be inherited verbatim: it would assert legacy provenance for a
    // non-legacy artifact, and the persisted CHECK constraint rejects that
    // pairing outright. The child's mapping was attempted via inheritance and
    // could not be established, which is exactly `unresolved_physical_page`.
    // The parent retains its own `legacy_unproven` record, so nothing is lost.
    mappingState: inheritable
      ? 'resolved_physical_page'
      : parentMappingState === 'conflicting_physical_page_mapping'
        ? 'conflicting_physical_page_mapping'
        : 'unresolved_physical_page',
    mappingBasis: inheritable ? 'inherited_from_proven_parent' : 'unproven',
    // A bare legacy page integer belongs to the parent's layer. Carrying it
    // onto a child of a different layer is the ordinal laundering this module
    // exists to prevent.
    legacyPageValue: null,
    totalPhysicalPages: inheritable ? parent.totalPhysicalPages : null,
  }) as PhysicalPageCoordinate;
}

function unanimousParentIdentity(parents: readonly PhysicalPageCoordinate[]): Readonly<{
  sourceDocumentId: string | null;
  sourceArtifactId: string | null;
}> {
  const first = parents[0];
  if (!first) return { sourceDocumentId: null, sourceArtifactId: null };
  const sourceDocumentId = normalizeId(first.sourceDocumentId);
  const sourceArtifactId = normalizeId(first.sourceArtifactId);
  const unanimous = parents.every((parent) =>
    normalizeId(parent.sourceDocumentId) === sourceDocumentId
    && normalizeId(parent.sourceArtifactId) === sourceArtifactId);
  return unanimous
    ? { sourceDocumentId, sourceArtifactId }
    : { sourceDocumentId: null, sourceArtifactId: null };
}

/** Inherits only when every required parent proves the same artifact page. */
export function inheritPhysicalPageCoordinates(
  parents: readonly PhysicalPageCoordinate[],
  child: {
    readonly sourceLayer: ProvenPageSourceLayer;
    readonly artifactLocalIndex?: number | null;
  },
): PhysicalPageCoordinate {
  const first = parents[0];
  if (!first) {
    return unresolvedPhysicalPageCoordinate({
      sourceLayer: child.sourceLayer,
      artifactLocalIndex: child.artifactLocalIndex,
    });
  }
  const identity = unanimousParentIdentity(parents);
  if (parents.some((parent) =>
    parent.mappingState === 'conflicting_physical_page_mapping')) {
    return conflictingPhysicalPageCoordinate({
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceLayer: child.sourceLayer,
      artifactLocalIndex: child.artifactLocalIndex,
    });
  }
  if (!parents.every(isResolvedPhysicalPage)) {
    return unresolvedPhysicalPageCoordinate({
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceLayer: child.sourceLayer,
      artifactLocalIndex: child.artifactLocalIndex,
    });
  }
  const agrees = parents.every((parent) =>
    parent.sourceDocumentId === first.sourceDocumentId
    && parent.sourceArtifactId === first.sourceArtifactId
    && parent.physicalPageNumber === first.physicalPageNumber
    && parent.totalPhysicalPages === first.totalPhysicalPages);
  return agrees
    ? inheritPhysicalPageCoordinate(first, child)
    : conflictingPhysicalPageCoordinate({
        sourceDocumentId: identity.sourceDocumentId,
        sourceArtifactId: identity.sourceArtifactId,
        sourceLayer: child.sourceLayer,
        artifactLocalIndex: child.artifactLocalIndex,
      });
}

/**
 * Coordinate for an artifact whose layers disagree about the physical page.
 * The page is withheld rather than arbitrated here — precedence between
 * disagreeing layers is a semantic-authority question, not a provenance one.
 */
export function conflictingPhysicalPageCoordinate(params: {
  readonly sourceDocumentId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceLayer: PageSourceLayer;
  readonly artifactLocalIndex?: number | null;
}): PhysicalPageCoordinate {
  return Object.freeze({
    [physicalPageCoordinateBrand]: true as const,
    sourceDocumentId: normalizeId(params.sourceDocumentId),
    sourceArtifactId: normalizeId(params.sourceArtifactId),
    physicalPageNumber: null,
    sourceLayer: params.sourceLayer,
    artifactLocalIndex: normalizeLocalIndex(params.artifactLocalIndex),
    mappingState: 'conflicting_physical_page_mapping',
    mappingBasis: 'unproven',
    legacyPageValue: null,
    totalPhysicalPages: null,
  }) as PhysicalPageCoordinate;
}

/**
 * Validates a persisted JSON coordinate against its owning row before restoring
 * the private runtime proof brand. Invalid persistence is returned explicitly
 * with a fail-closed, non-resolved coordinate; it is never trusted by shape.
 */
export function rehydratePhysicalPageCoordinate(
  raw: unknown,
  context: PhysicalPageCoordinateRehydrationContext,
): RehydratePhysicalPageCoordinateResult {
  const expectedDocumentId = normalizeId(context.sourceDocumentId);
  const expectedArtifactId = normalizeId(context.sourceArtifactId);
  if (
    expectedDocumentId == null
    || expectedArtifactId == null
    || !isPositiveInteger(context.page)
    || normalizeLocalIndex(context.artifactLocalIndex) !== (context.artifactLocalIndex ?? null)
  ) {
    return rejectedRehydration(context, 'malformed_coordinate');
  }

  if (raw == null) {
    if (context.requiresProvenance) {
      return rejectedRehydration(context, 'missing_required_coordinate');
    }
    return Object.freeze({
      status: 'historical_absence' as const,
      coordinate: legacyPageCoordinate({
        sourceDocumentId: expectedDocumentId,
        sourceArtifactId: expectedArtifactId,
        legacyPageValue: context.page,
      }),
    });
  }
  if (!isRecord(raw)) return rejectedRehydration(context, 'malformed_coordinate');

  const requiredFields = [
    'mappingState',
    'mappingBasis',
    'sourceDocumentId',
    'sourceArtifactId',
    'physicalPageNumber',
    'totalPhysicalPages',
    'sourceLayer',
    'artifactLocalIndex',
    'legacyPageValue',
  ] as const;
  if (requiredFields.some((field) => !hasOwn(raw, field))) {
    return rejectedRehydration(context, 'missing_required_field');
  }

  if (!MAPPING_STATES.includes(raw.mappingState as PhysicalPageMappingState)) {
    return rejectedRehydration(context, 'unknown_mapping_state');
  }
  if (!MAPPING_BASES.includes(raw.mappingBasis as PhysicalPageMappingBasis)) {
    return rejectedRehydration(context, 'unknown_mapping_basis');
  }
  if (!SOURCE_LAYERS.includes(raw.sourceLayer as PageSourceLayer)) {
    return rejectedRehydration(context, 'unknown_source_layer');
  }

  const mappingState = raw.mappingState as PhysicalPageMappingState;
  const mappingBasis = raw.mappingBasis as PhysicalPageMappingBasis;
  const sourceLayer = raw.sourceLayer as PageSourceLayer;
  if (context.expectedSourceLayer != null && sourceLayer !== context.expectedSourceLayer) {
    return rejectedRehydration(context, 'source_layer_mismatch');
  }

  const sourceDocumentId = raw.sourceDocumentId == null
    ? null
    : normalizeId(typeof raw.sourceDocumentId === 'string' ? raw.sourceDocumentId : null);
  const sourceArtifactId = raw.sourceArtifactId == null
    ? null
    : normalizeId(typeof raw.sourceArtifactId === 'string' ? raw.sourceArtifactId : null);
  if (raw.sourceDocumentId != null && sourceDocumentId == null) {
    return rejectedRehydration(context, 'malformed_coordinate');
  }
  if (raw.sourceArtifactId != null && sourceArtifactId == null) {
    return rejectedRehydration(context, 'malformed_coordinate');
  }
  if (sourceDocumentId != null && sourceDocumentId !== expectedDocumentId) {
    return rejectedRehydration(context, 'document_mismatch');
  }
  if (sourceArtifactId != null && sourceArtifactId !== expectedArtifactId) {
    return rejectedRehydration(context, 'artifact_mismatch');
  }

  const artifactLocalIndex = raw.artifactLocalIndex;
  if (artifactLocalIndex !== null
      && (typeof artifactLocalIndex !== 'number'
        || !Number.isSafeInteger(artifactLocalIndex)
        || artifactLocalIndex < 0)) {
    return rejectedRehydration(context, 'invalid_integer');
  }
  if (
    context.artifactLocalIndex !== undefined
    && artifactLocalIndex !== context.artifactLocalIndex
  ) {
    return rejectedRehydration(context, 'artifact_local_index_mismatch');
  }

  if (mappingState === 'resolved_physical_page') {
    if (
      mappingBasis === 'unproven'
      || sourceLayer === 'legacy'
      || sourceDocumentId == null
      || sourceArtifactId == null
      || raw.legacyPageValue !== null
    ) {
      return rejectedRehydration(context, 'invalid_resolved_claim');
    }
    if (!isPositiveInteger(raw.physicalPageNumber) || !isPositiveInteger(raw.totalPhysicalPages)) {
      return rejectedRehydration(context, 'invalid_integer');
    }
    if (raw.physicalPageNumber > raw.totalPhysicalPages) {
      return rejectedRehydration(context, 'page_out_of_bounds');
    }
    if (raw.physicalPageNumber !== context.page) {
      return rejectedRehydration(context, 'page_mismatch');
    }
    return Object.freeze({
      status: 'rehydrated' as const,
      coordinate: rehydratedResolvedCoordinate({
        sourceDocumentId,
        sourceArtifactId: sourceArtifactId as SourceArtifactId,
        physicalPageNumber: raw.physicalPageNumber,
        totalPhysicalPages: raw.totalPhysicalPages,
        sourceLayer: sourceLayer as ProvenPageSourceLayer,
        artifactLocalIndex,
        mappingBasis: mappingBasis as Exclude<PhysicalPageMappingBasis, 'unproven'>,
      }),
    });
  }

  if (
    mappingBasis !== 'unproven'
    || raw.physicalPageNumber !== null
    || raw.totalPhysicalPages !== null
  ) {
    return rejectedRehydration(context, 'invalid_unproven_claim');
  }
  if (mappingState === 'legacy_unproven') {
    if (
      sourceLayer !== 'legacy'
      || artifactLocalIndex !== null
      || (raw.legacyPageValue !== null && !isPositiveInteger(raw.legacyPageValue))
    ) {
      return rejectedRehydration(context, 'invalid_unproven_claim');
    }
    return Object.freeze({
      status: 'rehydrated' as const,
      coordinate: legacyPageCoordinate({
        sourceDocumentId,
        sourceArtifactId,
        legacyPageValue: raw.legacyPageValue as number | null,
      }),
    });
  }
  if (sourceLayer === 'legacy' || raw.legacyPageValue !== null) {
    return rejectedRehydration(context, 'invalid_unproven_claim');
  }
  const coordinate = mappingState === 'conflicting_physical_page_mapping'
    ? conflictingPhysicalPageCoordinate({
        sourceDocumentId,
        sourceArtifactId,
        sourceLayer,
        artifactLocalIndex,
      })
    : unresolvedPhysicalPageCoordinate({
        sourceDocumentId,
        sourceArtifactId,
        sourceLayer: sourceLayer as ProvenPageSourceLayer,
        artifactLocalIndex,
      });
  return Object.freeze({ status: 'rehydrated' as const, coordinate });
}

/** True only for coordinates that prove a physical page. */
export function isResolvedPhysicalPage(
  coordinate: PhysicalPageCoordinate,
): coordinate is ResolvedPhysicalPageCoordinate {
  const candidate = coordinate as PhysicalPageCoordinateBase & {
    readonly [physicalPageCoordinateBrand]?: unknown;
    readonly physicalPageNumber: number | null;
    readonly mappingState: PhysicalPageMappingState;
    readonly mappingBasis: PhysicalPageMappingBasis;
  };
  return candidate[physicalPageCoordinateBrand] === true
    && candidate.mappingState === 'resolved_physical_page'
    && candidate.mappingBasis !== 'unproven'
    && candidate.sourceLayer !== 'legacy'
    && normalizeId(candidate.sourceDocumentId) != null
    && normalizeId(candidate.sourceArtifactId) != null
    && isPositiveInteger(candidate.physicalPageNumber)
    && isPositiveInteger((candidate as ResolvedPhysicalPageCoordinate).totalPhysicalPages)
    && candidate.physicalPageNumber
      <= (candidate as ResolvedPhysicalPageCoordinate).totalPhysicalPages
    && (
      candidate.artifactLocalIndex == null
      || (Number.isSafeInteger(candidate.artifactLocalIndex) && candidate.artifactLocalIndex >= 0)
    );
}

/**
 * Total physical page count for an uploaded artifact.
 *
 * Must come from the artifact's own parser output (pdf.js `numPages`, persisted
 * as `page_count`). Layer entry counts are rejected as a source: a truncated
 * native-text layer under-reports, and an OCR layer matching the true count is
 * a coincidence rather than a proof.
 */
export function resolveTotalPhysicalPages(
  artifactPageCount: number | null | undefined,
): number | null {
  return isPositiveInteger(artifactPageCount) ? artifactPageCount : null;
}

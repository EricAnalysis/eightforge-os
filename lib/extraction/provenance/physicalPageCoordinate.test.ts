import { describe, expect, it } from 'vitest';

import {
  conflictingPhysicalPageCoordinate,
  inheritPhysicalPageCoordinate,
  inheritPhysicalPageCoordinates,
  isResolvedPhysicalPage,
  legacyPageCoordinate,
  physicalPageFromExtractorIteration,
  physicalPageFromPersistedMapping,
  rehydratePhysicalPageCoordinate,
  resolveTotalPhysicalPages,
  unresolvedPhysicalPageCoordinate,
} from './physicalPageCoordinate';
import type { SourceArtifactId } from '@/lib/extraction/domain/types';

const SOURCE_ARTIFACT = Object.freeze({
  id: 'artifact-1' as SourceArtifactId,
  source_document_id: 'doc-1',
});

const REHYDRATION_CONTEXT = Object.freeze({
  sourceDocumentId: SOURCE_ARTIFACT.source_document_id,
  sourceArtifactId: SOURCE_ARTIFACT.id,
  page: 4,
  requiresProvenance: true,
  expectedSourceLayer: 'ocr' as const,
  fallbackSourceLayer: 'ocr' as const,
  artifactLocalIndex: 3,
});

describe('physical page provenance', () => {
  it('never launders mixed parent proof regardless of ordering', () => {
    const resolved = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
    });
    const unproven = unresolvedPhysicalPageCoordinate({
      sourceDocumentId: 'doc-1',
      sourceArtifactId: SOURCE_ARTIFACT.id,
      sourceLayer: 'ocr',
    });
    for (const parents of [[resolved, unproven], [unproven, resolved]]) {
      expect(inheritPhysicalPageCoordinates(parents, { sourceLayer: 'table_artifact' }))
        .toMatchObject({
          mappingState: 'unresolved_physical_page',
          physicalPageNumber: null,
        });
    }
  });

  it('removes ambiguous multi-parent identity independent of parent ordering', () => {
    const first = unresolvedPhysicalPageCoordinate({
      sourceDocumentId: 'doc-a',
      sourceArtifactId: 'artifact-a',
      sourceLayer: 'ocr',
    });
    const second = unresolvedPhysicalPageCoordinate({
      sourceDocumentId: 'doc-b',
      sourceArtifactId: 'artifact-b',
      sourceLayer: 'pdf_native_text',
    });
    const forward = inheritPhysicalPageCoordinates([first, second], {
      sourceLayer: 'table_artifact',
    });
    const reverse = inheritPhysicalPageCoordinates([second, first], {
      sourceLayer: 'table_artifact',
    });
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      sourceDocumentId: null,
      sourceArtifactId: null,
      mappingState: 'unresolved_physical_page',
    });
  });

  it('retains only a unanimous multi-parent identity', () => {
    const parents = [
      unresolvedPhysicalPageCoordinate({
        sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', sourceLayer: 'ocr',
      }),
      conflictingPhysicalPageCoordinate({
        sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', sourceLayer: 'pdf_native_text',
      }),
    ];
    expect(inheritPhysicalPageCoordinates(parents, { sourceLayer: 'table_artifact' }))
      .toMatchObject({
        sourceDocumentId: 'doc-1',
        sourceArtifactId: 'artifact-1',
        mappingState: 'conflicting_physical_page_mapping',
      });
    const partiallyBound = unresolvedPhysicalPageCoordinate({
      sourceDocumentId: 'doc-1', sourceArtifactId: null, sourceLayer: 'ocr',
    });
    const bound = unresolvedPhysicalPageCoordinate({
      sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', sourceLayer: 'ocr',
    });
    expect(inheritPhysicalPageCoordinates([partiallyBound, bound], {
      sourceLayer: 'table_artifact',
    })).toMatchObject({ sourceDocumentId: null, sourceArtifactId: null });
  });

  it('makes conflicting resolved-parent attribution permutation invariant', () => {
    const first = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
    });
    const second = physicalPageFromExtractorIteration({
      sourceArtifact: {
        id: 'artifact-2' as SourceArtifactId,
        source_document_id: 'doc-2',
      },
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'pdf_native_text',
    });
    const forward = inheritPhysicalPageCoordinates([first, second], {
      sourceLayer: 'table_artifact',
    });
    const reverse = inheritPhysicalPageCoordinates([second, first], {
      sourceLayer: 'table_artifact',
    });
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      sourceDocumentId: null,
      sourceArtifactId: null,
      mappingState: 'conflicting_physical_page_mapping',
    });
  });

  it('rehydrates valid persisted proof only after contextual validation', () => {
    const original = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
      artifactLocalIndex: 3,
    });
    const raw = JSON.parse(JSON.stringify(original)) as unknown;
    expect(isResolvedPhysicalPage(raw as Parameters<typeof isResolvedPhysicalPage>[0])).toBe(false);
    const result = rehydratePhysicalPageCoordinate(raw, REHYDRATION_CONTEXT);
    expect(result.status).toBe('rehydrated');
    expect(isResolvedPhysicalPage(result.coordinate)).toBe(true);
    expect(result.coordinate).toMatchObject({
      mappingBasis: 'extractor_iterated_physical_page',
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
    });
  });

  it('rejects forged, malformed, and unknown persisted coordinate claims', () => {
    const valid = JSON.parse(JSON.stringify(physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
      artifactLocalIndex: 3,
    }))) as Record<string, unknown>;
    const cases: Array<[unknown, string]> = [
      ['not-an-object', 'malformed_coordinate'],
      [{}, 'missing_required_field'],
      [{ ...valid, mappingState: 'invented' }, 'unknown_mapping_state'],
      [{ ...valid, mappingBasis: 'invented' }, 'unknown_mapping_basis'],
      [{ ...valid, sourceLayer: 'invented' }, 'unknown_source_layer'],
      [{ ...valid, mappingBasis: 'unproven' }, 'invalid_resolved_claim'],
      [{ ...valid, sourceLayer: 'legacy' }, 'source_layer_mismatch'],
    ];
    for (const [raw, reason] of cases) {
      const result = rehydratePhysicalPageCoordinate(raw, REHYDRATION_CONTEXT);
      expect(result).toMatchObject({ status: 'rejected', reason });
      expect(isResolvedPhysicalPage(result.coordinate)).toBe(false);
    }
  });

  it('rejects unsafe, out-of-bounds, and context-mismatched persisted proof', () => {
    const valid = JSON.parse(JSON.stringify(physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
      artifactLocalIndex: 3,
    }))) as Record<string, unknown>;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...valid, sourceDocumentId: 'other-doc' }, 'document_mismatch'],
      [{ ...valid, sourceArtifactId: 'other-artifact' }, 'artifact_mismatch'],
      [{ ...valid, physicalPageNumber: 5 }, 'page_mismatch'],
      [{ ...valid, physicalPageNumber: 9 }, 'page_out_of_bounds'],
      [{ ...valid, physicalPageNumber: 0 }, 'invalid_integer'],
      [{ ...valid, physicalPageNumber: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_integer'],
      [{ ...valid, totalPhysicalPages: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_integer'],
      [{ ...valid, artifactLocalIndex: -1 }, 'invalid_integer'],
      [{ ...valid, artifactLocalIndex: 2 }, 'artifact_local_index_mismatch'],
    ];
    for (const [raw, reason] of cases) {
      expect(rehydratePhysicalPageCoordinate(raw, REHYDRATION_CONTEXT))
        .toMatchObject({ status: 'rejected', reason });
    }
  });

  it('rehydrates unproven states without restoring resolved proof', () => {
    const coordinates = [
      unresolvedPhysicalPageCoordinate({
        sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', sourceLayer: 'ocr',
      }),
      conflictingPhysicalPageCoordinate({
        sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1', sourceLayer: 'ocr',
      }),
    ];
    for (const coordinate of coordinates) {
      const result = rehydratePhysicalPageCoordinate(
        JSON.parse(JSON.stringify(coordinate)),
        {
          ...REHYDRATION_CONTEXT,
          expectedSourceLayer: 'ocr',
          artifactLocalIndex: undefined,
        },
      );
      expect(result.status).toBe('rehydrated');
      expect(result.coordinate.mappingState).toBe(coordinate.mappingState);
      expect(isResolvedPhysicalPage(result.coordinate)).toBe(false);
    }
  });

  it('distinguishes historical absence from missing required provenance', () => {
    const historical = rehydratePhysicalPageCoordinate(null, {
      ...REHYDRATION_CONTEXT,
      requiresProvenance: false,
      fallbackSourceLayer: 'legacy',
      expectedSourceLayer: undefined,
    });
    expect(historical).toMatchObject({
      status: 'historical_absence',
      coordinate: { mappingState: 'legacy_unproven', legacyPageValue: 4 },
    });
    expect(rehydratePhysicalPageCoordinate(null, REHYDRATION_CONTEXT)).toMatchObject({
      status: 'rejected',
      reason: 'missing_required_coordinate',
      coordinate: { mappingState: 'unresolved_physical_page' },
    });
  });

  it('treats divergent parser totals as conflicting parent proof', () => {
    const first = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 8,
      sourceLayer: 'ocr',
    });
    const second = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 4,
      totalPhysicalPages: 9,
      sourceLayer: 'pdf_native_text',
    });
    expect(inheritPhysicalPageCoordinates([first, second], {
      sourceLayer: 'table_artifact',
    })).toMatchObject({
      mappingState: 'conflicting_physical_page_mapping',
      physicalPageNumber: null,
    });
  });
  it('records a native-text page proven by extractor iteration', () => {
    const coordinate = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 39,
      totalPhysicalPages: 50,
      sourceLayer: 'pdf_native_text',
      artifactLocalIndex: 38,
    });
    expect(coordinate.mappingState).toBe('resolved_physical_page');
    expect(coordinate.mappingBasis).toBe('extractor_iterated_physical_page');
    expect(coordinate.physicalPageNumber).toBe(39);
    expect(isResolvedPhysicalPage(coordinate)).toBe(true);
  });

  it('records an OCR page as proven when the extractor iterated physical pages', () => {
    const coordinate = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 214,
      totalPhysicalPages: 238,
      sourceLayer: 'ocr',
      artifactLocalIndex: 213,
    });
    // Absence of a native text layer must not invalidate the physical page.
    expect(coordinate.sourceLayer).toBe('ocr');
    expect(isResolvedPhysicalPage(coordinate)).toBe(true);
    expect(coordinate.physicalPageNumber).toBe(214);
  });

  it('keeps artifact-local index distinct from the physical page number', () => {
    const coordinate = physicalPageFromExtractorIteration({
      physicalPageNumber: 173,
      sourceArtifact: SOURCE_ARTIFACT,
      totalPhysicalPages: 238,
      sourceLayer: 'ocr',
      artifactLocalIndex: 0,
    });
    expect(coordinate.physicalPageNumber).toBe(173);
    expect(coordinate.artifactLocalIndex).toBe(0);
    expect(coordinate.physicalPageNumber).not.toBe(coordinate.artifactLocalIndex);
  });

  it('treats a non-positive or non-integer page as unresolved rather than coercing it', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const coordinate = physicalPageFromExtractorIteration({
        physicalPageNumber: bad,
        sourceArtifact: SOURCE_ARTIFACT,
        totalPhysicalPages: 10,
        sourceLayer: 'pdf_native_text',
      });
      expect(coordinate.mappingState).toBe('unresolved_physical_page');
      expect(coordinate.mappingBasis).toBe('unproven');
      expect(coordinate.physicalPageNumber).toBeNull();
      expect(isResolvedPhysicalPage(coordinate)).toBe(false);
    }
  });

  it('distinguishes a persisted explicit mapping from extractor iteration', () => {
    const coordinate = physicalPageFromPersistedMapping({
      physicalPageNumber: 12,
      sourceArtifact: SOURCE_ARTIFACT,
      totalPhysicalPages: 20,
      sourceLayer: 'table_artifact',
    });
    expect(coordinate.mappingBasis).toBe('persisted_explicit_mapping');
    expect(isResolvedPhysicalPage(coordinate)).toBe(true);
  });

  it('marks bare legacy page evidence unproven and refuses to promote the integer', () => {
    const coordinate = legacyPageCoordinate({
      sourceDocumentId: 'doc-legacy',
      legacyPageValue: 173,
    });
    expect(coordinate.mappingState).toBe('legacy_unproven');
    expect(coordinate.mappingBasis).toBe('unproven');
    // The integer is retained for compatibility surfaces but is NOT a physical page.
    expect(coordinate.physicalPageNumber).toBeNull();
    expect(coordinate.artifactLocalIndex).toBeNull();
    expect(coordinate.legacyPageValue).toBe(173);
    expect(isResolvedPhysicalPage(coordinate)).toBe(false);
  });

  it('fails closed when a bound artifact has no document identity', () => {
    const coordinate = physicalPageFromExtractorIteration({
      sourceArtifact: {
        id: 'artifact-1' as SourceArtifactId,
        source_document_id: '   ',
      },
      physicalPageNumber: 5,
      totalPhysicalPages: 10,
      sourceLayer: 'ocr',
    });
    expect(isResolvedPhysicalPage(coordinate)).toBe(false);
    expect(coordinate.sourceDocumentId).toBeNull();
  });

  it('preserves bound source artifact identity', () => {
    expect(physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 1,
      totalPhysicalPages: 1,
      sourceLayer: 'ocr',
    }).sourceArtifactId).toBe('artifact-1');
  });

  it('rejects out-of-bounds and unsafe page claims', () => {
    for (const physicalPageNumber of [11, Number.MAX_SAFE_INTEGER + 1]) {
      const coordinate = physicalPageFromExtractorIteration({
        sourceArtifact: SOURCE_ARTIFACT,
        physicalPageNumber,
        totalPhysicalPages: 10,
        sourceLayer: 'ocr',
      });
      expect(isResolvedPhysicalPage(coordinate)).toBe(false);
      expect(coordinate.physicalPageNumber).toBeNull();
    }
  });

  it('does not accept or inherit a structurally forged resolved coordinate', () => {
    const forged = {
      sourceDocumentId: 'doc-1',
      sourceArtifactId: 'artifact-1',
      physicalPageNumber: 5,
      sourceLayer: 'ocr',
      artifactLocalIndex: 4,
      mappingState: 'resolved_physical_page',
      mappingBasis: 'unproven',
      legacyPageValue: null,
    } as unknown as Parameters<typeof inheritPhysicalPageCoordinate>[0];
    expect(isResolvedPhysicalPage(forged)).toBe(false);
    const child = inheritPhysicalPageCoordinate(forged, { sourceLayer: 'table_artifact' });
    expect(isResolvedPhysicalPage(child)).toBe(false);
  });

  it('inherits proof from a resolved parent', () => {
    const parent = physicalPageFromExtractorIteration({
      sourceArtifact: SOURCE_ARTIFACT,
      physicalPageNumber: 41,
      totalPhysicalPages: 50,
      sourceLayer: 'ocr',
    });
    const child = inheritPhysicalPageCoordinate(parent, {
      sourceLayer: 'table_artifact',
      artifactLocalIndex: 3,
    });
    expect(child.mappingState).toBe('resolved_physical_page');
    expect(child.mappingBasis).toBe('inherited_from_proven_parent');
    expect(child.physicalPageNumber).toBe(41);
    expect(child.sourceArtifactId).toBe('artifact-1');
    expect(child.sourceLayer).toBe('table_artifact');
  });

  it('does not launder an unproven parent into a resolved child', () => {
    const legacyParent = legacyPageCoordinate({ legacyPageValue: 41 });
    const legacyChild = inheritPhysicalPageCoordinate(legacyParent, {
      sourceLayer: 'table_artifact',
    });
    expect(legacyChild.mappingState).toBe('unresolved_physical_page');
    expect(legacyChild.physicalPageNumber).toBeNull();

    const conflicted = conflictingPhysicalPageCoordinate({ sourceLayer: 'ocr' });
    const conflictedChild = inheritPhysicalPageCoordinate(conflicted, {
      sourceLayer: 'table_artifact',
    });
    expect(conflictedChild.mappingState).toBe('conflicting_physical_page_mapping');
    expect(conflictedChild.physicalPageNumber).toBeNull();
  });

  it('never emits a non-legacy layer carrying legacy state or a legacy page integer', () => {
    // The persisted CHECK constraint only accepts `legacy_unproven` together
    // with `sourceLayer = 'legacy'`, and only accepts a non-null
    // `legacyPageValue` on that same pairing. A derived child is always a
    // non-legacy layer, so inheritance must never produce either combination —
    // otherwise every table cell descended from a legacy page would be
    // rejected at INSERT and take the whole Step 1 publication down with it.
    const legacyParents = [
      legacyPageCoordinate({ legacyPageValue: 41 }),
      legacyPageCoordinate({ legacyPageValue: null }),
      legacyPageCoordinate({
        sourceDocumentId: 'doc-1',
        sourceArtifactId: 'artifact-1',
        legacyPageValue: 7,
      }),
    ];
    const childLayers = ['pdf_native_text', 'ocr', 'table_artifact'] as const;

    for (const parent of legacyParents) {
      for (const sourceLayer of childLayers) {
        const single = inheritPhysicalPageCoordinate(parent, { sourceLayer });
        const multi = inheritPhysicalPageCoordinates([parent], { sourceLayer });
        for (const child of [single, multi]) {
          expect(child.sourceLayer).toBe(sourceLayer);
          expect(child.mappingState).not.toBe('legacy_unproven');
          expect(child.legacyPageValue).toBeNull();
          expect(child.physicalPageNumber).toBeNull();
          expect(isResolvedPhysicalPage(child)).toBe(false);
        }
        // Single- and multi-parent inheritance must agree on state.
        expect(single.mappingState).toBe(multi.mappingState);
      }
    }
  });

  it('withholds the page when layers conflict rather than arbitrating', () => {
    const coordinate = conflictingPhysicalPageCoordinate({
      sourceLayer: 'pdf_native_text',
      artifactLocalIndex: 7,
    });
    expect(coordinate.mappingState).toBe('conflicting_physical_page_mapping');
    expect(coordinate.physicalPageNumber).toBeNull();
    expect(isResolvedPhysicalPage(coordinate)).toBe(false);
  });

  it('takes total physical pages only from a positive artifact page count', () => {
    expect(resolveTotalPhysicalPages(238)).toBe(238);
    for (const bad of [0, -5, 1.5, null, undefined, Number.NaN]) {
      expect(resolveTotalPhysicalPages(bad as number | null)).toBeNull();
    }
  });

  it('does not treat layer entry counts as a page-count source', () => {
    // A layer count is a count of what one extractor produced, not the
    // document's physical length: a truncated native-text layer under-reports,
    // and an OCR layer matching the true count is coincidence, not proof.
    // resolveTotalPhysicalPages accepts only the artifact's own page_count, so
    // callers cannot pass a layer length without it being an explicit mistake.
    const artifactPageCount = 238;
    const nativeTextLayerEntries = 200;
    expect(resolveTotalPhysicalPages(artifactPageCount)).toBe(238);
    expect(resolveTotalPhysicalPages(nativeTextLayerEntries)).not.toBe(artifactPageCount);
  });

  it('returns frozen coordinates', () => {
    const coordinate = physicalPageFromExtractorIteration({
      physicalPageNumber: 1,
      sourceArtifact: SOURCE_ARTIFACT,
      totalPhysicalPages: 1,
      sourceLayer: 'ocr',
    });
    expect(Object.isFrozen(coordinate)).toBe(true);
  });
});

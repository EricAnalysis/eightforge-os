import { describe, expect, it } from 'vitest';
import {
  buildGenericTableArtifacts,
  compareSourceFragmentsBySourceOrder,
  GENERIC_TABLE_PARSER,
  type ObservedTableRegion,
} from '@/lib/extraction/domain/genericTableArtifacts';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  ExtractionRun,
  PageArtifact,
  SourceArtifact,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';

const SHA = 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const source: SourceArtifact = {
  id: opaqueIds.existingSourceArtifact('10000000-0000-4000-8000-000000000001'),
  organization_id: 'org-1',
  source_document_id: 'document-1',
  source_sha256: SHA,
  storage_object_version: 'version-1',
  media_type_sniffed: 'application/pdf',
  byte_length: 1024,
  created_at: '2026-07-27T00:00:00.000Z',
};
const run: ExtractionRun = {
  id: opaqueIds.extractionRun({ source: source.id, manifest: MANIFEST }),
  organization_id: source.organization_id,
  semantic_key: 'semantic-run',
  attempt_number: 1,
  source_artifact_id: source.id,
  parser_manifest_hash: MANIFEST,
  artifact_schema_version: 'extraction-artifact-v1',
  status: 'complete',
};

function page(pageNumber: number): PageArtifact {
  return {
    id: opaqueIds.pageArtifact({ run: run.id, page: pageNumber }),
    organization_id: source.organization_id,
    extraction_run_id: run.id,
    source_artifact_id: source.id,
    source_document_id: source.source_document_id,
    source_sha256: SHA,
    page: pageNumber,
    width: 1000,
    height: 1000,
    rotation_degrees: 0,
    render_sha256: pageNumber.toString(16).padStart(64, '0'),
    parser_manifest_hash: MANIFEST,
    parser: { ...GENERIC_TABLE_PARSER, stage: 'page_render' },
    status: 'processed',
  };
}

function token(
  targetPage: PageArtifact,
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  readingOrder: number,
): SourceFragmentArtifact {
  const boundingBox = {
    coordinate_space: 'page_normalized' as const,
    origin: 'top_left' as const,
    x0,
    y0,
    x1,
    y1,
    rotation: 0 as const,
  };
  return {
    id: opaqueIds.fragmentArtifact({
      page: targetPage.id,
      text,
      bounding_box: boundingBox,
      reading_order: readingOrder,
    }),
    organization_id: source.organization_id,
    kind: 'token',
    extraction_run_id: run.id,
    source_artifact_id: source.id,
    page_artifact_id: targetPage.id,
    source_document_id: source.source_document_id,
    source_sha256: SHA,
    parser_manifest_hash: MANIFEST,
    page: targetPage.page,
    bounding_box: boundingBox,
    raw_text: text,
    parser: { ...GENERIC_TABLE_PARSER, stage: 'native_text' },
    recognition_confidence: null,
    reading_order: readingOrder,
  };
}

function build(
  pages: readonly PageArtifact[],
  fragments: readonly SourceFragmentArtifact[],
  regions?: readonly ObservedTableRegion[],
  sections?: Parameters<typeof buildGenericTableArtifacts>[0]['sections'],
) {
  return buildGenericTableArtifacts({
    source_artifact: source,
    run,
    pages,
    fragments,
    regions,
    sections,
  });
}

describe('identity-independent source ordering', () => {
  it('is antisymmetric and transitive without consulting opaque IDs', () => {
    const targetPage = page(1);
    const first = token(targetPage, 'A', 0.1, 0.1, 0.2, 0.12, 1);
    const second = token(targetPage, 'B', 0.2, 0.1, 0.3, 0.12, 2);
    const third = token(targetPage, 'C', 0.3, 0.1, 0.4, 0.12, 3);
    expect(compareSourceFragmentsBySourceOrder(first, second)).toBeLessThan(0);
    expect(compareSourceFragmentsBySourceOrder(second, first)).toBeGreaterThan(0);
    expect(compareSourceFragmentsBySourceOrder(second, third)).toBeLessThan(0);
    expect(compareSourceFragmentsBySourceOrder(first, third)).toBeLessThan(0);
  });

  it('treats an opaque-ID-only difference as an ordering tie', () => {
    const original = token(page(1), 'same', 0.1, 0.1, 0.2, 0.12, 1);
    const rekeyed: SourceFragmentArtifact = {
      ...original,
      id: opaqueIds.fragmentArtifact({ manifest_only_rekey: true }),
    };
    expect(compareSourceFragmentsBySourceOrder(original, rekeyed)).toBe(0);
    expect(compareSourceFragmentsBySourceOrder(rekeyed, original)).toBe(0);
  });
});

function splitRowScenario(destinationPageNumber: number, options: {
  readonly destinationY?: number;
  readonly destinationHeight?: number;
  readonly destinationX?: number;
  readonly repeatedHeader?: boolean;
} = {}) {
  const fromPage = page(1);
  const toPage = page(destinationPageNumber);
  const headerA = token(fromPage, 'Item', 0.05, 0.80, 0.20, 0.82, 1);
  const headerB = token(fromPage, 'Detail', 0.55, 0.80, 0.70, 0.82, 2);
  const fullA = token(fromPage, 'Complete', 0.05, 0.85, 0.20, 0.87, 3);
  const fullB = token(fromPage, 'row', 0.55, 0.85, 0.70, 0.87, 4);
  const partialA = token(fromPage, 'Continued', 0.05, 0.93, 0.20, 0.95, 5);
  const destinationY = options.destinationY ?? 0.03;
  const destinationHeight = options.destinationHeight ?? 0.02;
  const destinationX = options.destinationX ?? 0.55;
  const destination = token(
    toPage,
    options.repeatedHeader ? 'Detail' : 'text',
    destinationX,
    destinationY,
    destinationX + 0.15,
    destinationY + destinationHeight,
    6,
  );
  const regions: readonly ObservedTableRegion[] = [
    {
      page_artifact_id: fromPage.id,
      rows: [
        {
          row_kind: 'header',
          cells: [{ token_ids: [headerA.id] }, { token_ids: [headerB.id] }],
        },
        {
          row_kind: 'data',
          cells: [{ token_ids: [fullA.id] }, { token_ids: [fullB.id] }],
        },
        { row_kind: 'data', cells: [{ token_ids: [partialA.id] }] },
      ],
      detection_evidence: ['x_alignment'],
    },
    {
      page_artifact_id: toPage.id,
      rows: [{
        row_kind: options.repeatedHeader ? 'header' : 'continuation',
        cells: [{ token_ids: [destination.id] }],
      }],
      detection_evidence: ['x_alignment'],
    },
  ];
  return {
    pages: [fromPage, toPage],
    fragments: [headerA, headerB, fullA, fullB, partialA, destination],
    regions,
  };
}

describe('generic physical table artifacts', () => {
  it('detects one-row borderless pass-through tables without numeric/cardinality assumptions', () => {
    const p = page(4);
    const fragments = [
      token(p, 'Description', 0.05, 0.2, 0.25, 0.23, 1),
      token(p, 'Special notes', 0.55, 0.2, 0.78, 0.23, 2),
    ];
    const result = build([p], fragments);

    expect(result.gaps).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.cells.map((cell) => cell.raw_text)).toEqual([
      'Description',
      'Special notes',
    ]);
    expect(result.segments[0]?.detection_evidence.map(({ kind }) => kind))
      .toEqual(['x_alignment', 'whitespace_gutters']);
    expect(result.chains[0]?.completeness).toBe('complete');
  });

  it('coalesces same-line cell fragments but preserves a measured structural gutter', () => {
    const p = page(5);
    const fragments = [
      token(p, 'Description', 0.05, 0.20, 0.18, 0.22, 1),
      token(p, 'Unit', 0.55, 0.20, 0.61, 0.22, 2),
      token(p, 'Traffic', 0.05, 0.25, 0.12, 0.27, 3),
      token(p, 'control', 0.13, 0.25, 0.20, 0.27, 4),
      token(p, 'EA', 0.55, 0.25, 0.58, 0.27, 5),
    ];
    const result = build([p], fragments);

    expect(result.rows).toHaveLength(2);
    expect(result.cells.map(({ raw_text }) => raw_text)).toEqual([
      'Description',
      'Unit',
      'Traffic control',
      'EA',
    ]);
    expect(result.cells[2]?.artifact_data?.fragment_coalescing).toMatchObject({
      applied: true,
      reason: 'same_line_without_structural_gutter',
      basis_fragment_ids: [fragments[2]?.id, fragments[3]?.id],
    });
  });

  it('uses vertical overlap for baselines and attaches a sparse wrapped line to its nearest row', () => {
    const p = page(6);
    const fragments = [
      token(p, 'Description', 0.05, 0.20, 0.18, 0.21, 1),
      token(p, 'Unit', 0.55, 0.20, 0.61, 0.21, 2),
      token(p, 'Long', 0.05, 0.23, 0.12, 0.24, 3),
      token(p, 'EA', 0.55, 0.23, 0.58, 0.24, 4),
      token(p, 'description', 0.05, 0.245, 0.20, 0.255, 5),
      token(p, 'Other', 0.05, 0.28, 0.14, 0.29, 6),
      token(p, 'LS', 0.55, 0.28, 0.58, 0.29, 7),
    ];
    const result = build([p], fragments);

    expect(result.rows).toHaveLength(3);
    expect(result.cells.map(({ raw_text }) => raw_text)).toContain('Long\ndescription');
    expect(result.cells.map(({ raw_text }) => raw_text)).toContain('Other');
  });

  it('coalesces a currency marker with its numeric token without merging adjacent columns', () => {
    const p = page(7);
    const fragments = [
      token(p, 'Work', 0.05, 0.20, 0.12, 0.22, 1),
      token(p, 'EA', 0.40, 0.20, 0.44, 0.22, 2),
      token(p, '$', 0.70, 0.20, 0.71, 0.22, 3),
      token(p, '125.00', 0.75, 0.20, 0.82, 0.22, 4),
    ];
    const result = build([p], fragments);

    expect(result.cells.map(({ raw_text }) => raw_text)).toEqual([
      'Work',
      'EA',
      '$ 125.00',
    ]);
  });

  it.each(['-', '\u2013', '\u2014'])(
    'coalesces a currency marker with %s only inside one measured band',
    (dash) => {
      const p = page(16);
      const fragments = [
        token(p, 'Item', 0.05, 0.20, 0.10, 0.21, 1),
        token(p, 'Amount', 0.55, 0.20, 0.62, 0.21, 2),
        token(p, 'A', 0.05, 0.24, 0.10, 0.25, 3),
        token(p, '$', 0.55, 0.24, 0.56, 0.25, 4),
        token(p, dash, 0.59, 0.24, 0.60, 0.25, 5),
      ];
      const result = build([p], fragments);
      const value = result.cells.find(({ raw_text }) =>
        raw_text.includes('$'));

      expect(value?.raw_text).toBe(`$ ${dash}`);
      expect(value?.content_token_ids).toEqual([
        fragments[3]?.id,
        fragments[4]?.id,
      ]);
      expect(value?.artifact_data?.fragment_coalescing).toMatchObject({
        applied: true,
        reason: 'currency_marker_dash_pair',
      });
    },
  );

  it('does not coalesce currency and dash tokens separated by a column boundary', () => {
    const p = page(17);
    const fragments = [
      token(p, 'Left', 0.05, 0.20, 0.10, 0.21, 1),
      token(p, 'Right', 0.55, 0.20, 0.62, 0.21, 2),
      token(p, '$', 0.40, 0.24, 0.41, 0.25, 3),
      token(p, '-', 0.55, 0.24, 0.56, 0.25, 4),
    ];
    const result = build([p], fragments);

    expect(result.cells.every(({ raw_text }) => raw_text !== '$ -')).toBe(true);
  });

  it('keeps non-overlapping nearby baselines as distinct logical rows', () => {
    const p = page(8);
    const fragments = [
      token(p, 'First', 0.05, 0.20, 0.12, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, 'Second', 0.05, 0.216, 0.14, 0.226, 3),
      token(p, 'LS', 0.55, 0.216, 0.58, 0.226, 4),
    ];
    const result = build([p], fragments);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(({ raw_text }) => raw_text)).toEqual([
      'First\tEA',
      'Second\tLS',
    ]);
  });

  it('attaches a sparse first line forward when following-row geometry dominates', () => {
    const p = page(9);
    const fragments = [
      token(p, 'Previous', 0.05, 0.20, 0.15, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, 'Next description', 0.05, 0.23, 0.19, 0.24, 3),
      token(p, 'continued', 0.05, 0.245, 0.13, 0.255, 4),
      token(p, 'LS', 0.55, 0.245, 0.58, 0.255, 5),
    ];
    const result = build([p], fragments);

    expect(result.cells.map(({ raw_text }) => raw_text))
      .toContain('Next description\ncontinued');
    expect(result.reconstruction_diagnostics.sparse_row_dispositions)
      .toContainEqual(expect.objectContaining({
        outcome: 'attached',
        selected_primary_row_index: 2,
        selected_column_index: 0,
        candidate_rows: expect.arrayContaining([
          expect.objectContaining({ direction: 'forward' }),
          expect.objectContaining({ direction: 'backward' }),
        ]),
      }));
  });

  it('uses the anchored row start as the ordinal boundary when adjacent distances are close', () => {
    const p = page(22);
    const fragments = [
      token(p, 'Prior row', 0.05, 0.20, 0.16, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, 'Continuation detail', 0.05, 0.224, 0.22, 0.234, 3),
      token(p, 'Following row', 0.05, 0.25, 0.18, 0.26, 4),
      token(p, 'LS', 0.55, 0.25, 0.58, 0.26, 5),
    ];
    const result = build([p], fragments);
    const disposition =
      result.reconstruction_diagnostics.sparse_row_dispositions[0];

    expect(disposition).toMatchObject({
      outcome: 'attached',
      selected_primary_row_index: 0,
      selected_column_index: 0,
      selection_basis:
        'backward_row_start_boundary_within_uncertainty',
    });
    expect(result.cells.map(({ raw_text }) => raw_text))
      .toContain('Prior row\nContinuation detail');
  });

  it('keeps immutable row-anchor geometry after opening a missing wrapped cell', () => {
    const p = page(21);
    const fragments = [
      token(p, 'Previous', 0.05, 0.20, 0.16, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, '$ 1', 0.75, 0.20, 0.79, 0.21, 3),
      token(p, 'Repeated route', 0.05, 0.23, 0.20, 0.24, 4),
      token(p, 'LS', 0.55, 0.25, 0.58, 0.26, 5),
      token(p, '$ 2', 0.75, 0.25, 0.79, 0.26, 6),
      token(p, 'continued', 0.05, 0.27, 0.14, 0.28, 7),
      token(p, 'Next', 0.05, 0.30, 0.12, 0.31, 8),
      token(p, 'CY', 0.55, 0.30, 0.58, 0.31, 9),
      token(p, '$ 3', 0.75, 0.30, 0.79, 0.31, 10),
    ];
    const result = build([p], fragments);
    const dispositions =
      result.reconstruction_diagnostics.sparse_row_dispositions;

    expect(result.cells.map(({ raw_text }) => raw_text))
      .toContain('Repeated route\ncontinued');
    expect(dispositions).toHaveLength(2);
    expect(dispositions.every((item) =>
      item.outcome === 'attached'
      && item.selected_primary_row_index === 2
      && item.selected_column_index === 0))
      .toBe(true);
    expect(dispositions[0]?.candidate_rows[0]?.measurements)
      .toMatchObject({ target_cell_opened_from_sparse: false });
    expect(dispositions[1]?.candidate_rows[0]?.measurements)
      .toMatchObject({ target_cell_opened_from_sparse: true });
  });

  it('uses positional sequence evidence when adjacent wrapped text is identical', () => {
    const p = page(20);
    const fragments = [
      token(p, 'Repeated route text', 0.05, 0.20, 0.24, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, 'Repeated route text', 0.05, 0.214, 0.24, 0.224, 3),
      token(p, 'Repeated route text', 0.05, 0.25, 0.24, 0.26, 4),
      token(p, 'LS', 0.55, 0.25, 0.58, 0.26, 5),
    ];
    const result = build([p], fragments);
    const disposition =
      result.reconstruction_diagnostics.sparse_row_dispositions[0];

    expect(disposition).toMatchObject({
      outcome: 'attached',
      selected_primary_row_index: 0,
      selected_column_index: 0,
    });
    expect(disposition?.candidate_rows[0]?.measurements)
      .toMatchObject({
        row_order_consistency: 1,
        vertical_progression: expect.any(Number),
        target_cell_existed: true,
      });
  });

  it('preserves tied repeated-text candidates as an explicit gap', () => {
    const p = page(10);
    const fragments = [
      token(p, 'Repeated', 0.05, 0.20, 0.12, 0.21, 1),
      token(p, 'EA', 0.55, 0.20, 0.58, 0.21, 2),
      token(p, 'Repeated', 0.05, 0.22, 0.14, 0.23, 3),
      token(p, 'Repeated', 0.05, 0.24, 0.12, 0.25, 4),
      token(p, 'LS', 0.55, 0.24, 0.58, 0.25, 5),
    ];
    const result = build([p], fragments);
    const disposition =
      result.reconstruction_diagnostics.sparse_row_dispositions[0];

    expect(disposition).toMatchObject({
      outcome: 'unresolved_gap',
      rejection_reason: 'candidate_scores_tied',
      selected_primary_row_index: null,
    });
    expect(disposition?.candidate_rows.map(({ direction }) => direction).sort())
      .toEqual(['backward', 'forward']);
    expect(result.gaps.some(({ id }) =>
      id === disposition?.processing_gap_id)).toBe(true);
  });

  it('constrains final coalescing to inferred bands and keeps row label separate', () => {
    const p = page(11);
    const fragments = [
      token(p, 'Item', 0.05, 0.20, 0.10, 0.21, 1),
      token(p, 'Description', 0.19, 0.20, 0.30, 0.21, 2),
      token(p, '1', 0.05, 0.24, 0.06, 0.25, 3),
      token(p, 'Close description', 0.085, 0.24, 0.22, 0.25, 4),
    ];
    const result = build([p], fragments);

    expect(result.cells.map(({ raw_text }) => raw_text)).toEqual([
      'Item',
      'Description',
      '1',
      'Close description',
    ]);
    expect(result.cells[2]?.column_start).not.toBe(
      result.cells[3]?.column_start,
    );
  });

  it('lets row-global evidence resolve a measured-boundary candidate', () => {
    const p = page(12);
    const fragments = [
      token(p, 'A', 0.08, 0.20, 0.12, 0.21, 1),
      token(p, 'B', 0.48, 0.20, 0.52, 0.21, 2),
      token(p, 'C', 0.08, 0.24, 0.12, 0.25, 3),
      token(p, 'D', 0.48, 0.24, 0.52, 0.25, 4),
      token(p, 'Boundary', 0.275, 0.22, 0.285, 0.23, 5),
    ];
    const result = build([p], fragments);

    const diagnostic =
      result.reconstruction_diagnostics.row_anchor_assignments.find(
        ({ physical_row_index }) => physical_row_index === 1,
      );
    expect(diagnostic?.candidate_matrix[0]).toHaveLength(2);
    expect(diagnostic?.selected_assignments[0]).toMatchObject({
      column_index: expect.any(Number),
      processing_gap_id: null,
    });
    expect(result.reconstruction_diagnostics.undisposed_fragment_ids)
      .not.toContain(fragments[4]?.id);
    expect(result.reconstruction_diagnostics.column_overflows)
      .toHaveLength(0);
  });

  it('uses observed gap distributions only with sufficient calibration evidence', () => {
    const p = page(13);
    const fragments = Array.from({ length: 4 }, (_, rowIndex) => {
      const y = 0.20 + rowIndex * 0.04;
      return [
        token(p, `Left${rowIndex}`, 0.05, y, 0.10, y + 0.01, rowIndex * 4 + 1),
        token(p, 'part', 0.105, y, 0.15, y + 0.01, rowIndex * 4 + 2),
        token(p, `Right${rowIndex}`, 0.55, y, 0.60, y + 0.01, rowIndex * 4 + 3),
        token(p, 'part', 0.605, y, 0.65, y + 0.01, rowIndex * 4 + 4),
      ];
    }).flat();
    const result = build([p], fragments);
    const calibration = result.reconstruction_diagnostics.calibrations[0];

    expect(calibration?.horizontal_gaps.sample_count).toBeGreaterThanOrEqual(8);
    expect(calibration?.thresholds.maximum_inline_gap).toMatchObject({
      mode: 'adaptive',
      fallback_reason: null,
    });
    expect(calibration?.thresholds.maximum_inline_gap.confidence)
      .toBeGreaterThanOrEqual(0.75);
  });

  it('falls back to bounded defaults when calibration evidence is insufficient', () => {
    const p = page(14);
    const fragments = [
      token(p, 'Left', 0.05, 0.20, 0.12, 0.21, 1),
      token(p, 'Right', 0.55, 0.20, 0.62, 0.21, 2),
    ];
    const result = build([p], fragments);
    const calibration = result.reconstruction_diagnostics.calibrations[0];

    expect(calibration?.thresholds.maximum_inline_gap).toMatchObject({
      mode: 'fallback',
      selected: 0.025,
      previous_default: 0.025,
    });
    expect(calibration?.thresholds.maximum_inline_gap.fallback_reason)
      .toBeTruthy();
  });

  it('selects different relative thresholds for measurably different layouts', () => {
    const makeLayout = (pageNumber: number, inlineGap: number) => {
      const p = page(pageNumber);
      const fragments = Array.from({ length: 5 }, (_, rowIndex) => {
        const y = 0.20 + rowIndex * 0.04;
        return [
          token(p, `L${rowIndex}`, 0.05, y, 0.10, y + 0.01, rowIndex * 4 + 1),
          token(
            p,
            'part',
            0.10 + inlineGap,
            y,
            0.15 + inlineGap,
            y + 0.01,
            rowIndex * 4 + 2,
          ),
          token(p, `R${rowIndex}`, 0.55, y, 0.60, y + 0.01, rowIndex * 4 + 3),
          token(
            p,
            'part',
            0.60 + inlineGap,
            y,
            0.65 + inlineGap,
            y + 0.01,
            rowIndex * 4 + 4,
          ),
        ];
      }).flat();
      return build([p], fragments).reconstruction_diagnostics.calibrations[0]!;
    };
    const dense = makeLayout(18, 0.005);
    const sparse = makeLayout(19, 0.018);

    expect(dense.thresholds.maximum_inline_gap.selected)
      .not.toBe(sparse.thresholds.maximum_inline_gap.selected);
    expect(dense.thresholds.maximum_inline_gap.applied_bound).toBe('none');
    expect(sparse.thresholds.maximum_inline_gap.applied_bound).toBe('none');
  });

  it('does not invent overflow columns and disposes every candidate fragment', () => {
    const p = page(15);
    const fragments = [
      token(p, 'A', 0.05, 0.20, 0.10, 0.21, 1),
      token(p, 'B', 0.50, 0.20, 0.55, 0.21, 2),
      token(p, 'C', 0.05, 0.24, 0.10, 0.25, 3),
      token(p, 'D', 0.50, 0.24, 0.55, 0.25, 4),
      token(p, 'E', 0.05, 0.28, 0.10, 0.29, 5),
      token(p, 'F', 0.50, 0.28, 0.55, 0.29, 6),
      token(p, 'overflow', 0.80, 0.28, 0.88, 0.29, 7),
    ];
    const result = build([p], fragments);

    expect(result.reconstruction_diagnostics.column_overflows)
      .toContainEqual(expect.objectContaining({
        fragment_ids: [fragments[6]?.id],
        rejection_reason: 'anchor_already_occupied',
      }));
    expect(Math.max(...result.cells.map(({ column_start }) => column_start))).toBe(1);
    expect(result.reconstruction_diagnostics.undisposed_fragment_ids).toEqual([]);
    expect(result.reconstruction_diagnostics.disposed_fragment_count)
      .toBe(result.reconstruction_diagnostics.table_candidate_fragment_count);
    expect(result.reconstruction_diagnostics.row_anchor_assignments)
      .toContainEqual(expect.objectContaining({
        selected_assignments: expect.arrayContaining([
          expect.objectContaining({
            structural_signal: 'structural_excess_cells',
            column_index: null,
            processing_gap_id: expect.any(String),
          }),
        ]),
      }));
  });

  it('retains bordered merged spans and multiline text once without copying neighbors', () => {
    const p = page(2);
    const description = token(p, 'Long', 0.05, 0.20, 0.18, 0.22, 1);
    const secondLine = token(p, 'description', 0.05, 0.25, 0.25, 0.27, 2);
    const unit = token(p, 'CY', 0.60, 0.20, 0.66, 0.22, 3);
    const regions: readonly ObservedTableRegion[] = [{
      page_artifact_id: p.id,
      rows: [{
        row_kind: 'data',
        cells: [{
          token_ids: [description.id, secondLine.id],
          row_span: 2,
          column_span: 2,
          structure: 'merged',
          border_evidence: {
            top: 'ruling',
            right: 'ruling',
            bottom: 'ruling',
            left: 'ruling',
          },
        }, { token_ids: [unit.id] }],
      }],
      detection_evidence: ['ruling_lines'],
    }];
    const result = build([p], [description, secondLine, unit], regions);

    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]).toMatchObject({
      raw_text: 'Long\ndescription',
      structure: 'merged',
      row_span: 2,
      column_span: 2,
      line_break_offsets: [4],
    });
    expect(result.cells.map(({ raw_text }) => raw_text)).toEqual([
      'Long\ndescription',
      'CY',
    ]);
    expect(result.cells[0]?.content_token_ids).toEqual([description.id, secondLine.id]);
  });

  it('builds subtables with explicit child chains and source rows', () => {
    const p = page(3);
    const outerA = token(p, 'Outer', 0.05, 0.1, 0.2, 0.13, 1);
    const outerB = token(p, 'Value', 0.5, 0.1, 0.65, 0.13, 2);
    const childA = token(p, 'Child', 0.1, 0.3, 0.25, 0.33, 3);
    const childB = token(p, 'Detail', 0.55, 0.3, 0.7, 0.33, 4);
    const regions: readonly ObservedTableRegion[] = [
      {
        page_artifact_id: p.id,
        rows: [{ cells: [{ token_ids: [outerA.id] }, { token_ids: [outerB.id] }] }],
        detection_evidence: ['whitespace_gutters'],
      },
      {
        page_artifact_id: p.id,
        rows: [{ cells: [{ token_ids: [childA.id] }, { token_ids: [childB.id] }] }],
        detection_evidence: ['typographic_grouping'],
        parent_region_index: 0,
      },
    ];
    const result = build(
      [p],
      [outerA, outerB, childA, childB],
      regions,
      [{
        region_index: 0,
        member_row_indexes: [0],
        child_region_indexes: [1],
      }],
    );

    expect(result.segments[1]?.parent_segment_id).toBe(result.segments[0]?.id);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.child_table_chain_ids).toEqual([result.chains[1]?.id]);
  });

  it('links repeated-header continuation on moved adjacent pages and preserves arbitrary rows', () => {
    const p7 = page(7);
    const p8 = page(8);
    const h7a = token(p7, 'Item', 0.05, 0.92, 0.2, 0.94, 1);
    const h7b = token(p7, 'Unit', 0.55, 0.92, 0.65, 0.94, 2);
    const h8a = token(p8, 'Item', 0.05, 0.03, 0.2, 0.05, 3);
    const h8b = token(p8, 'Unit', 0.55, 0.03, 0.65, 0.05, 4);
    const rows = Array.from({ length: 17 }, (_, index) => {
      const left = token(p7, `row-${index}`, 0.05, 0.1 + index * 0.03,
        0.2, 0.12 + index * 0.03, 10 + index * 2);
      const right = token(p7, 'text', 0.55, 0.1 + index * 0.03,
        0.65, 0.12 + index * 0.03, 11 + index * 2);
      return { left, right };
    });
    const regions: readonly ObservedTableRegion[] = [
      {
        page_artifact_id: p7.id,
        rows: [
          { row_kind: 'header', cells: [{ token_ids: [h7a.id] }, { token_ids: [h7b.id] }] },
          ...rows.map(({ left, right }) => ({
            row_kind: 'data' as const,
            cells: [{ token_ids: [left.id] }, { token_ids: [right.id] }] as const,
          })),
        ],
        detection_evidence: ['x_alignment', 'repeated_headers'],
      },
      {
        page_artifact_id: p8.id,
        rows: [{
          row_kind: 'header',
          cells: [{ token_ids: [h8a.id] }, { token_ids: [h8b.id] }],
        }],
        detection_evidence: ['x_alignment', 'repeated_headers'],
      },
    ];
    const result = build(
      [p7, p8],
      [h7a, h7b, h8a, h8b, ...rows.flatMap(({ left, right }) => [left, right])],
      regions,
    );

    expect(result.rows).toHaveLength(19);
    expect(result.continuation_links).toMatchObject([{ decision: 'linked' }]);
    expect(result.chains).toHaveLength(1);
    expect(result.segments[0]?.column_hypotheses[0]?.header.observed_text).toBe('Item');
  });

  it('retains cross-page continuation ambiguity instead of forcing a chain link', () => {
    const p9 = page(9);
    const p10 = page(10);
    const firstA = token(p9, 'Alpha', 0.05, 0.92, 0.2, 0.94, 1);
    const firstB = token(p9, 'Beta', 0.55, 0.92, 0.65, 0.94, 2);
    const movedA = token(p10, 'Different', 0.3, 0.03, 0.45, 0.05, 3);
    const movedB = token(p10, 'Header', 0.8, 0.03, 0.9, 0.05, 4);
    const result = build(
      [p9, p10],
      [firstA, firstB, movedA, movedB],
      [
        {
          page_artifact_id: p9.id,
          rows: [{ cells: [{ token_ids: [firstA.id] }, { token_ids: [firstB.id] }] }],
          detection_evidence: ['x_alignment'],
        },
        {
          page_artifact_id: p10.id,
          rows: [{ cells: [{ token_ids: [movedA.id] }, { token_ids: [movedB.id] }] }],
          detection_evidence: ['x_alignment'],
        },
      ],
    );

    expect(result.continuation_links).toMatchObject([{ decision: 'rejected' }]);
    expect(result.chains.every(({ completeness }) => completeness === 'complete')).toBe(true);
  });

  it('measures genuine row continuation from incomplete occupancy and boundary geometry', () => {
    const scenario = splitRowScenario(2);
    const result = build(scenario.pages, scenario.fragments, scenario.regions);
    const link = result.continuation_links[0];

    expect(link?.decision).toBe('linked');
    expect(link?.basis.row_continuation_score.value).toBeGreaterThan(0.75);
    expect(link?.basis.row_continuation_score.measurements).toMatchObject({
      repeated_header_present: false,
      source_populated_band_count: 1,
      destination_populated_band_count: 1,
      expected_source_band_count: 2,
    });
  });

  it('rejects a complete final row followed by an unrelated aligned table', () => {
    const p1 = page(1);
    const p2 = page(2);
    const sourceA = token(p1, 'Alpha', 0.05, 0.92, 0.20, 0.94, 1);
    const sourceB = token(p1, 'Beta', 0.55, 0.92, 0.70, 0.94, 2);
    const laterA = token(p2, 'Other', 0.05, 0.03, 0.20, 0.05, 3);
    const laterB = token(p2, 'Table', 0.55, 0.03, 0.70, 0.05, 4);
    const result = build([p1, p2], [sourceA, sourceB, laterA, laterB], [
      {
        page_artifact_id: p1.id,
        rows: [{ row_kind: 'data', cells: [
          { token_ids: [sourceA.id] }, { token_ids: [sourceB.id] },
        ] }],
        detection_evidence: ['x_alignment'],
      },
      {
        page_artifact_id: p2.id,
        rows: [{ row_kind: 'data', cells: [
          { token_ids: [laterA.id] }, { token_ids: [laterB.id] },
        ] }],
        detection_evidence: ['x_alignment'],
      },
    ]);

    expect(result.continuation_links).toMatchObject([{ decision: 'rejected' }]);
    expect(result.continuation_links[0]?.basis.row_continuation_score.value).toBe(0);
  });

  it('does not link aligned columns with incompatible boundary-row structure', () => {
    const scenario = splitRowScenario(2, {
      destinationY: 0.03,
      destinationHeight: 0.18,
      destinationX: 0.55,
    });
    const result = build(scenario.pages, scenario.fragments, scenario.regions);

    expect(result.continuation_links[0]?.decision).not.toBe('linked');
    expect(result.continuation_links[0]?.basis.row_continuation_score.measurements)
      .toMatchObject({ row_height_compatibility: expect.any(Number) });
  });

  it('finds a continuation across a blank or image-only intervening page with a penalty', () => {
    for (const interveningContent of ['blank', 'image'] as const) {
      const scenario = splitRowScenario(3);
      const middle = page(2);
      const imageSignal = interveningContent === 'image'
        ? [{
            ...token(middle, 'observed-image-region', 0.4, 0.4, 0.55, 0.42, 20),
            kind: 'layout_signal' as const,
            artifact_data: { signal: 'image_region' },
          }] : [];
      const result = build(
        [scenario.pages[0], middle, scenario.pages[1]],
        [...scenario.fragments, ...imageSignal],
        scenario.regions,
      );

      expect(result.continuation_links).toHaveLength(1);
      expect(result.continuation_links[0]?.decision).toBe('linked');
      expect(result.continuation_links[0]?.basis.page_distance_penalty).toMatchObject({
        value: 0.85,
        measurements: { page_distance: 2, skipped_page_count: 1 },
      });
    }
  });

  it('persists non-adjacent ambiguity and leaves no evidence when no later table exists', () => {
    const scenario = splitRowScenario(3, { destinationHeight: 0.06 });
    const ambiguous = build(scenario.pages, scenario.fragments, scenario.regions);
    const onlySource = build(
      [scenario.pages[0]],
      scenario.fragments.filter((fragment) => fragment.page === 1),
      [scenario.regions[0]],
    );

    expect(ambiguous.continuation_links[0]?.decision).toBe('ambiguous');
    expect(ambiguous.continuation_links[0]?.basis.page_distance_penalty.measurements)
      .toMatchObject({ skipped_page_count: 1 });
    expect(ambiguous.gaps).toMatchObject([{
      reason: 'table_structure_unresolved',
      detail: 'Measured cross-page table continuation remains ambiguous.',
    }]);
    expect(onlySource.continuation_links).toEqual([]);
  });

  it('does not fabricate a decision when later geometry is not structurally plausible', () => {
    const p1 = page(1);
    const p3 = page(3);
    const sourceToken = token(p1, 'Left', 0.05, 0.92, 0.15, 0.94, 1);
    const distantToken = token(p3, 'Right', 0.85, 0.03, 0.95, 0.05, 2);
    const result = build([p1, p3], [sourceToken, distantToken], [
      {
        page_artifact_id: p1.id,
        rows: [{ cells: [{ token_ids: [sourceToken.id] }] }],
        detection_evidence: ['typographic_grouping'],
      },
      {
        page_artifact_id: p3.id,
        rows: [{ cells: [{ token_ids: [distantToken.id] }] }],
        detection_evidence: ['typographic_grouping'],
      },
    ]);

    expect(result.continuation_links).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('penalizes a matched subset instead of reusing one band across incompatible columns', () => {
    const p1 = page(1);
    const p2 = page(2);
    const sourceTokens = [
      token(p1, 'A', 0.05, 0.92, 0.15, 0.94, 1),
      token(p1, 'B', 0.40, 0.92, 0.50, 0.94, 2),
      token(p1, 'C', 0.75, 0.92, 0.85, 0.94, 3),
    ];
    const subset = token(p2, 'A', 0.05, 0.03, 0.15, 0.05, 4);
    const result = build([p1, p2], [...sourceTokens, subset], [
      {
        page_artifact_id: p1.id,
        rows: [{ cells: [
          { token_ids: [sourceTokens[0]!.id] },
          { token_ids: [sourceTokens[1]!.id] },
          { token_ids: [sourceTokens[2]!.id] },
        ] }],
        detection_evidence: ['x_alignment'],
      },
      {
        page_artifact_id: p2.id,
        rows: [{ cells: [{ token_ids: [subset.id] }] }],
        detection_evidence: ['x_alignment'],
      },
    ]);

    expect(result.continuation_links).toEqual([]);
  });

  it('treats a merged cell spanning observed bands as complete, not a split row', () => {
    const p1 = page(1);
    const p2 = page(2);
    const headerA = token(p1, 'A', 0.05, 0.85, 0.15, 0.87, 1);
    const headerB = token(p1, 'B', 0.55, 0.85, 0.65, 0.87, 2);
    const merged = token(p1, 'Complete merged row', 0.05, 0.92, 0.65, 0.94, 3);
    const destination = token(p2, 'Later', 0.05, 0.03, 0.65, 0.05, 4);
    const result = build([p1, p2], [headerA, headerB, merged, destination], [
      {
        page_artifact_id: p1.id,
        rows: [
          { row_kind: 'header', cells: [
            { token_ids: [headerA.id] }, { token_ids: [headerB.id] },
          ] },
          { row_kind: 'data', cells: [{
            token_ids: [merged.id],
            column_span: 2,
            structure: 'column_spanning',
          }] },
        ],
        detection_evidence: ['x_alignment'],
      },
      {
        page_artifact_id: p2.id,
        rows: [{ row_kind: 'continuation', cells: [{ token_ids: [destination.id] }] }],
        detection_evidence: ['x_alignment'],
      },
    ]);

    expect(result.continuation_links[0]?.basis.row_continuation_score).toMatchObject({
      value: 0,
      measurements: { final_row_incomplete: 0 },
    });
    expect(result.continuation_links[0]?.decision).toBe('rejected');
  });

  it('never emits branching linked continuations for competing destinations', () => {
    const scenario = splitRowScenario(2);
    const destinationPage = scenario.pages[1];
    const competitor = token(destinationPage, 'alternate', 0.55, 0.03, 0.70, 0.05, 30);
    const result = build(
      scenario.pages,
      [...scenario.fragments, competitor],
      [
        ...scenario.regions,
        {
          page_artifact_id: destinationPage.id,
          rows: [{
            row_kind: 'continuation',
            cells: [{ token_ids: [competitor.id] }],
          }],
          detection_evidence: ['x_alignment'],
        },
      ],
    );

    expect(result.continuation_links.filter(({ decision }) => decision === 'linked'))
      .toHaveLength(0);
    expect(result.continuation_links.filter(({ decision }) => decision === 'ambiguous'))
      .toHaveLength(2);
    expect(result.continuation_links.map(({ score }) => score.measurements))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          competition_axis: 'outgoing',
          competing_candidate_count: 2,
          competition_resolution: 'all_ambiguous_near_tie',
          competition_near_tie_tolerance: 0.025,
          competing_score_margin: 0,
        }),
      ]));
    expect(result.continuation_links.every(({ score }) =>
      score.basis_artifact_ids.length === 3)).toBe(true);
    expect(result.continuation_links.every(({ score }) =>
      score.diagnostics.includes('Competing outgoing continuation policy applied.')))
      .toBe(true);
    expect(result.gaps.filter(({ reason }) => reason === 'table_structure_unresolved'))
      .toHaveLength(2);
    expect(result.gaps.every(({ detail }) =>
      detail.includes('competing outgoing candidates are within the V2 near-tie tolerance')))
      .toBe(true);
  });

  it('keeps non-adjacent continuation identities and ordering stable on replay', () => {
    const scenario = splitRowScenario(3);
    const left = build(scenario.pages, scenario.fragments, scenario.regions);
    const right = build(
      structuredClone(scenario.pages),
      structuredClone(scenario.fragments),
      structuredClone(scenario.regions),
    );

    expect(right).toEqual(left);
    expect(left.continuation_links.map(({ id }) => id))
      .toEqual([...left.continuation_links.map(({ id }) => id)].sort());
  });

  it('emits a typed gap for incomplete geometry and handles no-table input cleanly', () => {
    const p = page(1);
    const invalid = {
      ...token(p, 'Broken', 0.1, 0.1, 0.2, 0.2, 1),
      bounding_box: {
        coordinate_space: 'page_normalized' as const,
        origin: 'top_left' as const,
        x0: 0.2,
        y0: 0.1,
        x1: 0.1,
        y1: 0.2,
        rotation: 0 as const,
      },
    };
    const explicit = build([p], [invalid], [{
      page_artifact_id: p.id,
      rows: [{ cells: [{ token_ids: [invalid.id] }] }],
      detection_evidence: ['x_alignment'],
    }]);
    const plain = token(p, 'ordinary prose', 0.1, 0.4, 0.25, 0.42, 2);
    const noTable = build([p], [plain]);

    expect(explicit.gaps).toMatchObject([{
      stage: 'table_reconstruction',
      reason: 'table_structure_unresolved',
    }]);
    expect(explicit.cells).toEqual([]);
    expect(noTable).toMatchObject({
      cells: [],
      rows: [],
      segments: [],
      chains: [],
      gaps: [],
    });
  });

  it('replays identical structure deterministically while preserving duplicate values by position', () => {
    const p = page(5);
    const first = token(p, '10', 0.1, 0.1, 0.2, 0.12, 1);
    const second = token(p, '10', 0.1, 0.2, 0.2, 0.22, 2);
    const region: ObservedTableRegion = {
      page_artifact_id: p.id,
      rows: [
        { cells: [{ token_ids: [first.id] }] },
        { cells: [{ token_ids: [second.id] }] },
      ],
      detection_evidence: ['ruling_lines'],
    };
    const left = build([p], [first, second], [region]);
    const right = build([p], [first, second], [structuredClone(region)]);

    expect(left.cells.map(({ raw_text }) => raw_text)).toEqual(['10', '10']);
    expect(new Set(left.cells.map(({ id }) => id)).size).toBe(2);
    expect(right).toEqual(left);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildGenericTableArtifacts,
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

    expect(result.continuation_links).toMatchObject([{ decision: 'ambiguous' }]);
    expect(result.chains.every(({ completeness }) => completeness === 'ambiguous')).toBe(true);
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

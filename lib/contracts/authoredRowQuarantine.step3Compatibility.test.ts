import { describe, expect, it } from 'vitest';
import {
  authoredRateRowQuarantine,
  type AuthoredRateRowLike,
} from '@/lib/contracts/authoredRowQuarantine';
import { verifiedFieldFixture } from '@/lib/extraction/domain/verifiedField.test';
import {
  VerifiedFieldHandle,
  verifyFieldCandidate,
} from '@/lib/extraction/domain/verifiedField';
import type {
  FragmentArtifactId,
  TableChainArtifact,
  TableSegmentArtifact,
} from '@/lib/extraction/domain/types';
import { createSemanticColumnMapping } from '@/lib/interpretation/semanticColumnMapping';

describe('Step 3 authored-row quarantine compatibility', () => {
  it('keeps F-01 through F-04 authored values outside verified table mappings', async () => {
    const authoredRows: readonly AuthoredRateRowLike[] = [
      { source_kind: 'tdot_appendix_b_stitched_table', row_id: 'legacy:1' },
      { source_kind: 'mdot_section_905_bid_schedule', row_id: 'legacy:2' },
      { source_kind: 'exhibit_a_text_recovery', row_id: 'legacy:3' },
      { authoredValueCorrection: true, row_id: 'legacy:4' },
    ];
    expect(authoredRows.map((row) => authoredRateRowQuarantine(row)?.finding))
      .toEqual(['F-01', 'F-02', 'F-03', 'F-04']);

    const fixture = verifiedFieldFixture({
      fragment: { raw_text: '$80.00' },
      candidate: {
        raw_text: '$80.00',
        primitive_kind: 'text',
        proposed_value: { type: 'text', value: '$80.00' },
        transformations: [],
      },
    });
    const verified = await verifyFieldCandidate(fixture.candidate.id, fixture.repository);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const verifiedHandle = verified.handle;

    const segmentId = 'segment' as FragmentArtifactId;
    const segment = {
      id: segmentId,
      column_hypotheses: [{
        index: 0,
        x0: 0.1,
        x1: 0.2,
        header: {
          observed_text: 'Rate',
          normalized_label: 'rate',
          fragment_ids: ['fragment-1' as FragmentArtifactId],
          transformations: [],
        },
        value_kind_hypotheses: [{
          kind: 'currency',
          measurement: {
            value: 1,
            calculator: {
              stage: 'table_reconstruction',
              name: 'fixture',
              version: '1',
              configuration_hash: 'a'.repeat(64),
            },
            basis_artifact_ids: ['fragment-1' as FragmentArtifactId],
            diagnostics: [],
          },
        }],
      }],
    } as unknown as TableSegmentArtifact;
    const chain = {
      id: 'chain',
      segment_ids: [segmentId],
    } as unknown as TableChainArtifact;
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation',
      chain,
      segment,
      columnIndex: 0,
      evidence: {
        headerFields: [verifiedHandle],
        cellFields: [verifiedHandle],
      },
      ruleId: 'observed-column-evidence-v2',
    });

    expect(mapping.cell_verified_field_ids).toEqual([verified.verifiedField.id]);
    for (const authoredRow of authoredRows) {
      expect(() => VerifiedFieldHandle.fromVerified(authoredRow as never))
        .toThrow('VerifiedFieldHandle requires a dependency-verified field.');
      expect(() => createSemanticColumnMapping({
        interpretationSnapshotId: 'interpretation',
        chain,
        segment,
        columnIndex: 0,
        evidence: {
          headerFields: [verifiedHandle],
          cellFields: [authoredRow as never],
        },
        ruleId: 'observed-column-evidence-v2',
      })).toThrow('Semantic column mapping requires verified-field handles.');
    }
  });
});

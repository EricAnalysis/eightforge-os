import { describe, expect, it } from 'vitest';
import type {
  FragmentArtifactId,
  TableChainArtifact,
  TableSegmentArtifact,
  TableValueKind,
} from '@/lib/extraction/domain/types';
import {
  SEMANTIC_COLUMN_RULES,
  SemanticColumnMapping,
  createSemanticColumnMapping,
} from '@/lib/interpretation/semanticColumnMapping';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { verifiedFieldFixture } from '@/lib/extraction/domain/verifiedField.test';
import { verifyFieldCandidate } from '@/lib/extraction/domain/verifiedField';

async function verifiedText(value: string) {
  const fixture = verifiedFieldFixture({
    fragment: { raw_text: value },
    candidate: {
      raw_text: value,
      primitive_kind: 'text',
      proposed_value: { type: 'text', value },
      transformations: [],
    },
  });
  const result = await verifyFieldCandidate(fixture.candidate.id, fixture.repository);
  if (!result.ok) throw new Error(result.code);
  return result.handle;
}

const SEGMENT_ID = 'segment-1' as FragmentArtifactId;
const BASIS_ID = 'fragment-1' as FragmentArtifactId;

function segment(
  header = 'Rate',
  kind: TableValueKind = 'currency',
): TableSegmentArtifact {
  return {
    id: SEGMENT_ID,
    column_hypotheses: [{
      index: 0,
      x0: 0.1,
      x1: 0.3,
      header: {
        observed_text: header,
        normalized_label: header.toLowerCase(),
        fragment_ids: [BASIS_ID],
        transformations: [],
      },
      value_kind_hypotheses: [{
        kind,
        measurement: {
          value: 1,
          calculator: {
            stage: 'table_reconstruction',
            name: 'fixture',
            version: '1',
            configuration_hash: 'a'.repeat(64),
          },
          basis_artifact_ids: [BASIS_ID],
          diagnostics: [],
        },
      }],
    }],
  } as unknown as TableSegmentArtifact;
}

function chain(): TableChainArtifact {
  return {
    id: 'chain-1',
    segment_ids: [SEGMENT_ID],
  } as unknown as TableChainArtifact;
}

describe('semantic column mapping', () => {
  it('assigns a reordered physical column from observed header and value-kind evidence', async () => {
    const header = await verifiedText('Rate');
    const cell = await verifiedText('$ 1,250.00');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment(),
      columnIndex: 0,
      evidence: { headerFields: [header], cellFields: [cell] },
      ruleId: 'observed-column-evidence-v2',
    });
    expect(mapping).toMatchObject({
      domain_role: 'rate',
      status: 'resolved',
      column_index: 0,
    });
    expect(mapping.cell_verified_field_ids).toEqual([cell.field.id]);
  });

  it('leaves unsupported or conflicting header evidence ambiguous', async () => {
    const firstHeader = await verifiedText('Rate');
    const secondHeader = await verifiedText('Quantity');
    const cell = await verifiedText('$ 1,250.00');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment(),
      columnIndex: 0,
      evidence: {
        headerFields: [firstHeader, secondHeader],
        cellFields: [cell],
      },
      ruleId: 'observed-column-evidence-v2',
    });
    expect(mapping.status).toBe('ambiguous');
    expect(mapping.domain_role).toBe('other');
    expect(mapping.assessment.uncertainties).toContain('ambiguous_column_role');
  });

  it('does not force a role when verified fields conflict for the same cell source', async () => {
    const header = await verifiedText('Rate');
    const firstCell = await verifiedText('$100.00');
    const conflictingCell = await verifiedText('$200.00');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment(),
      columnIndex: 0,
      evidence: {
        headerFields: [header],
        cellFields: [firstCell, conflictingCell],
      },
      ruleId: 'observed-column-evidence-v2',
    });
    expect(mapping.status).toBe('ambiguous');
    expect(mapping.assessment.header_role.diagnostics)
      .toContain('conflicting_verified_fields_for_column_cell');
  });

  it('cannot accept or expose a replacement normalized value', async () => {
    const header = await verifiedText('Rate');
    const cell = await verifiedText('$ 1,250.00');
    const before = cell.field.normalized_value;
    if (false) {
      // @ts-expect-error SemanticColumnMapping has a private constructor.
      new SemanticColumnMapping();
      createSemanticColumnMapping({
        interpretationSnapshotId: 'interpretation-1',
        chain: chain(),
        segment: segment(),
        columnIndex: 0,
        evidence: { headerFields: [header], cellFields: [cell] },
        ruleId: 'observed-column-evidence-v2',
        // @ts-expect-error Mappings label columns; they have no value input.
        value: { type: 'decimal', value: '999999' },
      });
    }
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment(),
      columnIndex: 0,
      evidence: { headerFields: [header], cellFields: [cell] },
      ruleId: 'observed-column-evidence-v2',
    });
    expect('value' in mapping).toBe(false);
    expect(cell.field.normalized_value).toBe(before);
    expect(() => {
      (mapping.cell_verified_field_ids as unknown as string[]).push('forged');
    }).toThrow();
  });

  it('changes interpreter identity when column-role rules change', () => {
    const changed = {
      ...SEMANTIC_COLUMN_RULES,
      'observed-column-evidence-v2': {
        ...SEMANTIC_COLUMN_RULES['observed-column-evidence-v2'],
        version: '3',
      },
    };
    expect(hashCanonical(changed)).not.toBe(hashCanonical(SEMANTIC_COLUMN_RULES));
  });

  it('combines wrapped multi-row header phrases before role scoring', async () => {
    const firstHeader = await verifiedText('Unit');
    const secondHeader = await verifiedText('of Measure');
    const cell = await verifiedText('EA');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment('Unit of Measure', 'unit_token'),
      columnIndex: 0,
      evidence: {
        headerFields: [firstHeader, secondHeader],
        cellFields: [cell],
      },
      ruleId: 'observed-column-evidence-v2',
    });

    expect(mapping).toMatchObject({
      status: 'resolved',
      domain_role: 'unit',
    });
    expect(mapping.assessment.candidate_roles[0]).toMatchObject({
      role: 'unit',
      score: 1,
    });
  });

  it('distinguishes a combined origin/destination header from its atomic roles', async () => {
    const header = await verifiedText('Origin / Destination');
    const cell = await verifiedText('Transfer station');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment('Origin / Destination', 'free_text'),
      columnIndex: 0,
      evidence: { headerFields: [header], cellFields: [cell] },
      ruleId: 'observed-column-evidence-v2',
    });

    expect(mapping).toMatchObject({
      status: 'resolved',
      domain_role: 'origin_destination',
    });
  });

  it('uses leftmost numeric body evidence for row labels', async () => {
    const first = await verifiedText('1');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment('', 'integer'),
      columnIndex: 0,
      evidence: { headerFields: [], cellFields: [first] },
      ruleId: 'observed-column-evidence-v2',
    });

    expect(mapping).toMatchObject({
      status: 'resolved',
      domain_role: 'row_label',
    });
  });

  it('preserves ambiguity when header and repeated body evidence are insufficient', async () => {
    const cell = await verifiedText('Misc');
    const mapping = createSemanticColumnMapping({
      interpretationSnapshotId: 'interpretation-1',
      chain: chain(),
      segment: segment('', 'free_text'),
      columnIndex: 0,
      evidence: { headerFields: [], cellFields: [cell] },
      ruleId: 'observed-column-evidence-v2',
    });

    expect(mapping.status).toBe('ambiguous');
    expect(mapping.domain_role).toBe('other');
    expect(mapping.assessment.selected_role).toBeNull();
    expect(mapping.assessment.source_evidence[0]).toMatchObject({
      verified_field_id: cell.field.id,
      raw_text: 'Misc',
      source_fragment_ids: cell.field.source_fragment_ids,
    });
  });
});

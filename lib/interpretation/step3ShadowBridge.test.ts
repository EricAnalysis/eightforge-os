import { describe, expect, it } from 'vitest';

import type {
  FragmentArtifactId,
  TableChainArtifact,
  TableContinuationLink,
  TableSegmentArtifact,
} from '@/lib/extraction/domain/types';
import {
  buildStep3SemanticInterpretation,
  stableColumnGeometryPeers,
} from '@/lib/interpretation/step3ShadowBridge';
import { verifiedFieldFixture } from '@/lib/extraction/domain/verifiedField.test';
import { verifyFieldCandidate } from '@/lib/extraction/domain/verifiedField';

function segment(
  id: string,
  page: number,
  centers: readonly number[],
  headerText = 'Description',
): TableSegmentArtifact {
  return {
    id: id as FragmentArtifactId,
    page,
    reading_order: 1,
    bounding_box: {
      coordinate_space: 'page_normalized',
      origin: 'top_left',
      x0: 0.05,
      y0: 0.1,
      x1: 0.95,
      y1: 0.8,
      rotation: 0,
    },
    column_hypotheses: centers.map((center, index) => ({
      index,
      x0: center - 0.05,
      x1: center + 0.05,
      header: {
        observed_text: index === 0 ? headerText : 'Unit',
        normalized_label:
          index === 0 ? headerText.toLowerCase() : 'unit',
        fragment_ids: index === 0 && headerText
          ? ['fragment-1' as FragmentArtifactId]
          : [],
        transformations: [],
      },
      value_kind_hypotheses: [{
        kind: index === 0 ? 'free_text' : 'unit_token',
        measurement: {
          value: 1,
          basis_artifact_ids: ['fragment-1' as FragmentArtifactId],
        },
      }],
    })),
  } as unknown as TableSegmentArtifact;
}

function chain(id: string, segments: readonly TableSegmentArtifact[]) {
  return {
    id,
    segment_ids: segments.map(({ id: segmentId }) => segmentId),
    continuation_links: [],
  } as unknown as TableChainArtifact;
}

function continuation(
  from: TableSegmentArtifact,
  to: TableSegmentArtifact,
  decision: TableContinuationLink['decision'],
) {
  return {
    id: `link-${decision}`,
    from_segment_id: from.id,
    to_segment_id: to.id,
    decision,
  } as unknown as TableContinuationLink;
}

async function descriptionHandle() {
  const fixture = verifiedFieldFixture({
    fragment: { raw_text: 'Description' },
    candidate: {
      raw_text: 'Description',
      primitive_kind: 'text',
      proposed_value: { type: 'text', value: 'Description' },
      transformations: [],
    },
  });
  const result = await verifyFieldCandidate(
    fixture.candidate.id,
    fixture.repository,
  );
  if (!result.ok) throw new Error(result.code);
  return result.handle;
}

async function interpret(input: {
  readonly segments: readonly TableSegmentArtifact[];
  readonly chains: readonly TableChainArtifact[];
  readonly continuationLinks?: readonly TableContinuationLink[];
}) {
  return buildStep3SemanticInterpretation({
    extraction_snapshot_id: 'snapshot-1',
    chains: input.chains,
    continuation_links: input.continuationLinks ?? [],
    segments: input.segments,
    cells: [],
    verified_field_handles: [await descriptionHandle()],
    published_at: '2026-07-30T00:00:00.000Z',
  });
}

describe('Step 3 semantic bridge stable geometry evidence', () => {
  it('shows why the rejected document-scoped peer population contaminated chains', () => {
    const target = segment('target', 2, [0.25, 0.75]);
    const repeated = segment('repeated', 3, [0.27, 0.73]);
    const shifted = segment('shifted', 4, [0.4, 0.8]);
    const differentSchema = segment('different', 5, [0.2, 0.5, 0.8]);

    expect(stableColumnGeometryPeers(
      target.column_hypotheses[0]!,
      [differentSchema, shifted, repeated, target],
    ).map(({ segment: peer }) => peer.id)).toEqual([
      'target',
      'repeated',
    ]);
  });

  it('rejects an aligned header from an unrelated table chain', async () => {
    const header = segment('chain-a-header', 2, [0.25], 'Description');
    const headerless = segment('chain-b-headerless', 3, [0.25], '');
    const result = await interpret({
      segments: [header, headerless],
      chains: [chain('chain-a', [header]), chain('chain-b', [headerless])],
    });
    const mapping = result.semantic_column_mappings.find(
      (candidate) => candidate.table_segment_id === headerless.id,
    );

    expect(mapping).toMatchObject({
      table_chain_id: 'chain-b',
      status: 'ambiguous',
      header_verified_field_ids: [],
      peer_header_evidence: [],
    });
    expect(mapping?.peer_header_scope_rejections).toEqual([
      expect.objectContaining({
        peer_segment_id: header.id,
        peer_chain_id: 'chain-a',
        scope_classification:
          'outside_chain_and_linked_continuation_scope',
        rejection_reason:
          'different_chain_without_explicit_linked_continuation',
      }),
    ]);
    expect(
      (mapping?.assessment as {
        candidate_roles: readonly { score_components: readonly unknown[] }[];
      }).candidate_roles.flatMap(({ score_components }) => score_components),
    ).not.toContainEqual(expect.objectContaining({
      evidence: 'header_exact_alias:description',
    }));
  });

  it('retains a verified peer header inside one multi-segment chain', async () => {
    const header = segment('same-chain-header', 2, [0.25], 'Description');
    const headerless = segment('same-chain-headerless', 3, [0.27], '');
    const result = await interpret({
      segments: [header, headerless],
      chains: [chain('chain-a', [header, headerless])],
    });
    const mapping = result.semantic_column_mappings.find(
      (candidate) => candidate.table_segment_id === headerless.id,
    );

    expect(mapping).toMatchObject({
      table_chain_id: 'chain-a',
      status: 'resolved',
      domain_role: 'description',
      peer_header_evidence: [
        expect.objectContaining({
          target_segment_id: headerless.id,
          target_chain_id: 'chain-a',
          peer_segment_id: header.id,
          peer_chain_id: 'chain-a',
          scope_classification: 'same_table_chain',
          decisive: true,
          source_verified_field_ids: [expect.any(String)],
        }),
      ],
    });
  });

  it.each(['rejected', 'ambiguous'] as const)(
    'does not let a %s continuation decision authorize cross-chain sharing',
    async (decision) => {
      const header = segment(`header-${decision}`, 2, [0.25], 'Description');
      const headerless = segment(`headerless-${decision}`, 3, [0.25], '');
      const link = continuation(header, headerless, decision);
      const result = await interpret({
        segments: [header, headerless],
        chains: [
          chain('chain-a', [header]),
          chain('chain-b', [headerless]),
        ],
        continuationLinks: [link],
      });
      const mapping = result.semantic_column_mappings.find(
        (candidate) => candidate.table_segment_id === headerless.id,
      );

      expect(mapping).toMatchObject({
        status: 'ambiguous',
        peer_header_evidence: [],
        peer_header_scope_rejections: [
          expect.objectContaining({
            continuation_link_id: link.id,
            continuation_link_decision: decision,
          }),
        ],
      });
    },
  );
});

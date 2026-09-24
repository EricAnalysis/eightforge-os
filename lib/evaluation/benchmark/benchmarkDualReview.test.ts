import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_ADJUDICATION_AUTHORITY,
  BENCHMARK_ADJUDICATION_VERSION,
  BENCHMARK_REVIEWER_LABEL_AUTHORITY,
  BENCHMARK_REVIEWER_LABELS_VERSION,
  assembleResolvedBenchmarkLabels,
  compareBenchmarkReviewerLabels,
  finalizeBenchmarkAdjudication,
  parseBenchmarkAdjudication,
  parseBenchmarkDualReviewComparison,
  parseBenchmarkReviewerLabels,
  type BenchmarkAdjudicationResolution,
  type BenchmarkDualReviewBindingSource,
  type BenchmarkDualReviewComparison,
  type BenchmarkReviewerLabelSet,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  BenchmarkPageLabelsSchema,
  benchmarkLabelsDigest,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { parseBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';
import { assertComparisonOutputPath } from '@/scripts/evaluation/e3/compare-benchmark-reviewers';

const BOX = {
  coordinate_space: 'canonical_v1' as const,
  x_min: 10,
  y_min: 20,
  x_max: 50,
  y_max: 30,
};
const FRAME = {
  frame_version: 'canonical_frame_v1' as const,
  coordinate_space: 'canonical_v1' as const,
  view: [0, 0, 612, 792] as [number, number, number, number],
  rotation: 0 as const,
  user_unit: 1,
  width: 612,
  height: 792,
};
const SOURCE: BenchmarkDualReviewBindingSource = {
  pageKey: 'golden-p8',
  documentKey: 'golden',
  sha256: 'a'.repeat(64),
  byteLength: 1234,
  physicalPageNumber: 8,
  frame: FRAME,
};
const APPROVED_BY = 'human-owner';
const APPROVED_AT = '2026-09-24T12:00:00.000Z';

function reviewer(
  slot: 'reviewer_a' | 'reviewer_b',
  override: Partial<BenchmarkReviewerLabelSet> = {},
) {
  const artifact: BenchmarkReviewerLabelSet = {
    reviewerLabelSetVersion: BENCHMARK_REVIEWER_LABELS_VERSION,
    authority: BENCHMARK_REVIEWER_LABEL_AUTHORITY,
    reviewerSlot: slot,
    reviewerIdentity: slot === 'reviewer_a' ? 'chatgpt' : 'claude',
    independence: {
      inputMode: 'clean_source_page_only',
      sawMachineSuggestions: false,
      sawOtherReviewerLabels: false,
    },
    pageKey: SOURCE.pageKey,
    source: {
      documentKey: SOURCE.documentKey,
      sha256: SOURCE.sha256,
      byteLength: SOURCE.byteLength,
      physicalPageNumber: SOURCE.physicalPageNumber,
    },
    frame: FRAME,
    words: [{ reviewerItemId: `${slot}-w1`, readingOrder: 0, text: 'Debris', box: null }],
    cells: [{
      reviewerItemId: `${slot}-c1`,
      readingOrder: 0,
      text: 'Debris',
      box: null,
      isHeader: false,
      columnName: null,
    }],
    rows: [{
      reviewerRowId: `${slot}-r1`,
      readingOrder: 0,
      orderedCellReviewerItemIds: [`${slot}-c1`],
    }],
    coverageProposal: 'mixed_native_and_ocr',
    coverageNote: null,
    ...override,
  };
  return parseBenchmarkReviewerLabels(JSON.stringify(artifact));
}

function suggestions(options: Readonly<{
  words?: readonly { suggestionId: string; text: string; box: typeof BOX }[];
}> = {}) {
  return parseBenchmarkSuggestions(JSON.stringify({
    suggestionSetVersion: 'extraction-benchmark-suggestions-v1',
    authority: 'provisional_non_authoritative',
    pageKey: SOURCE.pageKey,
    source: {
      documentKey: SOURCE.documentKey,
      sha256: SOURCE.sha256,
      byteLength: SOURCE.byteLength,
      physicalPageNumber: SOURCE.physicalPageNumber,
    },
    frame: FRAME,
    sourceRun: {
      kind: 'benchmark_machine_pass',
      predictionDigest: 'd'.repeat(64),
      nativeTokenCount: 0,
      ocrTokenCount: 2,
      tokensWithoutCanonicalGeometry: 0,
    },
    words: options.words ?? [{ suggestionId: 'sw1', text: 'Debris', box: BOX }],
    cells: [{
      suggestionId: 'sc1',
      text: 'Debris',
      box: BOX,
      isHeader: true,
      columnName: 'Machine-only value',
    }],
    rows: [{ suggestionId: 'sr1', orderedCellSuggestionIds: ['sc1'] }],
  }));
}

function compare(options: Readonly<{
  reviewerA?: ReturnType<typeof reviewer>;
  reviewerB?: ReturnType<typeof reviewer>;
  suggestionArtifact?: ReturnType<typeof suggestions> | null;
}> = {}) {
  return compareBenchmarkReviewerLabels({
    reviewerA: options.reviewerA ?? reviewer('reviewer_a'),
    reviewerB: options.reviewerB ?? reviewer('reviewer_b'),
    source: SOURCE,
    suggestions: options.suggestionArtifact === undefined ? suggestions() : options.suggestionArtifact,
  });
}

function manualResolution(
  issue: BenchmarkDualReviewComparison['textDisagreements'][number],
): BenchmarkAdjudicationResolution {
  if (issue.kind === 'word') {
    return {
      issueId: issue.issueId,
      decision: 'manual_resolution',
      note: 'Explicit human word resolution',
      manualValue: { kind: 'word', text: 'Resolved word', box: BOX },
    };
  }
  if (issue.kind === 'cell') {
    return {
      issueId: issue.issueId,
      decision: 'manual_resolution',
      note: 'Explicit human cell resolution',
      manualValue: {
        kind: 'cell', text: 'Resolved cell', box: BOX, isHeader: false, columnName: null,
      },
    };
  }
  if (issue.kind === 'row') {
    return {
      issueId: issue.issueId,
      decision: 'manual_resolution',
      note: 'Explicit human row resolution',
      manualValue: { kind: 'row', orderedCellLabelIds: ['c-0001'] },
    };
  }
  return {
    issueId: issue.issueId,
    decision: 'manual_resolution',
    note: 'Explicit human coverage resolution',
    manualValue: { kind: 'coverage', truth: 'mixed_native_and_ocr', note: null },
  };
}

function resolutionsForAllIssues(
  compared: BenchmarkDualReviewComparison,
): BenchmarkAdjudicationResolution[] {
  const arrays = [
    compared.textDisagreements,
    compared.bboxDisagreements,
    compared.cellStructureDisagreements,
    compared.rowMembershipDisagreements,
    compared.coverageDisagreements,
    compared.ambiguousItems,
    compared.unmatchedReviewerA,
    compared.unmatchedReviewerB,
  ];
  return arrays.flat().map(manualResolution);
}

function prepare(options: Readonly<{
  reviewerA?: ReturnType<typeof reviewer>;
  reviewerB?: ReturnType<typeof reviewer>;
  compared?: BenchmarkDualReviewComparison;
  suggestionArtifact?: ReturnType<typeof suggestions> | null;
  resolutions?: BenchmarkAdjudicationResolution[];
  approvedBy?: string;
  approval?: boolean;
  approvedDigest?: string;
}> = {}) {
  const reviewerA = options.reviewerA ?? reviewer('reviewer_a');
  const reviewerB = options.reviewerB ?? reviewer('reviewer_b');
  const suggestionArtifact = options.suggestionArtifact === undefined
    ? suggestions()
    : options.suggestionArtifact;
  const compared = options.compared ?? compare({ reviewerA, reviewerB, suggestionArtifact });
  const parsedComparison = parseBenchmarkDualReviewComparison(JSON.stringify(compared));
  const resolutions = options.resolutions ?? resolutionsForAllIssues(compared);
  const approvedBy = options.approvedBy ?? APPROVED_BY;
  const assembled = assembleResolvedBenchmarkLabels({
    comparison: compared,
    resolutions,
    approvedBy,
    approvedAt: APPROVED_AT,
  });
  const adjudication = parseBenchmarkAdjudication(JSON.stringify({
    adjudicationVersion: BENCHMARK_ADJUDICATION_VERSION,
    authority: BENCHMARK_ADJUDICATION_AUTHORITY,
    pageKey: SOURCE.pageKey,
    source: {
      documentKey: SOURCE.documentKey,
      sha256: SOURCE.sha256,
      byteLength: SOURCE.byteLength,
      physicalPageNumber: SOURCE.physicalPageNumber,
    },
    frame: FRAME,
    comparisonSha256: parsedComparison.sha256,
    reviewerALabelSetSha256: reviewerA.sha256,
    reviewerBLabelSetSha256: reviewerB.sha256,
    suggestionsSha256: compared.suggestionsSha256,
    resolutions,
    approval: options.approval === false ? null : {
      decision: 'approve_as_benchmark_truth',
      approvedBy,
      approvedAt: APPROVED_AT,
      approvedCandidateSha256: options.approvedDigest ?? benchmarkLabelsDigest(assembled),
    },
  }));
  return {
    reviewerA, reviewerB, suggestionArtifact, compared, parsedComparison, resolutions,
    adjudication, assembled,
  };
}

function finalize(prepared: ReturnType<typeof prepare>) {
  return finalizeBenchmarkAdjudication({
    reviewerA: prepared.reviewerA,
    reviewerB: prepared.reviewerB,
    comparison: prepared.parsedComparison,
    adjudication: prepared.adjudication,
    source: SOURCE,
    suggestions: prepared.suggestionArtifact,
  });
}

describe('E3 dual-review labeling', () => {
  it('keeps reviewer artifacts non-authoritative and requires clean-page independence', () => {
    const valid = reviewer('reviewer_a');
    expect(valid.labels.authority).toBe('non_authoritative_reviewer_proposal');
    expect(() => parseBenchmarkReviewerLabels(JSON.stringify({
      ...valid.labels,
      independence: { ...valid.labels.independence, sawMachineSuggestions: true },
    }))).toThrow(/sawMachineSuggestions/);
    expect(() => parseBenchmarkReviewerLabels(JSON.stringify({
      ...valid.labels,
      independence: { ...valid.labels.independence, sawOtherReviewerLabels: true },
    }))).toThrow(/sawOtherReviewerLabels/);
    expect(() => parseBenchmarkReviewerLabels(JSON.stringify({
      ...valid.labels,
      independence: { ...valid.labels.independence, inputMode: 'suggestions_visible' },
    }))).toThrow(/inputMode/);
  });

  it('rejects reviewer artifacts bound to different source bytes, pages, or frames', () => {
    const base = reviewer('reviewer_b').labels;
    expect(() => compare({ reviewerB: reviewer('reviewer_b', {
      source: { ...base.source, sha256: 'b'.repeat(64) },
    }) })).toThrow(/source sha256 differs/);
    expect(() => compare({ reviewerB: reviewer('reviewer_b', { pageKey: 'other-page' }) }))
      .toThrow(/page key differs/);
    expect(() => compare({ reviewerB: reviewer('reviewer_b', {
      frame: { ...FRAME, width: 611 },
    }) })).toThrow(/canonical page frame differs/);
  });

  it('requires distinct reviewer slots and identities', () => {
    expect(() => compareBenchmarkReviewerLabels({
      reviewerA: reviewer('reviewer_b', { reviewerIdentity: 'reviewer-one' }),
      reviewerB: reviewer('reviewer_b'),
      source: SOURCE,
    })).toThrow(/reviewer_a followed by reviewer_b/);
    expect(() => compare({ reviewerB: reviewer('reviewer_b', { reviewerIdentity: 'chatgpt' }) }))
      .toThrow(/identities must be independent/);
  });

  it('attaches only unique exact OCR geometry after both semantic reviews agree', () => {
    const result = compare();
    expect(result.requiredAdjudicationIssueIds).toEqual([]);
    expect(result.candidateFinalLabels.words[0]).toMatchObject({ text: 'Debris', box: BOX });
    expect(result.candidateFinalLabels.cells[0]).toMatchObject({
      text: 'Debris', isHeader: false, columnName: null, box: BOX,
    });
    expect(result.exactAgreements.find((entry) => entry.matchKey === 'word:0')
      ?.geometryProvenance).toMatchObject({
      source: 'provisional_ocr', suggestionId: 'sw1',
    });
    expect(result.authority).toBe('non_authoritative_comparison');
    expect(result.userApprovalRequired).toBe(true);
  });

  it('fails closed on duplicate OCR geometry and repeated agreed text', () => {
    const duplicateOcr = compare({
      suggestionArtifact: suggestions({
        words: [
          { suggestionId: 'sw1', text: 'Debris', box: BOX },
          { suggestionId: 'sw2', text: 'Debris', box: { ...BOX, x_min: 60, x_max: 100 } },
        ],
      }),
    });
    expect(duplicateOcr.candidateFinalLabels.words).toEqual([]);
    expect(duplicateOcr.ambiguousItems.map((item) => item.issueId))
      .toContain('ambiguous-geometry-word:0');

    const repeatedA = reviewer('reviewer_a', {
      words: [
        { reviewerItemId: 'a-w1', readingOrder: 0, text: 'LS', box: null },
        { reviewerItemId: 'a-w2', readingOrder: 1, text: 'LS', box: null },
      ],
    });
    const repeatedB = reviewer('reviewer_b', {
      words: [
        { reviewerItemId: 'b-w1', readingOrder: 0, text: 'LS', box: null },
        { reviewerItemId: 'b-w2', readingOrder: 1, text: 'LS', box: null },
      ],
    });
    const repeated = compare({
      reviewerA: repeatedA,
      reviewerB: repeatedB,
      suggestionArtifact: suggestions({ words: [{ suggestionId: 'sw-ls', text: 'LS', box: BOX }] }),
    });
    expect(repeated.candidateFinalLabels.words).toEqual([]);
    expect(repeated.ambiguousItems.filter((item) => item.kind === 'word')).toHaveLength(2);
  });

  it('P4 counts repeated text at every semantic position, including a disagreement', () => {
    const reviewerA = reviewer('reviewer_a', {
      words: [
        { reviewerItemId: 'a-w1', readingOrder: 0, text: 'LS', box: null },
        { reviewerItemId: 'a-w2', readingOrder: 1, text: 'LS', box: null },
      ],
    });
    const reviewerB = reviewer('reviewer_b', {
      words: [
        { reviewerItemId: 'b-w1', readingOrder: 0, text: 'LS', box: null },
        { reviewerItemId: 'b-w2', readingOrder: 1, text: 'L5', box: null },
      ],
    });
    const result = compare({
      reviewerA,
      reviewerB,
      suggestionArtifact: suggestions({ words: [{ suggestionId: 'sw-ls', text: 'LS', box: BOX }] }),
    });
    expect(result.candidateFinalLabels.words).toEqual([]);
    expect(result.ambiguousItems.map((item) => item.issueId))
      .toContain('ambiguous-geometry-word:0');
    expect(result.textDisagreements.map((item) => item.issueId))
      .toContain('text-disagreement-word:1');
  });

  it('never fuzzy-matches reviewer text and preserves both submitted values', () => {
    const reviewerB = reviewer('reviewer_b', {
      words: [{ reviewerItemId: 'b-w1', readingOrder: 0, text: 'Debr1s', box: null }],
    });
    const result = compare({ reviewerB });
    expect(result.candidateFinalLabels.words).toEqual([]);
    expect(result.textDisagreements[0]).toMatchObject({
      reviewerA: { text: 'Debris' }, reviewerB: { text: 'Debr1s' },
    });
    expect(result.matchingRules.fuzzyMatching).toBe(false);
  });

  it('rejects a reviewer choice when that side has no value', () => {
    const reviewerA = reviewer('reviewer_a', {
      words: [
        { reviewerItemId: 'a-w1', readingOrder: 0, text: 'Debris', box: null },
        { reviewerItemId: 'a-w2', readingOrder: 1, text: 'Only A', box: BOX },
      ],
    });
    const compared = compare({ reviewerA });
    const issue = compared.unmatchedReviewerA.find((item) => item.matchKey === 'word:1')!;
    expect(() => assembleResolvedBenchmarkLabels({
      comparison: compared,
      resolutions: resolutionsForAllIssues(compared).map((resolution) => (
        resolution.issueId === issue.issueId
          ? { ...resolution, decision: 'choose_reviewer_b' as const, manualValue: null }
          : resolution
      )),
      approvedBy: APPROVED_BY,
      approvedAt: APPROVED_AT,
    })).toThrow(/selected a reviewer with no value/);
  });

  it('N1 excludes a trailing reviewer-only GHOST without changing reviewer artifacts', () => {
    const reviewerA = reviewer('reviewer_a', {
      words: [
        { reviewerItemId: 'a-w1', readingOrder: 0, text: 'Debris', box: BOX },
        { reviewerItemId: 'a-w2', readingOrder: 1, text: 'GHOST', box: BOX },
      ],
    });
    const reviewerB = reviewer('reviewer_b', {
      words: [{ reviewerItemId: 'b-w1', readingOrder: 0, text: 'Debris', box: BOX }],
    });
    const compared = compare({ reviewerA, reviewerB });
    const issue = compared.unmatchedReviewerA.find((item) => item.matchKey === 'word:1')!;
    const resolutions: BenchmarkAdjudicationResolution[] = [{
      issueId: issue.issueId,
      decision: 'exclude_item',
      note: 'User adjudicated that GHOST is not benchmark truth',
      manualValue: null,
    }];
    const prepared = prepare({ reviewerA, reviewerB, compared, resolutions });
    const result = finalize(prepared);

    expect(result.words.items.map((item) => item.text)).toEqual(['Debris']);
    expect(prepared.adjudication.resolutions[0]?.decision).toBe('exclude_item');
    expect(reviewerA.labels.words.map((item) => item.text)).toEqual(['Debris', 'GHOST']);
    expect(reviewerB.labels.words.map((item) => item.text)).toEqual(['Debris']);
  });

  it('N1c excludes the shifted duplicate and resolves a middle insertion without invention', () => {
    const reviewerA = reviewer('reviewer_a', {
      words: [
        { reviewerItemId: 'a-w1', readingOrder: 0, text: 'Qty', box: BOX },
        { reviewerItemId: 'a-w2', readingOrder: 1, text: 'EXTRA', box: BOX },
        { reviewerItemId: 'a-w3', readingOrder: 2, text: 'Unit', box: BOX },
        { reviewerItemId: 'a-w4', readingOrder: 3, text: 'Price', box: BOX },
      ],
    });
    const reviewerB = reviewer('reviewer_b', {
      words: [
        { reviewerItemId: 'b-w1', readingOrder: 0, text: 'Qty', box: BOX },
        { reviewerItemId: 'b-w2', readingOrder: 1, text: 'Unit', box: BOX },
        { reviewerItemId: 'b-w3', readingOrder: 2, text: 'Price', box: BOX },
      ],
    });
    const compared = compare({ reviewerA, reviewerB });
    const issueByMatchKey = new Map([
      ...compared.textDisagreements,
      ...compared.unmatchedReviewerA,
    ].map((issue) => [issue.matchKey, issue]));
    const resolutions: BenchmarkAdjudicationResolution[] = [
      {
        issueId: issueByMatchKey.get('word:1')!.issueId,
        decision: 'choose_reviewer_b',
        note: 'User retained Unit from reviewer B',
        manualValue: null,
      },
      {
        issueId: issueByMatchKey.get('word:2')!.issueId,
        decision: 'choose_reviewer_b',
        note: 'User retained Price from reviewer B',
        manualValue: null,
      },
      {
        issueId: issueByMatchKey.get('word:3')!.issueId,
        decision: 'exclude_item',
        note: 'User excluded the shifted duplicate Price item',
        manualValue: null,
      },
    ];
    const result = finalize(prepare({ reviewerA, reviewerB, compared, resolutions }));

    expect(result.words.items.map((item) => item.text)).toEqual(['Qty', 'Unit', 'Price']);
    expect(result.words.items).toHaveLength(3);
    expect(result.words.items.some((item) => item.text === 'EXTRA')).toBe(false);
  });

  it('rejects exclude_item for coverage issues that require an explicit value', () => {
    const reviewerB = reviewer('reviewer_b', { coverageProposal: 'requires_ocr' });
    const compared = compare({ reviewerB });
    const coverageIssue = compared.coverageDisagreements[0]!;
    expect(() => assembleResolvedBenchmarkLabels({
      comparison: compared,
      resolutions: [{
        issueId: coverageIssue.issueId,
        decision: 'exclude_item',
        note: 'Invalid attempt to omit global coverage truth',
        manualValue: null,
      }],
      approvedBy: APPROVED_BY,
      approvedAt: APPROVED_AT,
    })).toThrow(/exclude_item is valid only for word, cell, or row issues/);
  });

  it('fails closed when an excluded cell remains referenced by a retained row', () => {
    const reviewerA = reviewer('reviewer_a', {
      cells: [
        {
          reviewerItemId: 'a-c1', readingOrder: 0, text: 'Keep', box: BOX,
          isHeader: false, columnName: null,
        },
        {
          reviewerItemId: 'a-c2', readingOrder: 1, text: 'DROP', box: BOX,
          isHeader: false, columnName: null,
        },
      ],
      rows: [{
        reviewerRowId: 'a-r1',
        readingOrder: 0,
        orderedCellReviewerItemIds: ['a-c1', 'a-c2'],
      }],
    });
    const reviewerB = reviewer('reviewer_b', {
      cells: [{
        reviewerItemId: 'b-c1', readingOrder: 0, text: 'Keep', box: BOX,
        isHeader: false, columnName: null,
      }],
      rows: [{
        reviewerRowId: 'b-r1',
        readingOrder: 0,
        orderedCellReviewerItemIds: ['b-c1'],
      }],
    });
    const compared = compare({ reviewerA, reviewerB });
    const cellIssue = compared.unmatchedReviewerA.find((item) => item.matchKey === 'cell:1')!;
    const rowIssue = compared.rowMembershipDisagreements[0]!;
    expect(() => assembleResolvedBenchmarkLabels({
      comparison: compared,
      resolutions: [
        {
          issueId: cellIssue.issueId,
          decision: 'exclude_item',
          note: 'User excluded DROP',
          manualValue: null,
        },
        {
          issueId: rowIssue.issueId,
          decision: 'manual_resolution',
          note: 'Invalid retained row still references DROP',
          manualValue: {
            kind: 'row',
            orderedCellLabelIds: ['c-0001', 'c-0002'],
          },
        },
      ],
      approvedBy: APPROVED_BY,
      approvedAt: APPROVED_AT,
    })).toThrow(/retained row cites excluded or unresolved cell c-0002/);
  });

  it('P2 makes the explicit reviewer choice control the final payload and digest', () => {
    const reviewerA = reviewer('reviewer_a', {
      words: [{ reviewerItemId: 'a-w1', readingOrder: 0, text: 'Debris', box: BOX }],
    });
    const reviewerB = reviewer('reviewer_b', {
      words: [{ reviewerItemId: 'b-w1', readingOrder: 0, text: 'Debr1s', box: BOX }],
    });
    const compared = compare({ reviewerA, reviewerB });
    const issue = compared.textDisagreements[0]!;
    const resolutions = resolutionsForAllIssues(compared).map((resolution) => (
      resolution.issueId === issue.issueId
        ? {
          issueId: issue.issueId,
          decision: 'choose_reviewer_a' as const,
          note: 'Human selected reviewer A',
          manualValue: null,
        }
        : resolution
    ));
    const prepared = prepare({ reviewerA, reviewerB, compared, resolutions });
    expect(finalize(prepared).words.items[0]?.text).toBe('Debris');

    const wrongCandidate = {
      ...prepared.assembled,
      words: {
        status: 'labeled' as const,
        items: prepared.assembled.words.items.map((item) => ({ ...item, text: 'Debr1s' })),
      },
    };
    const staleApproval = {
      ...prepared,
      adjudication: {
        ...prepared.adjudication,
        approval: {
          ...prepared.adjudication.approval!,
          approvedCandidateSha256: benchmarkLabelsDigest(wrongCandidate),
        },
      },
    };
    expect(() => finalize(staleApproval)).toThrow(/approved candidate digest differs/);
  });

  it('P1 rejects invented zero-issue payloads and the removed resolvedFinalLabels field', () => {
    const prepared = prepare();
    expect(finalize(prepared).words.items[0]?.text).toBe('Debris');
    const invented = {
      ...prepared.assembled,
      words: {
        status: 'labeled' as const,
        items: prepared.assembled.words.items.map((item) => ({ ...item, text: 'INVENTED' })),
      },
    };
    expect(() => finalize({
      ...prepared,
      adjudication: {
        ...prepared.adjudication,
        approval: {
          ...prepared.adjudication.approval!,
          approvedCandidateSha256: benchmarkLabelsDigest(invented),
        },
      },
    })).toThrow(/approved candidate digest differs/);
    expect(() => parseBenchmarkAdjudication(JSON.stringify({
      ...prepared.adjudication,
      resolvedFinalLabels: invented,
    }))).toThrow(/Unrecognized key|unrecognized/i);
  });

  it('P3 recomputes the comparison and rejects a self-consistent hand edit', () => {
    const reviewerB = reviewer('reviewer_b', {
      words: [{ reviewerItemId: 'b-w1', readingOrder: 0, text: 'Debr1s', box: BOX }],
    });
    const compared = compare({ reviewerB });
    const stripped = {
      ...compared,
      textDisagreements: [],
      requiredAdjudicationIssueIds: compared.requiredAdjudicationIssueIds
        .filter((id) => !id.startsWith('text-disagreement-word:0')),
      candidateFinalLabels: {
        ...compared.candidateFinalLabels,
        words: [{ labelId: 'w-0001', text: 'Debris', box: BOX }],
      },
    };
    const prepared = prepare({ reviewerB, compared: stripped });
    expect(() => finalize(prepared)).toThrow(/supplied comparison differs from deterministic recomputation/);
  });

  it('requires approval and exactly one resolution for every issue', () => {
    const noApproval = prepare({ approval: false });
    expect(() => finalize(noApproval)).toThrow(/explicit user approval is absent/);

    const reviewerB = reviewer('reviewer_b', {
      words: [{ reviewerItemId: 'b-w1', readingOrder: 0, text: 'Debr1s', box: BOX }],
    });
    const compared = compare({ reviewerB });
    expect(() => assembleResolvedBenchmarkLabels({
      comparison: compared,
      resolutions: [],
      approvedBy: APPROVED_BY,
      approvedAt: APPROVED_AT,
    })).toThrow(/not every comparison issue has exactly one resolution/);
  });

  it('rejects stale reviewer and suggestion bindings', () => {
    const prepared = prepare();
    expect(() => finalize({
      ...prepared,
      adjudication: {
        ...prepared.adjudication,
        reviewerBLabelSetSha256: 'e'.repeat(64),
      },
    })).toThrow(/reviewer B digest differs/);
    expect(() => finalize({
      ...prepared,
      adjudication: {
        ...prepared.adjudication,
        suggestionsSha256: 'f'.repeat(64),
      },
    })).toThrow(/suggestions digest differs/);
    expect(() => finalize({ ...prepared, suggestionArtifact: null }))
      .toThrow(/supplied comparison differs|suggestions/);
  });

  it.each(['claude', 'Claude', ' CLAUDE '])(
    'P8 rejects reviewer identity as approver after trim and case-fold: %s',
    (approvedBy) => {
      const prepared = prepare({ approvedBy });
      expect(() => finalize(prepared)).toThrow(/approving user must not be either reviewer/);
    },
  );

  it('prevents the comparator command from targeting labels.json', () => {
    expect(() => assertComparisonOutputPath('C:/tmp/labels.json')).toThrow(/never writes labels.json/);
    expect(() => assertComparisonOutputPath('C:/tmp/LABELS.JSON')).toThrow(/never writes labels.json/);
    expect(() => assertComparisonOutputPath('C:/tmp/comparison.json')).not.toThrow();
  });

  it('round-trips canonical comparison and final-label digests', () => {
    const prepared = prepare();
    const compact = parseBenchmarkDualReviewComparison(JSON.stringify(prepared.compared));
    const pretty = parseBenchmarkDualReviewComparison(JSON.stringify(prepared.compared, null, 2));
    expect(compact.sha256).toBe(prepared.parsedComparison.sha256);
    expect(pretty.sha256).toBe(compact.sha256);
    expect(benchmarkLabelsDigest(finalize(prepared))).toBe(benchmarkLabelsDigest(prepared.assembled));
  });

  it('returns the existing BenchmarkPageLabelsSchema only after explicit approval', () => {
    const prepared = prepare();
    const result = finalize(prepared);
    expect(BenchmarkPageLabelsSchema.parse(result)).toEqual(prepared.assembled);
    expect(result.authority).toBe('human_evaluation_ground_truth_only');
    expect(result.labeledBy).toBe(APPROVED_BY);
  });
});

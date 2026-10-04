import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_DELEGATED_LABELED_BY,
  BENCHMARK_DELEGATED_LABEL_AUTHORITY,
  benchmarkLabelsDigest,
  buildBenchmarkLabelTemplate,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BENCHMARK_DELEGATED_APPROVAL_AUTHORITY,
  BENCHMARK_DELEGATED_APPROVAL_VERSION,
  BENCHMARK_DELEGATION_SCOPE,
  type BenchmarkDelegatedApproval,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  BenchmarkTrackedTruthError,
  TRACKED_APPROVALS_SUFFIX,
  TRACKED_LABELS_SUFFIX,
  verifyTrackedBenchmarkTruth,
  type TrackedBenchmarkTruth,
} from '@/lib/evaluation/benchmark/benchmarkTrackedTruth';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
  view: [0, 0, 612.48, 792], rotation: 0, user_unit: 1, width: 612.48, height: 792,
};
const SOURCE = {
  pageKey: 'golden-p8' as const, documentKey: 'golden',
  sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
  byteLength: 2_481_310, physicalPageNumber: 8, frame: FRAME,
};
const box = { coordinate_space: 'canonical_v1' as const, x_min: 10, y_min: 10, x_max: 40, y_max: 20 };

function labels(authority: 'human' | 'delegated'): BenchmarkPageLabels {
  return {
    ...buildBenchmarkLabelTemplate(SOURCE),
    ...(authority === 'delegated'
      ? { authority: BENCHMARK_DELEGATED_LABEL_AUTHORITY, labeledBy: BENCHMARK_DELEGATED_LABELED_BY, labeledAt: null }
      : { labeledBy: 'human-owner', labeledAt: '2026-09-28T12:00:00.000Z' }),
    words: { status: 'labeled', items: [{ labelId: 'w-0001', text: 'Rate', box }] },
    cells: { status: 'labeled', items: [{ labelId: 'c-0001', text: 'Rate', box, isHeader: true, columnName: 'Rate' }] },
    rows: { status: 'labeled', items: [{ rowKey: 'r-0001', orderedCellLabelIds: ['c-0001'] }] },
    coverage: { status: 'labeled', truth: 'requires_ocr', note: null },
  };
}

function approval(
  target: BenchmarkPageLabels,
  identity: 'chatgpt' | 'claude',
  overrides: Partial<BenchmarkDelegatedApproval> = {},
): BenchmarkDelegatedApproval {
  return {
    approvalVersion: BENCHMARK_DELEGATED_APPROVAL_VERSION,
    authority: BENCHMARK_DELEGATED_APPROVAL_AUTHORITY,
    delegationScope: BENCHMARK_DELEGATION_SCOPE,
    pageKey: target.pageKey,
    source: target.source,
    frame: target.frame,
    adjudicationSha256: '1'.repeat(64),
    comparisonSha256: '2'.repeat(64),
    reviewerALabelSetSha256: '3'.repeat(64),
    reviewerBLabelSetSha256: '4'.repeat(64),
    suggestionsSha256: '5'.repeat(64),
    candidateSha256: benchmarkLabelsDigest(target),
    candidateSummary: { words: 1, cells: 1, rows: 1, coverage: 'requires_ocr' },
    approverIdentity: identity,
    decision: 'approve',
    approvedAt: identity === 'chatgpt' ? '2026-09-28T12:00:00.000Z' : '2026-09-28T12:05:00.000Z',
    rationale: `${identity} recomputed and approved the candidate`,
    ...overrides,
  };
}

function delegatedPackage(
  mutate: (files: Record<string, BenchmarkDelegatedApproval>) => void = () => {},
  target: BenchmarkPageLabels = labels('delegated'),
): TrackedBenchmarkTruth {
  const files: Record<string, BenchmarkDelegatedApproval> = {
    'chatgpt.json': approval(target, 'chatgpt'),
    'claude.json': approval(target, 'claude'),
  };
  mutate(files);
  return {
    labelsFileName: 'golden-p8.labels.json',
    labelsBytes: JSON.stringify(target),
    approvals: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, JSON.stringify(value)])),
  };
}

const rejects = (truth: TrackedBenchmarkTruth, pattern: RegExp) => {
  expect(() => verifyTrackedBenchmarkTruth(truth)).toThrow(BenchmarkTrackedTruthError);
  expect(() => verifyTrackedBenchmarkTruth(truth)).toThrow(pattern);
};

describe('tracked delegated benchmark truth evidence', () => {
  it('accepts a complete delegated package whose approvals bind the exact labels digest', () => {
    const result = verifyTrackedBenchmarkTruth(delegatedPackage());
    expect(result.approvalEvidence).toBe('verified_delegated_dual_ai');
    expect(result.authority).toBe(BENCHMARK_DELEGATED_LABEL_AUTHORITY);
  });

  it('keeps human truth backward-compatible and free of approval files', () => {
    const human = labels('human');
    const result = verifyTrackedBenchmarkTruth({
      labelsFileName: 'golden-p8.labels.json', labelsBytes: JSON.stringify(human), approvals: null,
    });
    expect(result.approvalEvidence).toBe('not_required_human_authority');
    rejects({ labelsFileName: 'golden-p8.labels.json', labelsBytes: JSON.stringify(human), approvals: {} },
      /human-authority truth must not carry delegated approval evidence/);
  });

  it('rejects missing evidence and a single approval', () => {
    rejects({ ...delegatedPackage(), approvals: null }, /requires committed approval evidence/);
    rejects(delegatedPackage((files) => { delete files['claude.json']; }), /must be exactly chatgpt\.json \+ claude\.json/);
  });

  it('rejects duplicated identities', () => {
    const target = labels('delegated');
    rejects(delegatedPackage((files) => { files['claude.json'] = approval(target, 'chatgpt'); }, target),
      /identities must be distinct/);
  });

  it('rejects any decision other than approve', () => {
    rejects(delegatedPackage((files) => { files['claude.json']!.decision = 'reject'; }), /decision is reject/);
    rejects(delegatedPackage((files) => { files['chatgpt.json']!.decision = 'unresolved'; }), /decision is unresolved/);
  });

  it('rejects an approval whose candidate digest is not the labels digest', () => {
    rejects(delegatedPackage((files) => { files['claude.json']!.candidateSha256 = 'f'.repeat(64); }),
      /candidateSha256 differs from labels digest/);
  });

  it('rejects labels changed after approval', () => {
    const approved = labels('delegated');
    const changed: BenchmarkPageLabels = {
      ...approved,
      words: { status: 'labeled', items: [{ labelId: 'w-0001', text: 'Rates', box }] },
    };
    const truth = delegatedPackage(() => {}, approved);
    rejects({ ...truth, labelsBytes: JSON.stringify(changed) }, /candidateSha256 differs from labels digest/);
  });

  it('rejects page, source, frame and approval-chain binding differences', () => {
    rejects(delegatedPackage((files) => { files['claude.json']!.pageKey = 'hillsdale-p3'; }), /page key differs/);
    rejects(delegatedPackage((files) => {
      files['claude.json']!.source = { ...files['claude.json']!.source, byteLength: 1 };
    }), /source differs/);
    rejects(delegatedPackage((files) => {
      files['claude.json']!.frame = { ...files['claude.json']!.frame, rotation: 90 };
    }), /frame differs/);
    rejects(delegatedPackage((files) => { files['claude.json']!.adjudicationSha256 = 'e'.repeat(64); }),
      /bind different adjudicationSha256/);
  });

  it('rejects truth bound to a different source than the registry pins', () => {
    const base = labels('delegated');
    const wrong: BenchmarkPageLabels = { ...base, source: { ...base.source, sha256: 'a'.repeat(64) } };
    rejects(delegatedPackage(() => {}, wrong), /source sha256 differs from the registry/);
  });

  it('rejects delegated labels that claim an unsupported page', () => {
    const unsupported = { ...labels('delegated'), pageKey: 'golden-p9' };
    rejects({ labelsFileName: 'golden-p9.labels.json', labelsBytes: JSON.stringify(unsupported), approvals: null },
      /delegated labels require a frozen E3 benchmark page/);
  });

  it('rejects a labels file whose name does not match its page', () => {
    rejects({ ...delegatedPackage(), labelsFileName: 'hillsdale-p3.labels.json' }, /file name must be golden-p8\.labels\.json/);
  });
});

describe('committed benchmark truth in lib/evaluation/benchmark/labels', () => {
  it('passes evidence verification for every committed page and leaves no orphaned approvals', async () => {
    const directory = path.resolve('lib/evaluation/benchmark/labels');
    expect(existsSync(path.join(directory, 'README.md'))).toBe(true);
    const entries = await readdir(directory, { withFileTypes: true });
    const labelFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(TRACKED_LABELS_SUFFIX));
    const approvalDirs = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(TRACKED_APPROVALS_SUFFIX));
    for (const dir of approvalDirs) {
      const pageKey = dir.name.slice(0, -TRACKED_APPROVALS_SUFFIX.length);
      expect(labelFiles.map((file) => file.name)).toContain(`${pageKey}${TRACKED_LABELS_SUFFIX}`);
    }
    for (const file of labelFiles) {
      const pageKey = file.name.slice(0, -TRACKED_LABELS_SUFFIX.length);
      const approvalsDir = path.join(directory, `${pageKey}${TRACKED_APPROVALS_SUFFIX}`);
      let approvals: Record<string, Buffer> | null = null;
      if (existsSync(approvalsDir)) {
        approvals = {};
        for (const name of await readdir(approvalsDir)) {
          approvals[name] = await readFile(path.join(approvalsDir, name));
        }
      }
      const labelsBytes = await readFile(path.join(directory, file.name));
      expect(() => verifyTrackedBenchmarkTruth({ labelsFileName: file.name, labelsBytes, approvals }))
        .not.toThrow();
    }
  });
});

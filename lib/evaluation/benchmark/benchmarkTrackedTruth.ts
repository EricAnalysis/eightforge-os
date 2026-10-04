import {
  BENCHMARK_DELEGATED_LABEL_AUTHORITY,
  BENCHMARK_LABEL_AUTHORITY,
  benchmarkLabelsDigest,
  benchmarkPage,
  parseBenchmarkLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BenchmarkDelegatedApprovalSchema,
  E3_BENCHMARK_DELEGATED_APPROVAL,
  type BenchmarkDelegatedApproval,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import { hashCanonical } from '@/lib/extraction/domain/hash';

/**
 * Evidence-integrity check for committed benchmark truth.
 *
 * Committed truth lives in `lib/evaluation/benchmark/labels/<pageKey>.labels.json`.
 * Delegated (dual-AI) truth must be committed together with the two approval
 * artifacts that authorized it, in `<pageKey>.approvals/chatgpt.json` and
 * `<pageKey>.approvals/claude.json`. Human-approved truth needs no approval files.
 *
 * This proves the committed files are internally consistent: both approvals
 * approve exactly this labels digest and page identity. It is NOT
 * authentication: approver identities are self-asserted strings, and nothing
 * here proves which system wrote an approval file.
 */

export const TRACKED_LABELS_SUFFIX = '.labels.json';
export const TRACKED_APPROVALS_SUFFIX = '.approvals';
export const TRACKED_APPROVAL_FILE_NAMES = Object.freeze(
  E3_BENCHMARK_DELEGATED_APPROVAL.approverIdentities.map((identity) => `${identity}.json`),
);

export class BenchmarkTrackedTruthError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`BENCHMARK_TRACKED_TRUTH_INVALID: ${problems.join('; ')}`);
    this.name = 'BenchmarkTrackedTruthError';
  }
}

export type TrackedBenchmarkTruth = Readonly<{
  labelsFileName: string;
  labelsBytes: Uint8Array | string;
  /** File name -> bytes for `<pageKey>.approvals/`, or null when that directory is absent. */
  approvals: Readonly<Record<string, Uint8Array | string>> | null;
}>;

export type TrackedBenchmarkTruthResult = Readonly<{
  pageKey: string;
  authority: string;
  labelsSha256: string;
  approvalEvidence: 'not_required_human_authority' | 'verified_delegated_dual_ai';
}>;

const CHAIN_FIELDS = [
  'adjudicationSha256',
  'comparisonSha256',
  'reviewerALabelSetSha256',
  'reviewerBLabelSetSha256',
  'suggestionsSha256',
] as const;

export function verifyTrackedBenchmarkTruth(truth: TrackedBenchmarkTruth): TrackedBenchmarkTruthResult {
  const problems: string[] = [];
  let parsed: ReturnType<typeof parseBenchmarkLabels>;
  try {
    parsed = parseBenchmarkLabels(truth.labelsBytes);
  } catch (error) {
    throw new BenchmarkTrackedTruthError([
      `${truth.labelsFileName}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const { labels, labelsSha256 } = parsed;

  if (truth.labelsFileName !== `${labels.pageKey}${TRACKED_LABELS_SUFFIX}`) {
    problems.push(`${truth.labelsFileName}: file name must be ${labels.pageKey}${TRACKED_LABELS_SUFFIX}`);
  }
  const page = benchmarkPage(labels.pageKey);
  if (!page) {
    problems.push(`${labels.pageKey}: not a registered E3 benchmark page`);
  } else {
    if (labels.source.documentKey !== page.documentKey) problems.push('document key differs from the registry');
    if (labels.source.sha256 !== page.sha256) problems.push('source sha256 differs from the registry');
    if (labels.source.physicalPageNumber !== page.physicalPageNumber) {
      problems.push('physical page differs from the registry');
    }
  }

  if (labels.authority === BENCHMARK_LABEL_AUTHORITY) {
    if (truth.approvals !== null) {
      problems.push('human-authority truth must not carry delegated approval evidence');
    }
    if (problems.length > 0) throw new BenchmarkTrackedTruthError(problems);
    return {
      pageKey: labels.pageKey, authority: labels.authority, labelsSha256,
      approvalEvidence: 'not_required_human_authority',
    };
  }

  if (labels.authority !== BENCHMARK_DELEGATED_LABEL_AUTHORITY) {
    problems.push(`unsupported truth authority ${String(labels.authority)}`);
    throw new BenchmarkTrackedTruthError(problems);
  }
  if (!(E3_BENCHMARK_DELEGATED_APPROVAL.pageKeys as readonly string[]).includes(labels.pageKey)) {
    problems.push(`${labels.pageKey}: delegated truth is outside the E3 delegated page scope`);
  }
  if (truth.approvals === null) {
    problems.push('delegated truth requires committed approval evidence');
    throw new BenchmarkTrackedTruthError(problems);
  }

  const fileNames = Object.keys(truth.approvals).sort();
  const expectedNames = [...TRACKED_APPROVAL_FILE_NAMES].sort();
  if (hashCanonical(fileNames) !== hashCanonical(expectedNames)) {
    problems.push(`approval evidence must be exactly ${expectedNames.join(' + ')}; found ${fileNames.join(', ') || 'none'}`);
  }

  const approvals: BenchmarkDelegatedApproval[] = [];
  for (const name of fileNames) {
    let json: unknown;
    try {
      const raw = truth.approvals[name]!;
      json = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      problems.push(`${name}: not JSON`);
      continue;
    }
    const result = BenchmarkDelegatedApprovalSchema.safeParse(json);
    if (!result.success) {
      problems.push(`${name}: schema invalid: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
      continue;
    }
    const approval = result.data;
    if (`${approval.approverIdentity}.json` !== name) {
      problems.push(`${name}: approverIdentity ${approval.approverIdentity} does not match its file name`);
    }
    approvals.push(approval);
  }

  const identities = approvals.map((approval) => approval.approverIdentity);
  if (new Set(identities).size !== identities.length) problems.push('approval identities must be distinct');
  const counts = {
    words: labels.words.items.length,
    cells: labels.cells.items.length,
    rows: labels.rows.items.length,
    coverage: labels.coverage.truth,
  };
  for (const approval of approvals) {
    const who = `approval ${approval.approverIdentity}`;
    if (approval.decision !== 'approve') problems.push(`${who}: decision is ${approval.decision}, not approve`);
    if (approval.candidateSha256 !== labelsSha256) problems.push(`${who}: candidateSha256 differs from labels digest`);
    if (approval.pageKey !== labels.pageKey) problems.push(`${who}: page key differs`);
    if (hashCanonical(approval.source) !== hashCanonical(labels.source)) problems.push(`${who}: source differs`);
    if (hashCanonical(approval.frame) !== hashCanonical(labels.frame)) problems.push(`${who}: frame differs`);
    if (hashCanonical(approval.candidateSummary) !== hashCanonical(counts)) {
      problems.push(`${who}: candidate summary differs from labels`);
    }
  }
  if (approvals.length === 2) {
    for (const field of CHAIN_FIELDS) {
      if (approvals[0]![field] !== approvals[1]![field]) {
        problems.push(`approvals bind different ${field}`);
      }
    }
  }
  if (labelsSha256 !== benchmarkLabelsDigest(labels)) problems.push('labels digest is not reproducible');

  if (problems.length > 0) throw new BenchmarkTrackedTruthError(problems);
  return {
    pageKey: labels.pageKey, authority: labels.authority, labelsSha256,
    approvalEvidence: 'verified_delegated_dual_ai',
  };
}

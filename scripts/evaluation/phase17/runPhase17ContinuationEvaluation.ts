/**
 * Phase 17 live Forgewing behavioral evaluation -- explicit, manual command.
 *
 *   npm run eval:phase17-continuation                      # dry run, zero provider calls
 *   npm run eval:phase17-continuation -- --execute-provider --max-calls 48 \
 *     --input-usd-per-mtok <confirmed> --output-usd-per-mtok <confirmed>
 *
 * Live execution sends DN page-106 bounded recovery evidence to Anthropic and
 * requires explicit user authorization for that specific run. See
 * docs/runbooks/phase-17-live-forgewing-evaluation.md.
 *
 * A missing corpus is a failure, never a skip. Nothing here writes to a
 * database, creates a proposal, or changes any qualification constant.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runPhase17ContinuationEvaluation }
  from '@/lib/evaluation/forgewing/phase17/phase17Run';

const DEFAULT_LABELS = 'lib/evaluation/fixtures/dnContinuationLabels.v1.json';
const DEFAULT_ARTIFACT_ROOT = 'scripts/evaluation/artifacts/phase17';
const VALUE_FLAGS = new Set([
  '--max-calls', '--max-spend-usd', '--input-usd-per-mtok', '--output-usd-per-mtok',
  '--labels', '--artifact-root',
]);
const BOOLEAN_FLAGS = new Set(['--execute-provider']);

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (BOOLEAN_FLAGS.has(flag)) {
      parsed.set(flag, true);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      parsed.set(flag, value);
      index += 1;
    } else {
      // Unknown flags fail: a mistyped ceiling must never fall back to a default.
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return parsed;
}

function numberFlag(args: Map<string, string | true>, flag: string): number | null {
  const raw = args.get(flag);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(value)) throw new Error(`${flag} must be a number`);
  return value;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const live = args.get('--execute-provider') === true;
  const repoRoot = process.cwd();
  const corpusPath = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
  if (!corpusPath) {
    throw new Error('DN_PRICED_SCHEDULE_SOURCE_PDF is required: Phase 17 evaluates the pinned '
      + 'DN corpus and must not pass or skip without it.');
  }
  const labelsPath = path.resolve(repoRoot, String(args.get('--labels') ?? DEFAULT_LABELS));
  const artifactRoot = path.resolve(repoRoot, String(args.get('--artifact-root') ?? DEFAULT_ARTIFACT_ROOT));

  const seams = live ? await import('./phase17ProductionSeams') : null;
  const outcome = await runPhase17ContinuationEvaluation({
    mode: live ? 'provider_enabled' : 'dry_run',
    corpusBytes: new Uint8Array(readFileSync(path.resolve(corpusPath))),
    labelBytes: readFileSync(labelsPath),
    repoRoot,
    artifactRoot,
    codeState: {
      commitSha: git(['rev-parse', 'HEAD']),
      treeClean: git(['status', '--porcelain', '--untracked-files=no']) === '',
    },
    env: process.env,
    maxCalls: numberFlag(args, '--max-calls'),
    maxSpendUsd: numberFlag(args, '--max-spend-usd'),
    inputUsdPerMillionTokens: numberFlag(args, '--input-usd-per-mtok'),
    outputUsdPerMillionTokens: numberFlag(args, '--output-usd-per-mtok'),
  }, seams ? {
    projectDurableProposal: seams.phase17ProjectDurableProposal,
    scheduleRecovery: seams.phase17ScheduleRecovery,
  } : {});

  const { summary, freeze } = outcome;
  process.stdout.write([
    `PHASE 17 ${live ? 'LIVE' : 'DRY RUN'} ${outcome.runId}`,
    `  freeze:   ${outcome.freezePath} (${outcome.freezeSha256})`,
    `  summary:  ${outcome.summaryPath}`,
    ...(outcome.localRawPath ? [`  local raw (never commit): ${outcome.localRawPath}`] : []),
    `  labels:   ${freeze.labelState}`,
    `  planned:  ${freeze.callPlan.plannedCalls} calls; executed ${summary.accounting.executedCalls}; `
      + `provider invocations ${summary.accounting.providerInvocations}`,
    `  est. max spend: ${freeze.cost.estimatedMaxSpendUsd === null ? 'pricing not supplied'
      : `$${freeze.cost.estimatedMaxSpendUsd.toFixed(4)}`} (ceiling $${freeze.cost.maxSpendUsd})`,
    `  qualification: ${summary.qualification.state}`,
    `  production qualification recommendable: ${summary.qualification.productionQualificationRecommendable}`
      + ' (recommendation only; promotionAuthorized=false)',
    '',
  ].join('\n'));
}

main().catch((error: unknown) => {
  process.stderr.write(`PHASE 17 FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

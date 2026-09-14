/**
 * Phase 17 human labeling support. Deterministic and offline.
 *
 *   npm run eval:phase17-labels                     # validate the committed label artifact
 *   npm run eval:phase17-labels -- --write-template # create it if, and only if, absent
 *
 * Always writes a LOCAL labeling workbook (gitignored) showing each ambiguous
 * fragment beside its two candidate target rows, so a person can read the
 * source and record `expected`. This script never chooses an answer, never
 * overwrites an existing label artifact, and has no provider access.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildPhase17DnCohort } from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import {
  bindPhase17Labels,
  buildPhase17LabelTemplate,
  parsePhase17LabelSet,
  serializePhase17LabelSet,
} from '@/lib/evaluation/forgewing/phase17/dnContinuationLabels';

const LABELS = 'lib/evaluation/fixtures/dnContinuationLabels.v1.json';
const WORKBOOK = 'scripts/evaluation/artifacts/phase17/labeling/local/labeling-workbook.md';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg !== '--write-template') throw new Error(`unknown argument ${arg}`);
  }
  const corpusPath = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
  if (!corpusPath) throw new Error('DN_PRICED_SCHEDULE_SOURCE_PDF is required');
  const repoRoot = process.cwd();
  const cohort = await buildPhase17DnCohort(new Uint8Array(readFileSync(path.resolve(corpusPath))));
  const labelsPath = path.join(repoRoot, LABELS);

  if (args.includes('--write-template')) {
    if (existsSync(labelsPath)) {
      throw new Error(`${LABELS} already exists; human labels are never overwritten`);
    }
    writeFileSync(labelsPath, serializePhase17LabelSet(buildPhase17LabelTemplate(cohort)),
      { encoding: 'utf8', flag: 'wx' });
  }
  const bound = bindPhase17Labels(parsePhase17LabelSet(readFileSync(labelsPath)), cohort);

  const lines = [
    '# Phase 17 DN continuation labeling workbook',
    '',
    'LOCAL ONLY -- contains source text. Never commit.',
    '',
    `Corpus sha256 ${cohort.corpusSha256}, physical page 106.`,
    'For each unit, read the source page and decide which target row the withheld',
    'fragment continues. Record the candidateId, or `human_indeterminate` if the source',
    `does not let a person decide, in ${LABELS} with labeledBy and labeledAt.`,
    '',
  ];
  for (const unit of cohort.units) {
    const label = bound.labelSet.units.find((entry) => entry.unitKey === unit.unitKey)!;
    lines.push(`## ${unit.unitKey}${unit.nearIdentical ? ' (near-identical targets)' : ''}`, '');
    lines.push(`Fragment: \`${unit.canonicalCandidates[0]!.composedRawText}\``, '');
    for (const candidate of unit.canonicalCandidates) {
      lines.push(`- ${candidate.candidateId}`);
      lines.push(`  - target row ${candidate.targetRowIdentity}: `
        + `\`${candidate.targetContextEvidence?.composedRawText ?? ''}\``);
    }
    lines.push('', `Current label: ${label.expected ?? 'UNLABELED'}`, '');
  }
  const workbookPath = path.join(repoRoot, WORKBOOK);
  mkdirSync(path.dirname(workbookPath), { recursive: true });
  writeFileSync(workbookPath, `${lines.join('\n')}\n`, 'utf8');

  process.stdout.write(`PHASE 17 LABELS: ${bound.state} (${bound.unlabeledUnitKeys.length} unlabeled of `
    + `${cohort.units.length}); bound to ${cohort.units.length * 2} candidate ids\n`
    + `  local workbook (never commit): ${workbookPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`PHASE 17 LABELS FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

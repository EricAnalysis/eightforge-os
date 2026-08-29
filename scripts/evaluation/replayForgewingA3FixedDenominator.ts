/** Provider-free fixed-denominator replay for the preserved A3 primitive-coverage experiment. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { ForgewingLabelledPricingA3Artifact } from '@/scripts/evaluation/runForgewingLabelledPricingA3';
import { summarizeFixedDenominatorPrimaryMetrics, summarizePrimitiveCoverage } from
  '@/scripts/evaluation/runForgewingA3PrimitiveCoverageExperiment';

const EXPECTED_EXPERIMENT_SHA256 = '6d1d2edeb806f8313adf987de7280ccba37e0a141cb78e354de6c9731d2f38ad';
const EXPECTED_EXPERIMENT_RUN_ID = 'forgewing-labelled-a3-145b8d691d7885e4b90d5f049e95f591';

type PreservedExperimentArtifact = Readonly<{
  experimentVersion: string;
  authority: 'non_authoritative_measurement';
  promotionEvidence: false;
  promotionAuthorized: false;
  runIdentity: Readonly<{ runId: string }>;
  baselineArtifactIdentity: Readonly<{ path: string; sha256: string; runId: string }>;
  treatmentArtifact: ForgewingLabelledPricingA3Artifact;
}>;

export function replayA3FixedDenominatorExperiment(params: {
  experimentPath: string;
  outputPath: string;
}): Readonly<Record<string, unknown>> {
  const experimentPath = resolve(params.experimentPath);
  const experimentBytes = readFileSync(experimentPath);
  const experimentSha256 = sha256Hex(experimentBytes);
  if (experimentSha256 !== EXPECTED_EXPERIMENT_SHA256) {
    throw new Error('A3_FIXED_DENOMINATOR_EXPERIMENT_SHA256_MISMATCH');
  }
  const experiment = JSON.parse(experimentBytes.toString('utf8')) as PreservedExperimentArtifact;
  if (experiment.runIdentity.runId !== EXPECTED_EXPERIMENT_RUN_ID
    || experiment.authority !== 'non_authoritative_measurement'
    || experiment.promotionEvidence !== false || experiment.promotionAuthorized !== false) {
    throw new Error('A3_FIXED_DENOMINATOR_EXPERIMENT_IDENTITY_MISMATCH');
  }
  const baselinePath = resolve(experiment.baselineArtifactIdentity.path);
  const baselineBytes = readFileSync(baselinePath);
  const baselineSha256 = sha256Hex(baselineBytes);
  if (baselineSha256 !== experiment.baselineArtifactIdentity.sha256) {
    throw new Error('A3_FIXED_DENOMINATOR_BASELINE_SHA256_MISMATCH');
  }
  const baseline = JSON.parse(baselineBytes.toString('utf8')) as ForgewingLabelledPricingA3Artifact;
  if (baseline.runIdentity.runId !== experiment.baselineArtifactIdentity.runId) {
    throw new Error('A3_FIXED_DENOMINATOR_BASELINE_IDENTITY_MISMATCH');
  }
  const artifact = {
    reportVersion: 'forgewing-a3-fixed-denominator-replay-v1',
    authority: 'non_authoritative_measurement',
    promotionEvidence: false,
    promotionAuthorized: false,
    providerCalls: 0,
    sourceExperimentArtifactIdentity: { path: experimentPath, sha256: experimentSha256,
      experimentVersion: experiment.experimentVersion, runId: experiment.runIdentity.runId },
    baselineArtifactIdentity: { path: baselinePath, sha256: baselineSha256,
      runId: baseline.runIdentity.runId },
    denominatorSource: 'validated_frozen_candidate_linked_labels',
    fieldOutcomeContract: ['CORRECT', 'INCORRECT_CONTRADICTORY_ROLE',
      'INSUFFICIENT_SEMANTIC_SUPPORT', 'UNSCORED'],
    controlVsTreatment: {
      baseline: summarizeFixedDenominatorPrimaryMetrics(baseline, summarizePrimitiveCoverage(baseline)),
      treatment: summarizeFixedDenominatorPrimaryMetrics(experiment.treatmentArtifact,
        summarizePrimitiveCoverage(experiment.treatmentArtifact)),
    },
    historicalArtifactPreserved: true,
    limitations: ['reporting_replay_only', 'no_provider_calls',
      'two_candidate_experiment_does_not_authorize_production_prompt_change'],
  } as const;
  const outputPath = resolve(params.outputPath);
  const outputBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, outputBytes, { encoding: 'utf8', flag: 'wx' });
  if (readFileSync(outputPath, 'utf8') !== outputBytes) {
    throw new Error('A3_FIXED_DENOMINATOR_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED');
  }
  return artifact;
}

export function main(): void {
  const { values } = parseArgs({ strict: true, options: {
    experiment: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.experiment || !values.output) {
    throw new Error('A3_FIXED_DENOMINATOR_MISSING_ARGUMENT');
  }
  replayA3FixedDenominatorExperiment({ experimentPath: values.experiment, outputPath: values.output });
  process.stdout.write(`${resolve(values.output)}\n`);
}

if (process.env.FORGEWING_A3_FIXED_DENOMINATOR_REPLAY_CLI === '1') {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

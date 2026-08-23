/**
 * Evaluation-only labelled A3 orchestrator.
 *
 * This freezes the real A2 candidate set before any provider work, audits the
 * label package, and emits a durable non-authoritative report. Labels without
 * a valid exact-byte attestation stop before provider invocation. Exact
 * candidate-to-label linkage is a separate mandatory gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  auditLabelledPricingA3Ledger,
  FORGEWING_LABELLED_PRICING_A3_VERSION,
} from '@/lib/evaluation/forgewing/labelledPricingA3';
import {
  validateForgewingLabelAttestation,
  type ForgewingLabelAttestationValidation,
} from '@/lib/evaluation/forgewing/labelledPricingAttestation';
import {
  validateForgewingLabelLinkage,
  type ForgewingCandidateLabelLinkage,
} from '@/lib/evaluation/forgewing/labelledPricingLinkage';
import { parseRatePageRanges } from '@/lib/contracts/parseRatePageRanges';
import {
  prepareForgewingPricingCorpus,
  type ForgewingPricingCorpusEntry,
} from '@/scripts/evaluation/runForgewingPricingCorpus';

const DEFAULT_CALL_BUDGET = 10;

export type ForgewingLabelledPricingA3Artifact = Readonly<{
  reportVersion: typeof FORGEWING_LABELLED_PRICING_A3_VERSION;
  authority: 'non_authoritative_measurement';
  promotionEvidence: false;
  runIdentity: Readonly<{ runId: string; createdAt: string }>;
  sourceIdentity: Readonly<{
    path: string;
    sha256: string;
    byteLength: number;
    pages: number;
    sourceDocumentId: string;
    sourceArtifactId: string;
    extractionSnapshotId: string;
  }>;
  labelPackage: Readonly<{
    ledgerPath: string;
    audit: ReturnType<typeof auditLabelledPricingA3Ledger>;
    promotionSuitable: false;
  }>;
  humanAttestation: Readonly<{
    path: string | null;
    supplied: boolean;
    validation: ForgewingLabelAttestationValidation | null;
    authority: 'evaluation_ground_truth_only';
    promotionAuthorized: false;
  }>;
  exactLabelLinkage: Readonly<{
    path: string | null;
    supplied: boolean;
    status: 'label_linkage_ready' | 'label_linkage_gap';
    failureReasons: readonly string[];
    scoredLabelObservationIds: readonly string[];
    promotionAuthorized: false;
  }>;
  modelIdentity: Readonly<{
    provider: 'anthropic';
    providerConfigured: boolean;
    model: string;
    taskVersion: string;
    promptVersion: string;
    schemaVersion: string;
  }>;
  candidateScope: Readonly<{
    totalLabelledRows: number;
    a2EligibleRows: number;
    providerCallCandidateRows: number;
    a3ScoredOutputs: number;
    orderingDeterministic: boolean;
    frozenCandidates: readonly Readonly<{
      candidateId: string;
      rowId: string;
      physicalPage: number;
      sourceAnchorIds: readonly string[];
      resolutionState: string;
      eligibilityReason: string;
      labelLinkage: 'unmet_labels' | ForgewingCandidateLabelLinkage['linkageStatus'];
      labelObservationIds: readonly string[];
      linkedRoles: readonly string[];
    }>[];
  }>;
  callBudget: Readonly<{
    maximum: number;
    callsAttempted: 0;
    callsSucceeded: 0;
    providerFailures: 0;
    schemaValidOutputs: 0;
  }>;
  corpusStatus: 'labelled_a3_unmet_labels' | 'labelled_a3_incomplete';
  measurementClassification: 'UNMET';
  metrics: Readonly<{
    providerCallSuccessRate: null;
    schemaValidOutputRate: null;
    labelLinkageRate: null;
    semanticRoleAccuracy: null;
    descriptionRoleAccuracy: null;
    unitRoleAccuracy: null;
    amountAccuracy: null;
    amountAccuracyStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL';
    evidenceAnchorFidelity: null;
    hallucinatedAnchorRate: null;
    abstentionRate: null;
    appropriateAbstentionRate: null;
    inappropriateConfidentAnswerRate: null;
    confidenceCalibration: 'NOT_MEASURED';
    repeatedRunStability: 'NOT_MEASURED';
  }>;
  cases: readonly [];
  failureReasons: readonly string[];
}>;

export async function runForgewingLabelledPricingA3(params: {
  entry: ForgewingPricingCorpusEntry;
  labelLedgerPath: string;
  attestationPath?: string;
  linkageManifestPath?: string;
  callBudget?: number;
  now?: () => Date;
}): Promise<ForgewingLabelledPricingA3Artifact> {
  const maximum = params.callBudget ?? DEFAULT_CALL_BUDGET;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_CALL_BUDGET) {
    throw new Error('forgewing_labelled_a3_invalid_call_budget');
  }
  const ledgerPath = resolve(params.labelLedgerPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const labelAudit = auditLabelledPricingA3Ledger(JSON.parse(ledgerBytes.toString('utf8')));
  if (params.entry.expectedSourceSha256 !== labelAudit.source.sha256) {
    throw new Error('SOURCE_MISMATCH');
  }

  // Provider-free preparation proves exact bytes, extraction, A2 admission,
  // and reversal stability before the label gate can authorize any call.
  const preparation = await prepareForgewingPricingCorpus(params.entry);
  if (preparation.source.sourceSha256 !== labelAudit.source.sha256
    || preparation.source.sourceByteLength !== labelAudit.source.byteLength) {
    throw new Error('SOURCE_MISMATCH');
  }

  const attestationPath = params.attestationPath ? resolve(params.attestationPath) : null;
  const attestationInput = attestationPath
    ? JSON.parse(readFileSync(attestationPath, 'utf8')) as unknown
    : null;
  const attestationValidation = attestationPath
    ? validateForgewingLabelAttestation({
        ledgerBytes,
        attestation: attestationInput,
      })
    : null;
  const labelsReady = attestationValidation?.status === 'human_attestation_valid';
  const linkagePath = params.linkageManifestPath ? resolve(params.linkageManifestPath) : null;
  const linkageBytes = linkagePath ? readFileSync(linkagePath) : null;
  const linkageValidation = labelsReady && linkagePath
    ? validateForgewingLabelLinkage({
        manifest: JSON.parse(linkageBytes!.toString('utf8')),
        labelPackageSha256: sha256Hex(ledgerBytes),
        sourcePdfSha256: preparation.source.sourceSha256,
        linkageManifestSha256: sha256Hex(linkageBytes!),
        attestedLinkageManifestSha256: attestationValidation.linkageManifestSha256!,
        audit: labelAudit,
        candidates: preparation.candidates,
        attestedLabelObservationIds: attestationValidation.attestedLabelObservationIds,
        attestationScope: (attestationInput as {
          scope?: { kind?: string };
        }).scope?.kind === 'SCORING_SUBSET' ? 'SCORING_SUBSET' : 'FULL_PACKAGE',
      })
    : null;
  const linkagesByRow = new Map(linkageValidation?.candidateLinkages
    .map((linkage) => [linkage.rowId, linkage]) ?? []);
  const frozenCandidates = preparation.candidates.map((candidate) => ({
    candidateId: hashCanonical(candidate),
    rowId: candidate.rowObservation.observationId,
    physicalPage: candidate.rowObservation.physicalPageNumber,
    sourceAnchorIds: candidate.rowObservation.cells.map((cell) => cell.observationId),
    resolutionState: candidate.rowObservation.deterministicState,
    eligibilityReason: candidate.pricingScope.eligibilityReason,
    labelLinkage: labelsReady
      ? (linkagesByRow.get(candidate.rowObservation.observationId)?.linkageStatus
        ?? 'missing_label_linkage' as const)
      : 'unmet_labels' as const,
    labelObservationIds: linkagesByRow.get(candidate.rowObservation.observationId)
      ?.linkedLabelObservationIds ?? [],
    linkedRoles: linkagesByRow.get(candidate.rowObservation.observationId)?.linkedRoles ?? [],
  }));
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const corpusStatus = labelsReady ? 'labelled_a3_incomplete' : 'labelled_a3_unmet_labels';
  const failureReasons = labelsReady
    ? linkageValidation?.status === 'label_linkage_ready'
      ? ['PROVIDER_DISABLED_PREFLIGHT']
      : ['LABEL_LINKAGE_GAP', ...(linkageValidation?.failureReasons ?? ['linkage_manifest_missing'])]
    : attestationValidation
      ? [...attestationValidation.failureReasons]
      : ['human_attestation_missing'];
  const runId = `forgewing-labelled-a3-${hashCanonical({
    sourceSha256: preparation.source.sourceSha256,
    labelVersion: labelAudit.package.ledgerVersion,
    candidateIds: frozenCandidates.map((candidate) => candidate.candidateId),
    createdAt,
  }).slice(0, 32)}`;

  return {
    reportVersion: FORGEWING_LABELLED_PRICING_A3_VERSION,
    authority: 'non_authoritative_measurement',
    promotionEvidence: false,
    runIdentity: { runId, createdAt },
    sourceIdentity: {
      path: preparation.source.sourcePdfPath,
      sha256: preparation.source.sourceSha256,
      byteLength: preparation.source.sourceByteLength,
      pages: labelAudit.source.pages,
      sourceDocumentId: preparation.source.sourceDocumentId,
      sourceArtifactId: preparation.source.sourceArtifactId,
      extractionSnapshotId: preparation.source.extractionSnapshotId,
    },
    labelPackage: { ledgerPath, audit: labelAudit, promotionSuitable: false },
    humanAttestation: {
      path: attestationPath,
      supplied: attestationPath != null,
      validation: attestationValidation,
      authority: 'evaluation_ground_truth_only',
      promotionAuthorized: false,
    },
    exactLabelLinkage: {
      path: linkagePath,
      supplied: linkagePath != null,
      status: linkageValidation?.status ?? 'label_linkage_gap',
      failureReasons: linkageValidation?.failureReasons ?? ['linkage_manifest_missing'],
      scoredLabelObservationIds: linkageValidation?.scoredLabelObservationIds ?? [],
      promotionAuthorized: false,
    },
    modelIdentity: {
      provider: 'anthropic',
      providerConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      model: preparation.runtime.model,
      taskVersion: preparation.runtime.promptTemplateId,
      promptVersion: preparation.runtime.promptTemplateVersion,
      schemaVersion: preparation.runtime.proposalSchemaVersion,
    },
    candidateScope: {
      totalLabelledRows: labelAudit.denominators.totalDistinctRows,
      a2EligibleRows: preparation.candidates.length,
      providerCallCandidateRows: linkageValidation?.status === 'label_linkage_ready'
        ? frozenCandidates.length : 0,
      a3ScoredOutputs: 0,
      orderingDeterministic: preparation.orderingDeterministic,
      frozenCandidates,
    },
    callBudget: {
      maximum,
      callsAttempted: 0,
      callsSucceeded: 0,
      providerFailures: 0,
      schemaValidOutputs: 0,
    },
    corpusStatus,
    measurementClassification: 'UNMET',
    metrics: {
      providerCallSuccessRate: null,
      schemaValidOutputRate: null,
      labelLinkageRate: null,
      semanticRoleAccuracy: null,
      descriptionRoleAccuracy: null,
      unitRoleAccuracy: null,
      amountAccuracy: null,
      amountAccuracyStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL',
      evidenceAnchorFidelity: null,
      hallucinatedAnchorRate: null,
      abstentionRate: null,
      appropriateAbstentionRate: null,
      inappropriateConfidentAnswerRate: null,
      confidenceCalibration: 'NOT_MEASURED',
      repeatedRunStability: 'NOT_MEASURED',
    },
    cases: [],
    failureReasons,
  };
}

export function parseForgewingLabelledPricingA3Cli(
  argv: readonly string[],
): Readonly<{
  entry: ForgewingPricingCorpusEntry;
  labelLedgerPath: string;
  attestationPath?: string;
  linkageManifestPath?: string;
  outputPath: string;
  callBudget: number;
}> {
  const { values } = parseArgs({
    args: [...argv], strict: true,
    options: {
      source: { type: 'string' }, labels: { type: 'string' },
      attestation: { type: 'string' }, linkage: { type: 'string' },
      'document-type': { type: 'string' }, 'expected-sha256': { type: 'string' },
      'page-ranges': { type: 'string' }, output: { type: 'string' },
      'max-calls': { type: 'string' },
    },
  });
  if (!values.source || !values.labels || !values['document-type']
    || !values['expected-sha256'] || !values['page-ranges'] || !values.output) {
    throw new Error('forgewing_labelled_a3_missing_required_argument');
  }
  const callBudget = values['max-calls'] == null
    ? DEFAULT_CALL_BUDGET
    : Number(values['max-calls']);
  return {
    entry: {
      sourcePdfPath: values.source,
      optionalLabelPackagePath: values.labels,
      corpusKind: 'real_labelled_corpus',
      expectedSourceSha256: values['expected-sha256'],
      documentType: values['document-type'],
      authoritativeRatePageRanges: parseRatePageRanges(values['page-ranges']),
    },
    labelLedgerPath: values.labels,
    ...(values.attestation ? { attestationPath: values.attestation } : {}),
    ...(values.linkage ? { linkageManifestPath: values.linkage } : {}),
    outputPath: values.output,
    callBudget,
  };
}

export async function main(): Promise<void> {
  const cli = parseForgewingLabelledPricingA3Cli(process.argv.slice(2));
  const artifact = await runForgewingLabelledPricingA3(cli);
  const outputPath = resolve(cli.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outputPath}\n`);
}

if (process.env.FORGEWING_LABELLED_A3_CLI === '1'
  || process.argv.some((value) => value.replaceAll('\\', '/')
    .endsWith('/runForgewingLabelledPricingA3.ts'))) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

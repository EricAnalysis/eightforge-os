/**
 * Evaluation-only Forgewing V2 Phase C provider measurement runner.
 *
 * Provider-free by default. Every integrity gate, the run identity, and the
 * write-once freeze artifact complete BEFORE any provider request is possible.
 * Non-authoritative: creates no CanonicalFact, VerifiedField, canonical pricing,
 * or Project Truth, and never mutates human labels or accepted artifacts.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  validateForgewingPricingV2AcceptedPhaseBArtifact,
  validateForgewingPricingV2HumanLabelPackage,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabels';
import {
  scoreForgewingV2PhaseC,
  FORGEWING_V2_PHASE_C_SCORING_VERSION,
  type PhaseCHumanField,
  type PhaseCObservation,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCScoring';
import {
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import type { ForgewingProvider } from '@/lib/forgewing/runtime/client';

export const FORGEWING_V2_PHASE_C_MEASUREMENT_VERSION =
  'forgewing-pricing-v2-phase-c-measurement-v1' as const;

/** Hard ceiling: one call per reasoning row, no retries, for the first measurement. */
export const FORGEWING_V2_PHASE_C_HARD_CALL_LIMIT = 5;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;

export type PhaseCPromptIdentity = Readonly<{
  identifier: string; version: string; promptSha256: string;
}>;

export type PhaseCRunIdentity = Readonly<{
  runId: string; createdAt: string; runNonce: string;
}>;

export type PhaseCProviderField = Readonly<{
  sourceFieldId: string;
  sourceFieldRole: string;
  authoredRawText: string;
  members: readonly Readonly<{ observationId: string; rawText: string }>[];
}>;

export type PhaseCRow = Readonly<{
  candidateId: string;
  rowObservationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  rowRawText: string;
  fields: readonly PhaseCProviderField[];
}>;

export type PhaseCScope = Readonly<{
  rows: readonly PhaseCRow[];
  humanFields: readonly PhaseCHumanField[];
  sources: readonly Readonly<{
    sourceDocumentId: string; sourceSha256: string; sourceByteLength: number;
  }>[];
  fieldDenominator: number;
  contributionDenominator: number;
}>;

/** Deterministic ordering: rows by rowObservationId, fields by sourceFieldId. */
export function buildForgewingV2PhaseCScope(params: {
  humanLabelPackageBytes: Buffer;
  phaseBArtifactBytes: Buffer;
  reviewPacketBytes: Buffer;
}): PhaseCScope {
  const pkg = record(JSON.parse(params.humanLabelPackageBytes.toString('utf8')));
  const packet = record(JSON.parse(params.reviewPacketBytes.toString('utf8')));
  if (!pkg || !packet) throw new Error('forgewing_v2_phase_c_input_contract_violation');

  const artifact = record(JSON.parse(params.phaseBArtifactBytes.toString('utf8')));
  const preparations = (artifact?.sources as JsonRecord[] ?? [])
    .map((source) => record(source.preparation)!);
  const preparedRows = preparations.flatMap((value) => value.rows as JsonRecord[]);
  const preparedFields = preparedRows.flatMap((row) => row.fields as JsonRecord[])
    .map((wrapper) => record(wrapper.field)!);

  const phaseB = validateForgewingPricingV2AcceptedPhaseBArtifact({
    artifactBytes: params.phaseBArtifactBytes,
    expected: {
      preparationArtifactSha256: pkg.preparationArtifactSha256 as string,
      reportDigestSha256: pkg.preparationReportDigestSha256 as string,
      preparationImplementationCommit: pkg.preparationImplementationCommit as string,
      expectedPreparationDigests: preparations
        .map((value) => value.preparationDigestSha256 as string),
      expectedRowCount: preparedRows.length,
      expectedFieldCount: preparedFields.length,
      expectedMemberObservationCount: preparedFields
        .reduce((sum, field) => sum + (field.sourceObservationIds as string[]).length, 0),
      expectedSourceFieldIds: preparedFields.map((field) => field.sourceFieldId as string),
    },
  });
  if (phaseB.status !== 'valid') throw new Error('forgewing_v2_phase_c_phase_b_invalid');

  const validated = validateForgewingPricingV2HumanLabelPackage({
    package: pkg, phaseB: phaseB.value,
    expectedLabelWorkflowImplementationCommit: pkg.implementationCommit as string,
  });
  if (validated.status !== 'valid') throw new Error('forgewing_v2_phase_c_human_package_invalid');

  if (sha256Hex(params.reviewPacketBytes).length !== 64) {
    throw new Error('forgewing_v2_phase_c_packet_unreadable');
  }
  for (const source of packet.sources as JsonRecord[]) {
    if (source.orderingDeterministic !== true) {
      throw new Error('forgewing_v2_phase_c_ordering_nondeterministic');
    }
  }

  const humanFields = (pkg.fields as JsonRecord[]).map((field): PhaseCHumanField => ({
    sourceFieldId: field.sourceFieldId as string,
    sourceObservationIds: field.sourceObservationIds as string[],
    sourceFieldRole: field.sourceFieldRole as string,
    expectedSemanticRole: field.expectedSemanticRole as string,
    expectedInterpretationState: field.expectedInterpretationState as string,
    expectedContributions: (field.expectedContributions as JsonRecord[])
      .map((item) => ({ observationId: item.observationId as string,
        contributionRole: item.contributionRole as string })),
  }));

  const rows: PhaseCRow[] = [];
  for (const sourceValue of packet.sources as JsonRecord[]) {
    for (const rowValue of sourceValue.rows as JsonRecord[]) {
      const context = record(rowValue.context)!;
      const fields = (rowValue.fields as JsonRecord[]).map((wrapper): PhaseCProviderField => {
        const field = record(wrapper.field)!;
        const evidence = wrapper.primitiveEvidence as JsonRecord[];
        const byId = new Map(evidence.map((item) => [item.observationId as string, item]));
        return {
          sourceFieldId: field.sourceFieldId as string,
          sourceFieldRole: field.sourceFieldRole as string,
          authoredRawText: wrapper.authoredRawTextDisplayOnly as string,
          members: (field.sourceObservationIds as string[]).map((observationId) => ({
            observationId, rawText: byId.get(observationId)?.rawText as string,
          })),
        };
      }).sort((left, right) =>
        left.sourceFieldId.localeCompare(right.sourceFieldId, 'en-US'));
      rows.push({
        candidateId: rowValue.candidateId as string
          ?? (context.rowObservationId as string),
        rowObservationId: context.rowObservationId as string,
        sourceDocumentId: context.sourceDocumentId as string,
        sourceArtifactId: context.sourceArtifactId as string,
        physicalPageNumber: context.physicalPageNumber as number,
        rowRawText: (rowValue.rowRawText as string) ?? '',
        fields,
      });
    }
  }
  rows.sort((left, right) =>
    left.rowObservationId.localeCompare(right.rowObservationId, 'en-US'));

  return {
    rows, humanFields,
    sources: (packet.sources as JsonRecord[]).map((source) => {
      const identity = record(source.source)!;
      return { sourceDocumentId: identity.sourceDocumentId as string,
        sourceSha256: identity.sourceSha256 as string,
        sourceByteLength: identity.sourceByteLength as number };
    }),
    fieldDenominator: humanFields.length,
    contributionDenominator: humanFields
      .reduce((sum, field) => sum + field.expectedContributions.length, 0),
  };
}

export function allocateForgewingV2PhaseCRunIdentity(params: {
  createdAt: string; runNonce: string; codeCommit: string | null;
  humanLabelPackageSha256: string; phaseBArtifactSha256: string; reviewPacketSha256: string;
  labelWorkflowImplementationCommit: string; model: string; prompt: PhaseCPromptIdentity;
  orderedSourceFieldIds: readonly string[]; fieldDenominator: number;
  contributionDenominator: number;
}): PhaseCRunIdentity {
  const runId = `forgewing-v2-phase-c-${hashCanonical({
    codeCommit: params.codeCommit,
    humanLabelPackageSha256: params.humanLabelPackageSha256,
    phaseBArtifactSha256: params.phaseBArtifactSha256,
    reviewPacketSha256: params.reviewPacketSha256,
    labelWorkflowImplementationCommit: params.labelWorkflowImplementationCommit,
    model: params.model, promptIdentifier: params.prompt.identifier,
    promptVersion: params.prompt.version, promptSha256: params.prompt.promptSha256,
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    measurementVersion: FORGEWING_V2_PHASE_C_MEASUREMENT_VERSION,
    orderedSourceFieldIds: params.orderedSourceFieldIds,
    fieldDenominator: params.fieldDenominator,
    contributionDenominator: params.contributionDenominator,
    createdAt: params.createdAt, runNonce: params.runNonce,
  }).slice(0, 32)}`;
  return { runId, createdAt: params.createdAt, runNonce: params.runNonce };
}

function persistImmutable(path: string, artifact: unknown): string {
  const absolutePath = resolve(path);
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes, { encoding: 'utf8', flag: 'wx' });
  const persisted = readFileSync(absolutePath, 'utf8');
  if (persisted !== bytes || hashCanonical(JSON.parse(persisted)) !== hashCanonical(artifact)) {
    throw new Error('FORGEWING_V2_PHASE_C_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED');
  }
  return sha256Hex(bytes);
}

export type PhaseCPlannedCall = Readonly<{
  sequence: number; rowObservationId: string; fieldCount: number;
}>;

export type PhaseCCallRecord = Readonly<{
  runIdentity: PhaseCRunIdentity; sequence: number; rowObservationId: string;
  startedAt: string; completedAt: string; durationMs: number; providerInvoked: boolean;
  rawOutput: string | null; rawOutputSha256: string | null; outputByteLength: number | null;
  outcome: 'accepted' | 'provider_error' | 'provider_timeout' | 'malformed_output'
    | 'schema_rejected' | 'validation_rejected';
  failureDetail: string | null;
}>;

export async function runForgewingPricingV2PhaseCMeasurement(params: {
  humanLabelPackagePath: string; phaseBArtifactPath: string; reviewPacketPath: string;
  prompt: PhaseCPromptIdentity; model: string; codeCommit: string | null;
  freezeOutputPath: string; measurementOutputPath?: string;
  executeProvider?: boolean; provider?: ForgewingProvider;
  callBudget?: number; providerTimeoutMs?: number; providerMaxOutputTokens?: number;
  now?: () => Date; runNonce?: string;
}) {
  const humanLabelPackageBytes = readFileSync(resolve(params.humanLabelPackagePath));
  const phaseBArtifactBytes = readFileSync(resolve(params.phaseBArtifactPath));
  const reviewPacketBytes = readFileSync(resolve(params.reviewPacketPath));

  const scope = buildForgewingV2PhaseCScope({
    humanLabelPackageBytes, phaseBArtifactBytes, reviewPacketBytes,
  });

  const plannedCallSequence: PhaseCPlannedCall[] = scope.rows.map((row, index) => ({
    sequence: index + 1, rowObservationId: row.rowObservationId,
    fieldCount: row.fields.length,
  }));
  const hardCallLimit = FORGEWING_V2_PHASE_C_HARD_CALL_LIMIT;
  const callBudget = params.callBudget ?? hardCallLimit;
  if (!Number.isSafeInteger(callBudget) || callBudget < 1 || callBudget > hardCallLimit) {
    throw new Error('FORGEWING_V2_PHASE_C_INVALID_CALL_BUDGET');
  }
  if (plannedCallSequence.length > callBudget) {
    throw new Error('FORGEWING_V2_PHASE_C_CALL_BUDGET_EXCEEDED');
  }
  if (params.executeProvider && !params.provider) {
    throw new Error('FORGEWING_V2_PHASE_C_PROVIDER_REQUIRED');
  }
  if (params.freezeOutputPath && params.measurementOutputPath
    && resolve(params.freezeOutputPath) === resolve(params.measurementOutputPath)) {
    throw new Error('FORGEWING_V2_PHASE_C_ARTIFACT_PATH_COLLISION');
  }

  const humanLabelPackageSha256 = sha256Hex(humanLabelPackageBytes);
  const phaseBArtifactSha256 = sha256Hex(phaseBArtifactBytes);
  const reviewPacketSha256 = sha256Hex(reviewPacketBytes);
  const labelWorkflowImplementationCommit = (record(
    JSON.parse(humanLabelPackageBytes.toString('utf8')))!.implementationCommit) as string;
  const orderedSourceFieldIds = [...scope.humanFields]
    .map((field) => field.sourceFieldId)
    .sort((a, b) => a.localeCompare(b, 'en-US'));

  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const runIdentity = allocateForgewingV2PhaseCRunIdentity({
    createdAt, runNonce: params.runNonce ?? randomUUID(), codeCommit: params.codeCommit,
    humanLabelPackageSha256, phaseBArtifactSha256, reviewPacketSha256,
    labelWorkflowImplementationCommit, model: params.model, prompt: params.prompt,
    orderedSourceFieldIds, fieldDenominator: scope.fieldDenominator,
    contributionDenominator: scope.contributionDenominator,
  });

  const providerTimeoutMs = params.providerTimeoutMs ?? 30_000;
  const providerMaxOutputTokens = params.providerMaxOutputTokens ?? 2_000;

  const freezeArtifact = {
    freezeVersion: 'forgewing-pricing-v2-phase-c-freeze-v1' as const,
    measurementVersion: FORGEWING_V2_PHASE_C_MEASUREMENT_VERSION,
    scoringVersion: FORGEWING_V2_PHASE_C_SCORING_VERSION,
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    runIdentity,
    authority: 'non_authoritative_measurement' as const,
    promotionEvidence: false as const, promotionAuthorized: false as const,
    provider: 'anthropic' as const, model: params.model, temperature: 0 as const,
    structuredOutput: 'json_schema' as const,
    outputTokenLimit: providerMaxOutputTokens, timeoutMs: providerTimeoutMs,
    sdkRetries: 0 as const, taskRetryLimitPerCandidate: 0 as const,
    prompt: params.prompt,
    bindings: {
      humanLabelPackageSha256, phaseBArtifactSha256, reviewPacketSha256,
      labelWorkflowImplementationCommit, codeCommit: params.codeCommit,
    },
    sourceIdentities: scope.sources,
    scope: {
      rowCount: scope.rows.length, fieldCount: scope.fieldDenominator,
      contributionCount: scope.contributionDenominator,
      orderedRowObservationIds: scope.rows.map((row) => row.rowObservationId),
      orderedSourceFieldIds,
      orderedSourceObservationIds: [...new Set(scope.humanFields
        .flatMap((field) => field.sourceObservationIds))]
        .sort((a, b) => a.localeCompare(b, 'en-US')),
    },
    fixedDenominators: {
      field: scope.fieldDenominator, contribution: scope.contributionDenominator,
    },
    callPlan: {
      grain: 'one_provider_call_per_reasoning_row' as const,
      plannedCalls: plannedCallSequence.length, callBudget, hardCallLimit,
      plannedCallSequence,
    },
    providerInput: scope.rows,
  };
  const freezeSha256 = persistImmutable(params.freezeOutputPath, freezeArtifact);
  const freezeDigest = hashCanonical(freezeArtifact);

  // ---- provider boundary: nothing above this line may issue a request ----
  const callRecords: PhaseCCallRecord[] = [];
  const observations = new Map<string, PhaseCObservation>();
  let providerCallsExecuted = 0;

  if (!params.executeProvider) {
    for (const field of scope.humanFields) {
      observations.set(field.sourceFieldId,
        { status: 'unavailable', reason: 'provider_disabled' });
    }
  }

  const scoring = scoreForgewingV2PhaseC({
    humanFields: scope.humanFields, observations,
  });

  const measurement = {
    reportVersion: FORGEWING_V2_PHASE_C_MEASUREMENT_VERSION,
    authority: 'non_authoritative_measurement' as const,
    promotionEvidence: false as const, promotionAuthorized: false as const,
    runIdentity,
    freeze: { path: resolve(params.freezeOutputPath), sha256: freezeSha256,
      digestSha256: freezeDigest },
    executionMode: params.executeProvider ? 'provider_enabled' : 'provider_disabled_dry_run',
    providerAccounting: {
      plannedCalls: plannedCallSequence.length, callBudget, hardCallLimit,
      providerCallsExecuted, sdkRetries: 0 as const, taskRetryLimitPerCandidate: 0 as const,
      callRecords,
    },
    rawResponses: callRecords.map((entry) => ({
      sequence: entry.sequence, rowObservationId: entry.rowObservationId,
      rawOutputSha256: entry.rawOutputSha256, outputByteLength: entry.outputByteLength,
      rawOutput: entry.rawOutput,
    })),
    scoring,
    limitations: [
      'semantic_role_structurally_confounded',
      'abstention_appropriateness_not_measurable_from_this_package',
      'scope_is_a_capability_probe_not_a_general_capability_claim',
      ...(params.executeProvider ? [] : ['provider_disabled_dry_run_no_measurement']),
    ],
  };

  const measurementSha256 = params.measurementOutputPath
    ? persistImmutable(params.measurementOutputPath, measurement) : null;

  return { scope, runIdentity, freezeArtifact, freezeSha256, freezeDigest,
    measurement, measurementSha256, providerCallsExecuted };
}

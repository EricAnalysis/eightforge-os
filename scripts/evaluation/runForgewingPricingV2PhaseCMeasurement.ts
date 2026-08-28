/**
 * Evaluation-only Forgewing V2 Phase C provider measurement runner.
 *
 * Every integrity gate, the run identity, and the write-once freeze artifact
 * complete BEFORE any provider request is possible. Provider output is routed
 * through the authoritative V2 schema, validator, and join; this module never
 * re-implements identity or membership authority.
 *
 * Non-authoritative: creates no CanonicalFact, VerifiedField, canonical pricing,
 * or Project Truth, and never mutates human labels or accepted artifacts.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  authenticateForgewingV2PhaseCInputs,
  FORGEWING_V2_PHASE_C_ACCEPTED_PINS,
  type ForgewingV2PhaseCAcceptedPins,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCAcceptedInputs';
import {
  scoreForgewingV2PhaseC,
  FORGEWING_V2_PHASE_C_SCORING_VERSION,
  type PhaseCFieldUnavailableReason,
  type PhaseCHumanField,
  type PhaseCObservation,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCScoring';
import {
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  ForgewingPricingInterpretationProposalV2Schema,
  type ForgewingSourceFieldContext,
  type ForgewingSourceFieldInput,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  joinForgewingPricingInterpretationProposalV2,
  validateForgewingPricingInterpretationProposalV2,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2Validation';
import type { ForgewingProvider } from '@/lib/forgewing/runtime/client';

export const FORGEWING_V2_PHASE_C_MEASUREMENT_VERSION =
  'forgewing-pricing-v2-phase-c-measurement-v2' as const;

/** Hard ceiling: one call per reasoning row, no retries, for the frozen run. */
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

/** The provider-facing view of one field: no expected label, no scoring input. */
export type PhaseCProviderField = Readonly<{
  sourceFieldId: string;
  sourceFieldRole: string;
  authoredRawText: string;
  members: readonly Readonly<{ observationId: string; rawText: string }>[];
}>;

export type PhaseCRow = Readonly<{
  candidateId: string;
  rowObservationId: string;
  context: ForgewingSourceFieldContext;
  eligibleFields: readonly ForgewingSourceFieldInput[];
  providerFields: readonly PhaseCProviderField[];
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

/** Provider-facing payload for one row. Runtime-owned identity only. */
export function forgewingV2PhaseCProviderInput(row: PhaseCRow): JsonRecord {
  return {
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: row.candidateId,
    rowObservationId: row.context.rowObservationId,
    sourceDocumentId: row.context.sourceDocumentId,
    sourceArtifactId: row.context.sourceArtifactId,
    physicalPageNumber: row.context.physicalPageNumber,
    fields: row.providerFields,
  };
}

/**
 * Authenticates every accepted input against independent pins, then derives the
 * frozen scope. Deterministic ordering: rows by rowObservationId, fields by
 * sourceFieldId, members in frozen packet order.
 */
export function buildForgewingV2PhaseCScope(params: {
  humanLabelPackageBytes: Buffer;
  phaseBArtifactBytes: Buffer;
  reviewPacketBytes: Buffer;
  pins?: ForgewingV2PhaseCAcceptedPins;
}): PhaseCScope {
  const authenticated = authenticateForgewingV2PhaseCInputs({
    humanLabelPackageBytes: params.humanLabelPackageBytes,
    phaseBArtifactBytes: params.phaseBArtifactBytes,
    reviewPacketBytes: params.reviewPacketBytes,
    pins: params.pins,
  });
  const pkg = authenticated.humanLabelPackage;
  const packet = authenticated.reviewPacket;

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
      const context = record(rowValue.context)! as unknown as ForgewingSourceFieldContext;
      const wrappers = [...(rowValue.fields as JsonRecord[])].sort((left, right) =>
        (record(left.field)!.sourceFieldId as string)
          .localeCompare(record(right.field)!.sourceFieldId as string, 'en-US'));
      const eligibleFields = wrappers.map((wrapper) => {
        const field = record(wrapper.field)!;
        return {
          sourceFieldId: field.sourceFieldId as string,
          sourceFieldRole: field.sourceFieldRole,
          authoredRawText: wrapper.authoredRawTextDisplayOnly as string,
          sourceObservationIds: field.sourceObservationIds as string[],
          physicalPageNumber: context.physicalPageNumber,
        } as ForgewingSourceFieldInput;
      });
      const providerFields = wrappers.map((wrapper): PhaseCProviderField => {
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
      });
      rows.push({
        candidateId: (rowValue.candidateId as string) ?? context.rowObservationId,
        rowObservationId: context.rowObservationId,
        context, eligibleFields, providerFields,
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

export type PhaseCCallOutcome = 'accepted' | 'provider_error' | 'timeout'
  | 'malformed_json' | 'schema_rejected' | 'validator_rejected';

export type PhaseCCallRecord = Readonly<{
  runIdentity: PhaseCRunIdentity;
  sequence: number;
  rowObservationId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  providerInvoked: boolean;
  outcome: PhaseCCallOutcome;
  rawOutput: string | null;
  rawOutputSha256: string | null;
  outputByteLength: number | null;
  usage: unknown | null;
  schemaValidationStatus: 'not_reached' | 'valid' | 'rejected';
  validatorStatus: 'not_reached' | 'valid' | 'rejected';
  violationCodes: readonly string[];
  failureDetail: string | null;
}>;

/** Providers may optionally expose usage observationally; never affects scoring. */
export type PhaseCUsageProvider = ForgewingProvider & {
  lastUsage?: () => unknown | null;
};

function classifyProviderError(error: unknown): { outcome: PhaseCCallOutcome; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'provider_timeout' || message === 'Request timed out') {
    return { outcome: 'timeout', detail: message };
  }
  return { outcome: 'provider_error', detail: message };
}

export async function runForgewingPricingV2PhaseCMeasurement(params: {
  humanLabelPackagePath: string; phaseBArtifactPath: string; reviewPacketPath: string;
  prompt: PhaseCPromptIdentity; model: string; codeCommit: string | null;
  freezeOutputPath: string; measurementOutputPath?: string;
  executeProvider?: boolean; provider?: PhaseCUsageProvider;
  callBudget?: number; providerTimeoutMs?: number; providerMaxOutputTokens?: number;
  pins?: ForgewingV2PhaseCAcceptedPins;
  now?: () => Date; runNonce?: string;
}) {
  const humanLabelPackageBytes = readFileSync(resolve(params.humanLabelPackagePath));
  const phaseBArtifactBytes = readFileSync(resolve(params.phaseBArtifactPath));
  const reviewPacketBytes = readFileSync(resolve(params.reviewPacketPath));

  const scope = buildForgewingV2PhaseCScope({
    humanLabelPackageBytes, phaseBArtifactBytes, reviewPacketBytes, pins: params.pins,
  });

  const plannedCallSequence: PhaseCPlannedCall[] = scope.rows.map((row, index) => ({
    sequence: index + 1, rowObservationId: row.rowObservationId,
    fieldCount: row.providerFields.length,
  }));
  const hardCallLimit = FORGEWING_V2_PHASE_C_HARD_CALL_LIMIT;
  const callBudget = params.callBudget ?? hardCallLimit;
  if (!Number.isSafeInteger(callBudget) || callBudget < 1 || callBudget > hardCallLimit) {
    throw new Error('FORGEWING_V2_PHASE_C_INVALID_CALL_BUDGET');
  }
  if (plannedCallSequence.length > callBudget) {
    throw new Error('FORGEWING_V2_PHASE_C_CALL_BUDGET_EXCEEDED');
  }
  if (params.executeProvider && typeof params.provider !== 'function') {
    throw new Error('FORGEWING_V2_PHASE_C_PROVIDER_REQUIRED');
  }
  if (params.freezeOutputPath && params.measurementOutputPath
    && resolve(params.freezeOutputPath) === resolve(params.measurementOutputPath)) {
    throw new Error('FORGEWING_V2_PHASE_C_ARTIFACT_PATH_COLLISION');
  }

  const pins = params.pins ?? FORGEWING_V2_PHASE_C_ACCEPTED_PINS;
  const humanLabelPackageSha256 = sha256Hex(humanLabelPackageBytes);
  const phaseBArtifactSha256 = sha256Hex(phaseBArtifactBytes);
  const reviewPacketSha256 = sha256Hex(reviewPacketBytes);
  const orderedSourceFieldIds = scope.humanFields
    .map((field) => field.sourceFieldId)
    .sort((a, b) => a.localeCompare(b, 'en-US'));

  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const runIdentity = allocateForgewingV2PhaseCRunIdentity({
    createdAt, runNonce: params.runNonce ?? randomUUID(), codeCommit: params.codeCommit,
    humanLabelPackageSha256, phaseBArtifactSha256, reviewPacketSha256,
    labelWorkflowImplementationCommit: pins.labelWorkflowImplementationCommit,
    model: params.model, prompt: params.prompt, orderedSourceFieldIds,
    fieldDenominator: scope.fieldDenominator,
    contributionDenominator: scope.contributionDenominator,
  });

  const providerTimeoutMs = params.providerTimeoutMs ?? 30_000;
  const providerMaxOutputTokens = params.providerMaxOutputTokens ?? 2_000;

  const freezeArtifact = {
    freezeVersion: 'forgewing-pricing-v2-phase-c-freeze-v2' as const,
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
    acceptedPins: pins,
    bindings: {
      humanLabelPackageSha256, phaseBArtifactSha256, reviewPacketSha256,
      labelWorkflowImplementationCommit: pins.labelWorkflowImplementationCommit,
      phaseBPreparationCommit: pins.phaseBPreparationCommit,
      codeCommit: params.codeCommit,
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
    providerInput: scope.rows.map(forgewingV2PhaseCProviderInput),
  };
  const freezeSha256 = persistImmutable(params.freezeOutputPath, freezeArtifact);
  const freezeDigest = hashCanonical(freezeArtifact);

  // ==== provider boundary: the freeze is written and byte-verified above ====
  const callRecords: PhaseCCallRecord[] = [];
  const observations = new Map<string, PhaseCObservation>();
  let providerCallsExecuted = 0;

  const markRow = (row: PhaseCRow, reason: PhaseCFieldUnavailableReason,
    violationCodes: readonly string[] = []): void => {
    for (const field of row.eligibleFields) {
      observations.set(field.sourceFieldId, { status: 'unavailable', reason, violationCodes });
    }
  };

  if (!params.executeProvider) {
    for (const row of scope.rows) markRow(row, 'provider_disabled');
  } else {
    const provider = params.provider!;
    for (const [index, row] of scope.rows.entries()) {
      if (providerCallsExecuted >= callBudget || providerCallsExecuted >= hardCallLimit) {
        throw new Error('FORGEWING_V2_PHASE_C_CALL_BUDGET_EXCEEDED');
      }
      const sequence = index + 1;
      const startedAt = new Date();
      let rawOutput: string | null = null;
      let providerInvoked = false;
      let outcome: PhaseCCallOutcome = 'provider_error';
      let failureDetail: string | null = null;
      let schemaValidationStatus: PhaseCCallRecord['schemaValidationStatus'] = 'not_reached';
      let validatorStatus: PhaseCCallRecord['validatorStatus'] = 'not_reached';
      let violationCodes: readonly string[] = [];
      let usage: unknown | null = null;

      // A failed attempt still consumes its planned call. No retries.
      providerCallsExecuted += 1;
      try {
        providerInvoked = true;
        rawOutput = await provider({
          model: params.model, timeoutMs: providerTimeoutMs,
          maxOutputTokens: providerMaxOutputTokens,
          inputJson: JSON.stringify(forgewingV2PhaseCProviderInput(row)),
        });
      } catch (error) {
        const classified = classifyProviderError(error);
        outcome = classified.outcome; failureDetail = classified.detail;
      }
      try { usage = provider.lastUsage?.() ?? null; } catch { usage = null; }

      if (rawOutput !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawOutput);
        } catch {
          outcome = 'malformed_json'; failureDetail = 'invalid_model_json';
          schemaValidationStatus = 'rejected';
        }
        if (schemaValidationStatus !== 'rejected') {
          const schema = ForgewingPricingInterpretationProposalV2Schema.safeParse(parsed);
          if (!schema.success) {
            outcome = 'schema_rejected'; schemaValidationStatus = 'rejected';
            failureDetail = 'proposal_schema_rejected';
          } else {
            schemaValidationStatus = 'valid';
            const validation = validateForgewingPricingInterpretationProposalV2({
              candidateId: row.candidateId, context: row.context,
              eligibleFields: row.eligibleFields, proposal: parsed,
            });
            if (validation.status !== 'valid') {
              outcome = 'validator_rejected'; validatorStatus = 'rejected';
              violationCodes = validation.violations;
              failureDetail = validation.violations.join(',');
            } else {
              validatorStatus = 'valid';
              const joined = joinForgewingPricingInterpretationProposalV2({
                candidateId: row.candidateId, context: row.context,
                eligibleFields: row.eligibleFields, proposal: parsed,
              });
              outcome = 'accepted';
              for (const field of joined.fieldInterpretations) {
                observations.set(field.sourceFieldId, { status: 'observed', field: {
                  sourceFieldId: field.sourceFieldId, semanticRole: field.semanticRole,
                  interpretationState: field.interpretationState,
                  contributions: field.contributions,
                } });
              }
            }
          }
        }
      }

      if (outcome !== 'accepted') {
        markRow(row, outcome as PhaseCFieldUnavailableReason, violationCodes);
      }

      const finishedAt = new Date();
      callRecords.push({
        runIdentity, sequence, rowObservationId: row.rowObservationId,
        startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        providerInvoked, outcome, rawOutput,
        rawOutputSha256: rawOutput === null ? null : sha256Hex(rawOutput),
        outputByteLength: rawOutput === null ? null : Buffer.byteLength(rawOutput, 'utf8'),
        usage, schemaValidationStatus, validatorStatus, violationCodes, failureDetail,
      });
    }
    if (providerCallsExecuted > hardCallLimit) {
      throw new Error('FORGEWING_V2_PHASE_C_CALL_BUDGET_EXCEEDED');
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
      outcomeCounts: callRecords.reduce<Record<string, number>>((acc, entry) =>
        ({ ...acc, [entry.outcome]: (acc[entry.outcome] ?? 0) + 1 }), {}),
      callRecords,
    },
    rawResponses: callRecords.map((entry) => ({
      sequence: entry.sequence, rowObservationId: entry.rowObservationId,
      outcome: entry.outcome, rawOutputSha256: entry.rawOutputSha256,
      outputByteLength: entry.outputByteLength, rawOutput: entry.rawOutput,
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
    measurement, measurementSha256, providerCallsExecuted, callRecords };
}

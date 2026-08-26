/**
 * SYNTHETIC FIXTURES ONLY. These tests exercise the A3 run boundary with a
 * fake provider. They are not corpus evidence or promotion evidence.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';

const harness = vi.hoisted(() => ({
  auditLedger: vi.fn(), prepareCorpus: vi.fn(), runAttempts: vi.fn(),
  parseLinkage: vi.fn(), validateAttestation: vi.fn(), validateLinkage: vi.fn(),
}));

vi.mock('@/lib/evaluation/forgewing/labelledPricingA3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evaluation/forgewing/labelledPricingA3')>()),
  auditLabelledPricingA3Ledger: harness.auditLedger,
}));

vi.mock('@/lib/evaluation/forgewing/labelledPricingAttestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evaluation/forgewing/labelledPricingAttestation')>()),
  validateForgewingLabelAttestation: harness.validateAttestation,
}));

vi.mock('@/lib/evaluation/forgewing/labelledPricingLinkage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evaluation/forgewing/labelledPricingLinkage')>()),
  parseForgewingLabelLinkageManifest: harness.parseLinkage,
  validateForgewingLabelLinkage: harness.validateLinkage,
}));

vi.mock('@/scripts/evaluation/runForgewingPricingCorpus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/scripts/evaluation/runForgewingPricingCorpus')>()),
  prepareForgewingPricingCorpus: harness.prepareCorpus,
  runForgewingPricingCandidateAttempts: harness.runAttempts,
}));

vi.mock('@/lib/forgewing/runtime/modelConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/forgewing/runtime/modelConfig')>()),
  getForgewingRuntimeConfig: () => ({ enabled: false, model: 'claude-sonnet-4-6',
    maxCalls: 0, timeoutMs: 30_000, maxOutputTokens: 2_000 }),
}));

import { persistA3FreezeArtifact, preserveA3InterruptionRootCause,
  runForgewingLabelledPricingA3, type A3FreezeArtifact, type A3InterruptionArtifact,
  type A3InterruptionPersistenceFailureDiagnostic,
  type A3PreCallReport } from '@/scripts/evaluation/runForgewingLabelledPricingA3';

const SOURCE_SHA = '1'.repeat(64);
const CELL_IDS = ['description-cell', 'unit-cell', 'rate-cell'] as const;
const LABEL_IDS = ['label-description', 'label-unit', 'label-cost'] as const;
const FIXED_TIME = '2026-08-25T18:00:00.000Z';

let temporaryDirectory: string;
let ledgerPath: string;
let attestationPath: string;
let linkagePath: string;
let candidate: Record<string, unknown>;

function attempt(result: 'applied' | 'failed') {
  return { rowObservationId: 'row-1', resultStatus: result,
    model: result === 'applied' ? 'claude-sonnet-4-6' : null,
    promptTemplateId: 'pricing-interpretation', promptTemplateVersion: 'v3',
    proposalSchemaVersion: 'forgewing-pricing-interpretation-proposal-v1',
    inputSnapshotHash: result === 'applied' ? 'input-hash' : null,
    taskId: result === 'applied' ? 'task-1' : null,
    runId: result === 'applied' ? 'task-run-1' : null, providerCallCount: 1,
    proposalBundle: result === 'applied' ? { proposals: [{ rowInterpretationState: 'observed',
      confidence: 0.8, interpretations: [
        { sourceCellId: CELL_IDS[0], semanticRole: 'description_like_text', evidenceArtifactIds: [CELL_IDS[0]] },
        { sourceCellId: CELL_IDS[1], semanticRole: 'unit_like_text', evidenceArtifactIds: [CELL_IDS[1]] },
        { sourceCellId: CELL_IDS[2], semanticRole: 'rate_like_amount', evidenceArtifactIds: [CELL_IDS[2]] },
      ] }], abstentions: [] } : null,
    evaluation: null, warnings: result === 'applied' ? [] : ['provider_error'],
    failureReason: result === 'applied' ? null : 'synthetic_provider_failure' };
}

function runnerParams(overrides: Record<string, unknown> = {}) {
  return { entry: { sourcePdfPath: 'synthetic.pdf', corpusKind: 'real_labelled_corpus' as const,
      expectedSourceSha256: SOURCE_SHA, documentType: 'contract',
      authoritativeRatePageRanges: [{ start: 1, end: 1 }] },
    labelLedgerPath: ledgerPath, attestationPath, linkageManifestPath: linkagePath,
    failureOutputPath: join(temporaryDirectory, 'failure.json'),
    callBudget: 6, expectedCandidateIds: [hashCanonical(candidate)],
    expectedCandidateRowIds: ['row-1'], providerTimeoutMs: 30_000,
    providerMaxOutputTokens: 2_000, now: () => new Date(FIXED_TIME),
    ...overrides };
}

async function frozenInterruptionArtifact(freezePath: string): Promise<A3InterruptionArtifact> {
  await runForgewingLabelledPricingA3(runnerParams({ freezeOutputPath: freezePath }));
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
  return { runIdentity: freeze.runIdentity, implementationIdentity: freeze.implementationIdentity,
    preCallReport: freeze.preCallReport,
    frozenProviderBundleDigest: freeze.frozenProviderBundle.digestSha256,
    interruption: { interruptedAt: FIXED_TIME, reason: 'A3_RUN_INTERRUPTED_AFTER_FREEZE',
      callsAttempted: 1, completedCallRecords: 0 } };
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'eightforge-a3-identity-'));
  ledgerPath = join(temporaryDirectory, 'ledger.json');
  attestationPath = join(temporaryDirectory, 'attestation.json');
  linkagePath = join(temporaryDirectory, 'linkage.json');
  writeFileSync(ledgerPath, '{}\n');
  writeFileSync(attestationPath, '{}\n');
  writeFileSync(linkagePath, '{}\n');

  candidate = { organizationId: 'org-1', sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1', extractionSnapshotId: 'snapshot-1',
    pricingScope: { scopeKind: 'authoritative', eligibility: 'canonical_eligible',
      eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'scope-1' },
    rowObservation: { observationId: 'row-1', physicalPageNumber: 1,
      deterministicState: 'unresolved', cells: CELL_IDS.map((observationId) => ({ observationId })),
      sourceCellGroups: [
        { sourceCellRole: 'description', sourceObservationIds: [CELL_IDS[0]], authoredRawText: 'Description' },
        { sourceCellRole: 'unit', sourceObservationIds: [CELL_IDS[1]], authoredRawText: 'Each' },
        { sourceCellRole: 'rate', sourceObservationIds: [CELL_IDS[2]], authoredRawText: '$ 1.00' },
      ] } };

  harness.auditLedger.mockReturnValue({ evaluationVersion: 'synthetic', corpusStatus: 'labelled_a3_unmet_labels',
    unmetReasons: [], warnings: [], package: { ledgerVersion: 'synthetic-v1', status: 'draft',
      provenanceMethod: 'machine_generated', humanAttested: false, promotionSuitable: false },
    source: { sha256: SOURCE_SHA, byteLength: 123, pages: 1 },
    denominators: { totalDistinctRows: 1 }, expectedLabels: [
      { labelObservationId: LABEL_IDS[0], expectedSemanticRole: 'description_like_text', expectedRawText: 'Description' },
      { labelObservationId: LABEL_IDS[1], expectedSemanticRole: 'unit_like_text', expectedRawText: 'Each' },
      { labelObservationId: LABEL_IDS[2], expectedSemanticRole: 'rate_like_amount', expectedRawText: '$ 1.00' },
    ] });
  harness.prepareCorpus.mockResolvedValue({ source: { sourceSha256: SOURCE_SHA, sourceByteLength: 123,
      sourcePdfPath: 'synthetic.pdf', sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
      extractionSnapshotId: 'snapshot-1' }, orderingDeterministic: true, candidates: [candidate],
    pricingLayoutObservations: CELL_IDS.map((id) => ({ id })), runtime: { model: 'claude-sonnet-4-6',
      promptTemplateId: 'pricing-interpretation', promptTemplateVersion: 'v3',
      proposalSchemaVersion: 'forgewing-pricing-interpretation-proposal-v1' } });
  harness.validateAttestation.mockReturnValue({ status: 'human_attestation_valid',
    linkageManifestSha256: 'linkage-digest', attestedLabelObservationIds: [...LABEL_IDS], failureReasons: [] });
  harness.validateLinkage.mockReturnValue({ status: 'label_linkage_ready', failureReasons: [],
    scoredLabelObservationIds: [...LABEL_IDS], candidateLinkages: [{ rowId: 'row-1',
      linkageStatus: 'exact_linkage_complete', linkedLabelObservationIds: [...LABEL_IDS],
      linkedRoles: ['description', 'unit', 'cost'] }] });
  harness.parseLinkage.mockReturnValue({ records: [
    { candidate_row_id: 'row-1', label_observation_id: LABEL_IDS[0], label_role: 'description',
      source_observation_ids: [CELL_IDS[0]] },
    { candidate_row_id: 'row-1', label_observation_id: LABEL_IDS[1], label_role: 'unit',
      source_observation_ids: [CELL_IDS[1]] },
    { candidate_row_id: 'row-1', label_observation_id: LABEL_IDS[2], label_role: 'cost',
      source_observation_ids: [CELL_IDS[2]] },
  ] });
  harness.runAttempts.mockImplementation(async (_candidates, options) => {
    try {
      await options.provider({ inputJson: '{}', maxOutputTokens: 2_000 });
      return [attempt('applied')];
    } catch {
      return [attempt('failed')];
    }
  });
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('SYNTHETIC: A3 immutable pre-call run identity', () => {
  it('persists one identity before provider invocation and reuses it for repeats and final accounting', async () => {
    const freezePath = join(temporaryDirectory, 'freeze.json');
    let preCallReport: A3PreCallReport | null = null;
    const providerIdentities: A3FreezeArtifact['runIdentity'][] = [];
    const provider = vi.fn(async () => {
      expect(preCallReport).not.toBeNull();
      expect(existsSync(freezePath)).toBe(true);
      const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
      expect(freeze.runIdentity).toEqual(preCallReport!.runIdentity);
      expect(freeze.preCallReport.runIdentity).toEqual(freeze.runIdentity);
      expect(freeze.callConfiguration).toMatchObject({ executeProvider: true,
        plannedCalls: 2, configuredCallBudget: 6, promptVersion: 'v3' });
      providerIdentities.push(freeze.runIdentity);
      writeFileSync(attestationPath, '{"changedAfterFreeze":true}\n');
      return '{}';
    });

    const artifact = await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
      repeatEachCandidate: true, freezeOutputPath: freezePath, provider,
      onPreCallReport: (report: A3PreCallReport) => { preCallReport = report; } }));

    expect(provider).toHaveBeenCalledTimes(2);
    expect(providerIdentities).toHaveLength(2);
    expect(providerIdentities.every((identity) =>
      JSON.stringify(identity) === JSON.stringify(artifact.runIdentity))).toBe(true);
    expect(artifact.preCallReport.runIdentity).toEqual(artifact.runIdentity);
    const persistedFreeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
    expect(artifact.implementationIdentity).toEqual(persistedFreeze.implementationIdentity);
    expect(artifact.humanAttestation.sha256).toBe(persistedFreeze.inputIdentities.attestationSha256);
    expect(artifact.currentProviderCallSequence).toHaveLength(2);
    expect(artifact.currentProviderCallSequence.every((record) =>
      JSON.stringify(record.runIdentity) === JSON.stringify(artifact.runIdentity))).toBe(true);
    expect(artifact.runIdentity).toEqual({ runId: expect.stringMatching(/^forgewing-labelled-a3-[0-9a-f]{32}$/),
      createdAt: FIXED_TIME,
      runNonce: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
  });

  it('fails a pre-existing freeze write before any provider call', async () => {
    const freezePath = join(temporaryDirectory, 'freeze.json');
    writeFileSync(freezePath, 'immutable existing evidence\n');
    const provider = vi.fn(async () => '{}');
    await expect(runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
      freezeOutputPath: freezePath, provider }))).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(readFileSync(freezePath, 'utf8')).toBe('immutable existing evidence\n');
  });

  it('requires runner-owned freeze persistence for every enabled provider path', async () => {
    const provider = vi.fn(async () => '{}');
    await expect(runForgewingLabelledPricingA3(runnerParams({ executeProvider: true, provider })))
      .rejects.toThrow('A3_FREEZE_PERSISTENCE_REQUIRED');
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects a shared freeze and final/failure artifact path before provider work', async () => {
    const sharedPath = join(temporaryDirectory, 'shared.json');
    const provider = vi.fn(async () => '{}');
    await expect(runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
      freezeOutputPath: sharedPath, failureOutputPath: sharedPath, provider })))
      .rejects.toThrow('A3_ARTIFACT_PATH_COLLISION');
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects a corrupted freeze readback before any provider call', async () => {
    const validFreezePath = join(temporaryDirectory, 'valid.freeze.json');
    await runForgewingLabelledPricingA3(runnerParams({ freezeOutputPath: validFreezePath }));
    const freeze = JSON.parse(readFileSync(validFreezePath, 'utf8')) as A3FreezeArtifact;
    const freezePath = join(temporaryDirectory, 'corrupt-readback.freeze.json');
    const provider = vi.fn(async () => '{}');
    expect(() => persistA3FreezeArtifact(freezePath, freeze, {
        writeExclusive: (path: string, bytes: string) => writeFileSync(path, bytes),
        read: () => '{"corrupted":true}\n',
      })).toThrow('A3_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED');
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves the frozen identity when the provider fails', async () => {
    const freezePath = join(temporaryDirectory, 'provider-failure.freeze.json');
    const provider = vi.fn(async () => { throw new Error('synthetic provider failure'); });
    const artifact = await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
      repeatEachCandidate: true, freezeOutputPath: freezePath, provider }));
    const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(artifact.corpusStatus).toBe('labelled_a3_provider_unavailable');
    expect(artifact.runIdentity).toEqual(freeze.runIdentity);
    expect(artifact.preCallReport.runIdentity).toEqual(freeze.runIdentity);
    expect(artifact.currentProviderCallSequence[0]?.runIdentity).toEqual(freeze.runIdentity);
  });

  it('gives separate invocations unique identities even with the same timestamp', async () => {
    const first = await runForgewingLabelledPricingA3(runnerParams({
      freezeOutputPath: join(temporaryDirectory, 'first.freeze.json') }));
    const second = await runForgewingLabelledPricingA3(runnerParams({
      freezeOutputPath: join(temporaryDirectory, 'second.freeze.json') }));
    expect(first.runIdentity.createdAt).toBe(second.runIdentity.createdAt);
    expect(first.runIdentity.runId).not.toBe(second.runIdentity.runId);
    expect(first.runIdentity.runNonce).not.toBe(second.runIdentity.runNonce);
  });

  it('freezes an evaluation prompt contract and preserves its fixed calls after a rejected primary', async () => {
    const control = await runForgewingLabelledPricingA3(runnerParams({
      freezeOutputPath: join(temporaryDirectory, 'control.freeze.json') }));
    const freezePath = join(temporaryDirectory, 'experiment.freeze.json');
    const provider = vi.fn(async () => '{}');
    harness.runAttempts.mockImplementation(async (_candidates, options) => {
      await options.provider({ inputJson: '{"bounded":true}', maxOutputTokens: 2_000 });
      return [attempt('failed')];
    });
    const treatment = await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
      repeatEachCandidate: true, freezeOutputPath: freezePath, provider, callBudget: 2,
      experimentHardCallLimit: 4, disableCorrectiveRetries: true, forcePlannedRepeats: true,
      evaluationPromptVariant: { identifier: 'v3+a3-primitive-coverage-experiment',
        promptSha256: 'a'.repeat(64) } }));
    const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
    expect(provider).toHaveBeenCalledTimes(2);
    expect(treatment.currentProviderCallSequence.map((item) => item.repetition))
      .toEqual(['primary', 'repeat']);
    expect(treatment.callBudget.retries).toBe(0);
    expect(treatment.frozenProviderBundle.digestSha256).toBe(control.frozenProviderBundle.digestSha256);
    expect(treatment.runIdentity.runId).not.toBe(control.runIdentity.runId);
    expect(treatment.modelIdentity).toMatchObject({
      promptVersion: 'v3+a3-primitive-coverage-experiment', taskRetryLimitPerCandidate: 0,
    });
    expect(treatment.cases.every((item) =>
      item.responseMetadata.promptVersion === 'v3+a3-primitive-coverage-experiment')).toBe(true);
    expect(freeze.callConfiguration).toMatchObject({ configuredCallBudget: 2,
      plannedCalls: 2, hardCallLimit: 4, promptVersion: 'v3+a3-primitive-coverage-experiment',
      taskRetryLimitPerCandidate: 0,
      evaluationPromptVariant: { identifier: 'v3+a3-primitive-coverage-experiment',
        promptSha256: 'a'.repeat(64),
        effectiveCallContractDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });

  it('persists the same identity when execution is interrupted after provider invocation', async () => {
    const freezePath = join(temporaryDirectory, 'interrupted.freeze.json');
    const failurePath = join(temporaryDirectory, 'interrupted.json');
    const provider = vi.fn(async () => '{}');
    const originalError = new Error('synthetic post-provider interruption');
    const secondaryDiagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    harness.runAttempts.mockImplementationOnce(async (_candidates, options) => {
      await options.provider({ inputJson: '{}', maxOutputTokens: 2_000 });
      throw originalError;
    });
    let caught: unknown;
    try {
      await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
        freezeOutputPath: freezePath, failureOutputPath: failurePath, provider }));
    } catch (error) { caught = error; }
    const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
    const interrupted = JSON.parse(readFileSync(failurePath, 'utf8')) as A3InterruptionArtifact;
    expect(caught).toBe(originalError);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(interrupted.runIdentity).toEqual(freeze.runIdentity);
    expect(interrupted.preCallReport.runIdentity).toEqual(freeze.runIdentity);
    expect(interrupted.frozenProviderBundleDigest).toBe(freeze.frozenProviderBundle.digestSha256);
    expect(interrupted.interruption).toMatchObject({ reason: 'A3_RUN_INTERRUPTED_AFTER_FREEZE',
      callsAttempted: 1, completedCallRecords: 0 });
    expect(secondaryDiagnostic).not.toHaveBeenCalled();
  });

  it('preserves the provider root cause when an existing failure artifact blocks persistence', async () => {
    const freezePath = join(temporaryDirectory, 'occupied-provider.freeze.json');
    const failurePath = join(temporaryDirectory, 'occupied-provider.json');
    const existingBytes = 'immutable existing interruption evidence\n';
    writeFileSync(failurePath, existingBytes);
    const originalError = Object.assign(new Error('ORIGINAL_PROVIDER_FAILURE'), { code: 'PROVIDER_SENTINEL' });
    const provider = vi.fn(async () => { throw originalError; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    harness.runAttempts.mockImplementationOnce(async (_candidates, options) => {
      await options.provider({ inputJson: '{}', maxOutputTokens: 2_000 });
      return [attempt('applied')];
    });
    let caught: unknown;
    try {
      await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
        freezeOutputPath: freezePath, failureOutputPath: failurePath, provider }));
    } catch (error) { caught = error; }
    const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as A3FreezeArtifact;
    const diagnosticText = stderr.mock.calls.map(([value]) => String(value)).join('');
    expect(caught).toBe(originalError);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(readFileSync(failurePath, 'utf8')).toBe(existingBytes);
    expect(diagnosticText).toContain('A3_SECONDARY_DIAGNOSTIC');
    expect(diagnosticText).toContain('A3_INTERRUPTION_ARTIFACT_PERSISTENCE_FAILED');
    expect(diagnosticText).toContain(freeze.runIdentity.runId);
    expect(diagnosticText).toContain('EEXIST');
  });

  it('preserves a non-provider root cause after freeze when diagnostic persistence fails', async () => {
    const freezePath = join(temporaryDirectory, 'occupied-callback.freeze.json');
    const failurePath = join(temporaryDirectory, 'occupied-callback.json');
    writeFileSync(failurePath, 'existing\n');
    const originalError = new Error('ORIGINAL_NON_PROVIDER_FAILURE');
    const provider = vi.fn(async () => '{}');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let caught: unknown;
    try {
      await runForgewingLabelledPricingA3(runnerParams({ executeProvider: true,
        freezeOutputPath: freezePath, failureOutputPath: failurePath, provider,
        onPreCallReport: () => { throw originalError; } }));
    } catch (error) { caught = error; }
    expect(caught).toBe(originalError);
    expect(existsSync(freezePath)).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([value]) => String(value)).join(''))
      .toContain('A3_INTERRUPTION_ARTIFACT_PERSISTENCE_FAILED');
  });

  it('keeps injected interruption write and readback failures secondary', async () => {
    const artifact = await frozenInterruptionArtifact(join(temporaryDirectory, 'helper.freeze.json'));
    const scenarios = [
      { expected: 'FAILURE_ARTIFACT_WRITE_FAILED', io: {
        writeExclusive: () => { throw new Error('FAILURE_ARTIFACT_WRITE_FAILED'); },
        read: vi.fn(() => { throw new Error('unexpected read'); }) } },
      { expected: 'A3_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED', io: {
        writeExclusive: vi.fn(), read: () => '{"corrupted":true}\n' } },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const originalError = new Error(`ORIGINAL_RUN_FAILURE_${index}`);
      const diagnostics: A3InterruptionPersistenceFailureDiagnostic[] = [];
      let caught: unknown;
      try {
        preserveA3InterruptionRootCause({ originalError,
          failureOutputPath: join(temporaryDirectory, `injected-${index}.json`),
          interruptionArtifact: artifact, persistenceIo: scenario.io,
          reportSecondaryFailure: (diagnostic) => diagnostics.push(diagnostic) });
      } catch (error) { caught = error; }
      expect(caught).toBe(originalError);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: 'A3_INTERRUPTION_ARTIFACT_PERSISTENCE_FAILED', runId: artifact.runIdentity.runId,
        persistenceError: { message: scenario.expected } });
    }
    expect(scenarios[0].io.read).not.toHaveBeenCalled();
  });

  it('does not let secondary diagnostic reporting replace the original error', async () => {
    const artifact = await frozenInterruptionArtifact(join(temporaryDirectory, 'reporter.freeze.json'));
    const originalError = new Error('ORIGINAL_FAILURE_SURVIVES_REPORTER_FAILURE');
    let caught: unknown;
    try {
      preserveA3InterruptionRootCause({ originalError,
        failureOutputPath: join(temporaryDirectory, 'reporter.json'), interruptionArtifact: artifact,
        persistenceIo: { writeExclusive: () => { throw new Error('WRITE_FAILED'); }, read: () => '' },
        reportSecondaryFailure: () => { throw new Error('STDERR_FAILED'); } });
    } catch (error) { caught = error; }
    expect(caught).toBe(originalError);
  });

  it('rejects nonce-less legacy artifacts as resumable evidence', async () => {
    const artifact = await runForgewingLabelledPricingA3(runnerParams());
    const legacy = JSON.parse(JSON.stringify(artifact)) as { runIdentity: Record<string, unknown>;
      preCallReport: { runIdentity: Record<string, unknown> } };
    delete legacy.runIdentity.runNonce;
    delete legacy.preCallReport.runIdentity.runNonce;
    const legacyPath = join(temporaryDirectory, 'blocked-v5-legacy.json');
    writeFileSync(legacyPath, `${JSON.stringify(legacy)}\n`);
    await expect(runForgewingLabelledPricingA3(runnerParams({ priorAttemptArtifactPaths: [legacyPath] })))
      .rejects.toThrow('PRIOR_A3_RUN_IDENTITY_VERSION_UNSUPPORTED');
  });
});

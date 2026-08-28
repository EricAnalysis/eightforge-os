/**
 * REAL-SCOPE, PROVIDER-DISABLED. Runs the Phase C runner against the accepted
 * B-prime artifacts. Zero provider calls. Nothing accepted is mutated.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  createForgewingV2PhaseCProvider,
} from '@/scripts/evaluation/forgewingPricingV2PhaseCPrompt';
import {
  runForgewingPricingV2PhaseCMeasurement,
  FORGEWING_V2_PHASE_C_HARD_CALL_LIMIT,
} from '@/scripts/evaluation/runForgewingPricingV2PhaseCMeasurement';

const ROOT = 'C:/Dev/eightforge-os/scripts/evaluation/artifacts/';
const PACKAGE = `${ROOT}local-v2-bprime-review/forgewing-pricing-v2-human-labels.completed.json`;
const PHASE_B = `${ROOT}local-v2-phase-b/phase-b-f13c815.json`;
const PACKET = `${ROOT}local-v2-bprime-review-20260827T1102Z/phase-b-prime-review-packet-fc7433a.json`;

const configured = [PACKAGE, PHASE_B, PACKET].every((path) => existsSync(path));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forgewing-v2-phase-c-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function base(overrides: Record<string, unknown> = {}) {
  const prompt = createForgewingV2PhaseCProvider();
  return {
    humanLabelPackagePath: PACKAGE, phaseBArtifactPath: PHASE_B, reviewPacketPath: PACKET,
    prompt: { identifier: prompt.promptIdentifier, version: prompt.promptVersion,
      promptSha256: prompt.promptSha256 },
    model: 'claude-sonnet-4-6', codeCommit: null,
    freezeOutputPath: join(dir, 'freeze.json'),
    measurementOutputPath: join(dir, 'measurement.json'),
    executeProvider: false,
    now: () => new Date('2026-08-28T18:00:00.000Z'),
    runNonce: '00000000-0000-4000-8000-000000000000',
    ...overrides,
  };
}

describe.skipIf(!configured)('REAL SCOPE: Forgewing V2 Phase C provider-disabled dry run', () => {
  it('derives real scope, freezes before any call, and executes zero provider calls', async () => {
    const result = await runForgewingPricingV2PhaseCMeasurement(base() as never);

    // --- derived real scope ---
    expect(result.scope.rows).toHaveLength(5);
    expect(result.scope.fieldDenominator).toBe(17);
    expect(result.scope.contributionDenominator).toBe(19);
    expect(result.scope.rows.reduce((n, row) => n + row.fields.length, 0)).toBe(17);

    // deterministic ordering
    expect(result.scope.rows.map((row) => row.rowObservationId))
      .toEqual([...result.scope.rows.map((row) => row.rowObservationId)]
        .sort((a, b) => a.localeCompare(b, 'en-US')));

    // --- call planning and accounting ---
    expect(result.freezeArtifact.callPlan.plannedCalls).toBe(5);
    expect(result.freezeArtifact.callPlan.hardCallLimit)
      .toBe(FORGEWING_V2_PHASE_C_HARD_CALL_LIMIT);
    expect(result.freezeArtifact.callPlan.grain).toBe('one_provider_call_per_reasoning_row');
    expect(result.providerCallsExecuted).toBe(0);
    expect(result.measurement.providerAccounting).toMatchObject({
      plannedCalls: 5, providerCallsExecuted: 0, sdkRetries: 0,
      taskRetryLimitPerCandidate: 0, callRecords: [] });

    // --- freeze written and revalidated ---
    expect(existsSync(join(dir, 'freeze.json'))).toBe(true);
    const freezeBytes = readFileSync(join(dir, 'freeze.json'));
    expect(sha256Hex(freezeBytes)).toBe(result.freezeSha256);
    const freeze = JSON.parse(freezeBytes.toString('utf8'));
    expect(freeze.fixedDenominators).toEqual({ field: 17, contribution: 19 });
    expect(freeze.authority).toBe('non_authoritative_measurement');
    expect(freeze.promotionEvidence).toBe(false);
    expect(freeze.promotionAuthorized).toBe(false);
    expect(freeze.temperature).toBe(0);
    expect(freeze.sdkRetries).toBe(0);
    expect(freeze.taskRetryLimitPerCandidate).toBe(0);
    expect(freeze.scope.orderedSourceFieldIds).toHaveLength(17);
    expect(freeze.scope.orderedSourceObservationIds).toHaveLength(19);
    expect(freeze.runIdentity.runId).toMatch(/^forgewing-v2-phase-c-[0-9a-f]{32}$/);
    expect(freeze.prompt.promptSha256).toMatch(/^[a-f0-9]{64}$/);

    // --- denominators preserved with no provider output at all ---
    expect(result.measurement.scoring.fixedDenominators)
      .toEqual({ field: 17, contribution: 19 });
    expect(result.measurement.scoring.semanticRole).toMatchObject({
      denominator: 17, correct: 0, unavailable: 17 });
    expect(result.measurement.scoring.contributionRole).toMatchObject({
      denominator: 19, correct: 0, unavailable: 19 });
    expect(result.measurement.scoring.unavailability.byReason)
      .toEqual({ provider_disabled: 17 });
    expect(result.measurement.executionMode).toBe('provider_disabled_dry_run');

    // --- baselines derived from real human truth ---
    expect(result.measurement.scoring.semanticRole.structuralMapperBaseline)
      .toMatchObject({ matches: 15, denominator: 17 });
    expect(result.measurement.scoring.contributionRole.majorityClassBaseline)
      .toMatchObject({ role: 'semantic_head', matches: 10, denominator: 19 });
    expect(result.measurement.scoring.placeholderSafety.denominator).toBe(3);

    // --- warnings present ---
    expect(result.measurement.scoring.semanticRole.interpretation)
      .toBe('STRUCTURALLY_CONFOUNDED');
    expect(result.measurement.scoring.interpretationState.abstentionAppropriateness)
      .toBe('NOT_MEASURABLE_FROM_THIS_PACKAGE');
  }, 300000);

  it('never exposes human expected labels in the frozen provider input', async () => {
    const result = await runForgewingPricingV2PhaseCMeasurement(base() as never);
    const serialized = JSON.stringify(result.freezeArtifact.providerInput);
    for (const forbidden of ['expectedSemanticRole', 'expectedContributions',
      'expectedInterpretationState', 'contributionRole', 'reviewStatus', 'reviewer']) {
      expect(serialized).not.toContain(forbidden);
    }
  }, 300000);

  it('refuses to overwrite an existing freeze artifact', async () => {
    await runForgewingPricingV2PhaseCMeasurement(base() as never);
    await expect(runForgewingPricingV2PhaseCMeasurement(base({
      measurementOutputPath: join(dir, 'measurement-2.json') }) as never)).rejects.toThrow();
  }, 300000);

  it('fails closed when the provider is enabled without a provider', async () => {
    const provider = vi.fn();
    await expect(runForgewingPricingV2PhaseCMeasurement(base({
      executeProvider: true, freezeOutputPath: join(dir, 'freeze-b.json') }) as never))
      .rejects.toThrow('FORGEWING_V2_PHASE_C_PROVIDER_REQUIRED');
    expect(provider).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'freeze-b.json'))).toBe(false);
  }, 300000);

  it('rejects a shared freeze and measurement path before any work', async () => {
    const shared = join(dir, 'shared.json');
    await expect(runForgewingPricingV2PhaseCMeasurement(base({
      freezeOutputPath: shared, measurementOutputPath: shared }) as never))
      .rejects.toThrow('FORGEWING_V2_PHASE_C_ARTIFACT_PATH_COLLISION');
    expect(existsSync(shared)).toBe(false);
  }, 300000);
});

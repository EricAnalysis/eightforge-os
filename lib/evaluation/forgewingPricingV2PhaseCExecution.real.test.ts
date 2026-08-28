/**
 * REAL-SCOPE, INJECTED FAKE PROVIDERS ONLY. No network. No Anthropic. No OpenAI.
 *
 * Exercises the Phase C provider execution loop end to end against the accepted
 * B-prime artifacts using local spies that derive their answers from the frozen
 * provider input they receive.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  runForgewingPricingV2PhaseCMeasurement,
  type PhaseCUsageProvider,
} from '@/scripts/evaluation/runForgewingPricingV2PhaseCMeasurement';

const ROOT = 'C:/Dev/eightforge-os/scripts/evaluation/artifacts/';
const PACKAGE = `${ROOT}local-v2-bprime-review/forgewing-pricing-v2-human-labels.completed.json`;
const PHASE_B = `${ROOT}local-v2-phase-b/phase-b-f13c815.json`;
const PACKET = `${ROOT}local-v2-bprime-review-20260827T1102Z/phase-b-prime-review-packet-fc7433a.json`;
const configured = [PACKAGE, PHASE_B, PACKET].every((path) => existsSync(path));

type Input = {
  candidateId: string;
  fields: { sourceFieldId: string; members: { observationId: string }[] }[];
};

let dir: string;
let counter = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phase-c-exec-')); counter = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(provider: PhaseCUsageProvider | undefined, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return runForgewingPricingV2PhaseCMeasurement({
    humanLabelPackagePath: PACKAGE, phaseBArtifactPath: PHASE_B, reviewPacketPath: PACKET,
    prompt: { identifier: 'phase-c', version: 'v2c-1', promptSha256: 'a'.repeat(64) },
    model: 'claude-sonnet-4-6', codeCommit: null,
    freezeOutputPath: join(dir, `freeze-${counter}.json`),
    measurementOutputPath: join(dir, `measure-${counter}.json`),
    executeProvider: true, provider,
    now: () => new Date('2026-08-28T19:00:00.000Z'),
    runNonce: '00000000-0000-4000-8000-000000000000',
    ...overrides,
  } as never);
}

/** Builds a schema-valid, validator-valid proposal from the supplied input. */
function validProposal(input: Input, mutate?: (fields: Record<string, unknown>[]) => unknown) {
  const fieldInterpretations = input.fields.map((field) => ({
    sourceFieldId: field.sourceFieldId,
    semanticRole: 'rate_like_amount',
    interpretationState: 'observed',
    confidence: 0.9,
    contributions: field.members.map((member) => ({
      observationId: member.observationId, contributionRole: 'semantic_head' })),
    rationaleCodes: ['numeric_structure'],
  }));
  const mutated = mutate ? mutate(fieldInterpretations) : fieldInterpretations;
  return JSON.stringify({
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: input.candidateId, rowInterpretationState: 'observed', confidence: 0.85,
    fieldInterpretations: mutated,
  });
}

function spy(handler: (input: Input) => string | Promise<string>) {
  return vi.fn(async (request: { inputJson: string }) =>
    handler(JSON.parse(request.inputJson) as Input)) as unknown as PhaseCUsageProvider
    & ReturnType<typeof vi.fn>;
}

describe.skipIf(!configured)('REAL SCOPE: Phase C provider execution with injected fakes', () => {
  it('1-2. invokes the provider exactly once per planned row (5 rows -> 5 calls)', async () => {
    const provider = spy((input) => validProposal(input));
    const result = await run(provider);
    expect(provider).toHaveBeenCalledTimes(5);
    expect(result.providerCallsExecuted).toBe(5);
    expect(result.callRecords).toHaveLength(5);
    expect(result.callRecords.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(result.callRecords.every((r) => r.providerInvoked)).toBe(true);
  }, 300000);

  it('3. executes zero calls when the provider is disabled', async () => {
    const provider = spy((input) => validProposal(input));
    const result = await run(provider, { executeProvider: false });
    expect(provider).not.toHaveBeenCalled();
    expect(result.providerCallsExecuted).toBe(0);
    expect(result.callRecords).toEqual([]);
  }, 300000);

  it('4. cannot exceed the hard call budget', async () => {
    const provider = spy((input) => validProposal(input));
    await expect(run(provider, { callBudget: 4 })).rejects
      .toThrow('FORGEWING_V2_PHASE_C_CALL_BUDGET_EXCEEDED');
    expect(provider).not.toHaveBeenCalled();
  }, 300000);

  it('5. accepts a valid proposal and scores it through the join', async () => {
    const provider = spy((input) => validProposal(input));
    const result = await run(provider);
    expect(result.callRecords.every((r) => r.outcome === 'accepted')).toBe(true);
    expect(result.callRecords.every((r) => r.schemaValidationStatus === 'valid'
      && r.validatorStatus === 'valid')).toBe(true);
    expect(result.measurement.scoring.fixedDenominators).toEqual({ field: 17, contribution: 19 });
    // every field observed -> nothing unavailable
    expect(result.measurement.scoring.semanticRole.unavailable).toBe(0);
    expect(result.measurement.scoring.contributionRole.unavailable).toBe(0);
  }, 300000);

  it('6. classifies malformed JSON and still preserves raw bytes', async () => {
    const provider = spy(() => 'not json at all');
    const result = await run(provider);
    expect(provider).toHaveBeenCalledTimes(5);
    expect(result.callRecords.every((r) => r.outcome === 'malformed_json')).toBe(true);
    expect(result.callRecords.every((r) => r.rawOutput === 'not json at all'
      && r.rawOutputSha256 !== null && r.outputByteLength === 15)).toBe(true);
    expect(result.measurement.scoring.unavailability.byReason)
      .toEqual({ malformed_json: 17 });
  }, 300000);

  it('7. classifies schema rejection', async () => {
    const provider = spy(() => JSON.stringify({ proposalVersion: 'wrong' }));
    const result = await run(provider);
    expect(result.callRecords.every((r) => r.outcome === 'schema_rejected'
      && r.schemaValidationStatus === 'rejected' && r.validatorStatus === 'not_reached')).toBe(true);
    expect(result.measurement.scoring.unavailability.byReason)
      .toEqual({ schema_rejected: 17 });
  }, 300000);

  it.each([
    ['9. foreign member', (fields: Record<string, unknown>[]) => fields.map((f, i) => i === 0
      ? { ...f, contributions: [{ observationId: 'obs-foreign', contributionRole: 'semantic_head' }] }
      : f), 'foreign_contribution_observation'],
    ['11. duplicate member', (fields: Record<string, unknown>[]) => fields.map((f, i) => {
      if (i !== 0) return f;
      const c = (f.contributions as Record<string, unknown>[])[0]!;
      return { ...f, contributions: [c, c] };
    }), 'duplicate_contribution_observation'],
    ['12. unknown sourceFieldId', (fields: Record<string, unknown>[]) => fields.map((f, i) =>
      i === 0 ? { ...f, sourceFieldId: 'forgewing-source-field-unknown' } : f),
    'unknown_source_field_id'],
    ['14. missing field interpretation', (fields: Record<string, unknown>[]) => fields.slice(1),
      'missing_source_field_interpretation'],
  ])('8/%s is rejected by the authoritative validator', async (_label, mutate, code) => {
    const provider = spy((input) => validProposal(input, mutate as never));
    const result = await run(provider);
    expect(result.callRecords.every((r) => r.outcome === 'validator_rejected')).toBe(true);
    expect(result.callRecords.every((r) => r.schemaValidationStatus === 'valid'
      && r.validatorStatus === 'rejected')).toBe(true);
    expect(result.callRecords.flatMap((r) => r.violationCodes)).toContain(code);
    expect(result.measurement.scoring.unavailability.authoritativeViolationCodes[code as string])
      .toBeGreaterThan(0);
    expect(result.measurement.scoring.fixedDenominators)
      .toEqual({ field: 17, contribution: 19 });
  }, 300000);

  it('10/13. rejects a cross-field member and an identity mismatch', async () => {
    // cross-field: give field[0] a member that belongs to a sibling field in the same row.
    const crossField = spy((input) => validProposal(input, (fields) => {
      if (input.fields.length < 2) return fields;
      const sibling = input.fields[1]!.members[0]!.observationId;
      return fields.map((f, i) => i === 0
        ? { ...f, contributions: [{ observationId: sibling, contributionRole: 'semantic_head' }] }
        : f);
    }));
    const result = await run(crossField);
    const codes = result.callRecords.flatMap((r) => r.violationCodes);
    expect(result.callRecords.every((r) => r.outcome === 'validator_rejected')).toBe(true);
    expect(codes.some((c) => c === 'cross_field_contribution_observation'
      || c === 'contribution_membership_mismatch')).toBe(true);
  }, 300000);

  it('15. classifies a timeout and consumes the attempt', async () => {
    const provider = spy(() => { throw new Error('provider_timeout'); });
    const result = await run(provider);
    expect(provider).toHaveBeenCalledTimes(5);
    expect(result.providerCallsExecuted).toBe(5);
    expect(result.callRecords.every((r) => r.outcome === 'timeout')).toBe(true);
    expect(result.measurement.scoring.unavailability.byReason).toEqual({ timeout: 17 });
  }, 300000);

  it('16. classifies a provider exception and consumes the attempt', async () => {
    const provider = spy(() => { throw new Error('upstream exploded'); });
    const result = await run(provider);
    expect(result.providerCallsExecuted).toBe(5);
    expect(result.callRecords.every((r) => r.outcome === 'provider_error'
      && r.failureDetail === 'upstream exploded' && r.rawOutput === null)).toBe(true);
  }, 300000);

  it('17. retains raw output for rejected responses', async () => {
    const provider = spy(() => JSON.stringify({ proposalVersion: 'wrong' }));
    const result = await run(provider);
    for (const entry of result.callRecords) {
      expect(entry.rawOutput).toBe(JSON.stringify({ proposalVersion: 'wrong' }));
      expect(entry.rawOutputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.outputByteLength).toBeGreaterThan(0);
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.startedAt).toMatch(/T/);
      expect(entry.finishedAt).toMatch(/T/);
    }
    const persisted = JSON.parse(readFileSync(join(dir, `measure-${counter}.json`), 'utf8'));
    expect(persisted.rawResponses).toHaveLength(5);
    expect(persisted.rawResponses[0].rawOutput).toBeTruthy();
  }, 300000);

  it('18. retains provider usage when supplied, without affecting scoring', async () => {
    const base = spy((input) => validProposal(input));
    const provider = Object.assign(base, {
      lastUsage: () => ({ input_tokens: 11, output_tokens: 22 }),
    }) as PhaseCUsageProvider;
    const withUsage = await run(provider);
    const withoutUsage = await run(spy((input) => validProposal(input)));
    expect(withUsage.callRecords.every((r) =>
      (r.usage as { input_tokens: number }).input_tokens === 11)).toBe(true);
    expect(withoutUsage.callRecords.every((r) => r.usage === null)).toBe(true);
    expect(withUsage.measurement.scoring.contributionRole.correct)
      .toBe(withoutUsage.measurement.scoring.contributionRole.correct);
    expect(withUsage.runIdentity.runId).toBe(withoutUsage.runIdentity.runId);
  }, 300000);

  it('19. never shrinks a denominator under total provider failure', async () => {
    const provider = spy(() => { throw new Error('down'); });
    const result = await run(provider);
    expect(result.measurement.scoring.fixedDenominators)
      .toEqual({ field: 17, contribution: 19 });
    expect(result.measurement.scoring.semanticRole.unavailable).toBe(17);
    expect(result.measurement.scoring.contributionRole.unavailable).toBe(19);
    expect(result.measurement.scoring.contributionRole.accuracyFixedDenominator).toBe(0);
    expect(result.measurement.scoring.contributionRole
      .accuracyAmongScoredSecondaryDiagnostic).toBeNull();
  }, 300000);

  it('20. writes and verifies the freeze before the first provider invocation', async () => {
    let freezeAtFirstCall: string | null = null;
    const freezePath = join(dir, 'freeze-gate.json');
    const provider = spy((input) => {
      if (freezeAtFirstCall === null) {
        freezeAtFirstCall = existsSync(freezePath) ? readFileSync(freezePath, 'utf8') : '';
      }
      return validProposal(input);
    });
    const result = await run(provider, { freezeOutputPath: freezePath,
      measurementOutputPath: join(dir, 'measure-gate.json') });
    expect(freezeAtFirstCall).not.toBe('');
    expect(freezeAtFirstCall).not.toBeNull();
    expect(JSON.parse(freezeAtFirstCall!).runIdentity.runId).toBe(result.runIdentity.runId);
  }, 300000);

  it('regression: executeProvider=true can never silently skip the provider', async () => {
    const provider = spy((input) => validProposal(input));
    const result = await run(provider);
    // The pre-remediation defect was: 0 calls, 0 records, mode=provider_enabled.
    expect(result.measurement.executionMode).toBe('provider_enabled');
    expect(result.providerCallsExecuted).toBeGreaterThan(0);
    expect(result.callRecords.length).toBe(result.measurement.providerAccounting.plannedCalls);
    expect(provider.mock.calls.length).toBe(result.providerCallsExecuted);
  }, 300000);

  it('regression: enabling the provider without one fails closed before any freeze', async () => {
    const freezePath = join(dir, 'never.json');
    await expect(run(undefined, { freezeOutputPath: freezePath })).rejects
      .toThrow('FORGEWING_V2_PHASE_C_PROVIDER_REQUIRED');
    expect(existsSync(freezePath)).toBe(false);
  }, 300000);
});

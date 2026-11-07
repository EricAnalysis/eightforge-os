// The Sonnet 5.5 v1 and owner-label harness pins must describe the grammar their request builder actually
// sends. Before 2026-11-07 they copied the v1 accepted literal, so a production grammar change went undetected
// there. This proves both now hash the sent grammar and both report drift when it changes.
import { describe, expect, it, vi } from 'vitest';

const drift = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/forgewing/runtime/structuredOutput', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/forgewing/runtime/structuredOutput')>();
  const schema = actual.RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA;
  return {
    ...actual,
    get RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA() {
      return drift.enabled
        ? { ...schema, properties: { ...schema.properties, confidence: { type: 'number', minimum: 0, maximum: 1 } } }
        : schema;
    },
  };
});

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/structuredOutput';
import * as v1Harness from './phase17Sonnet55Pins';
import * as ownerLabelHarness from './phase17Sonnet55OwnerLabelPins';

const harnesses = [
  ['Sonnet 5.5 v1', v1Harness],
  ['Sonnet 5.5 owner-label', ownerLabelHarness],
] as const;

describe('Sonnet 5.5 harness pins hash the live sent grammar', () => {
  it.each(harnesses)('%s: computed schema digest equals the production grammar and the accepted pin', (_name, harness) => {
    drift.enabled = false;
    const computed = harness.computePhase17Sonnet55ContractPins(process.cwd());
    expect(computed.outputSchemaSha256).toBe(hashCanonical(RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA));
    expect(computed.outputSchemaSha256).toBe(harness.PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS.outputSchemaSha256);
    expect(harness.phase17Sonnet55ContractPinMismatches(computed)).toEqual([]);
  });

  it.each(harnesses)('%s: a changed production grammar is reported as outputSchemaSha256 drift', (_name, harness) => {
    drift.enabled = true;
    try {
      const computed = harness.computePhase17Sonnet55ContractPins(process.cwd());
      expect(computed.outputSchemaSha256).not.toBe(harness.PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS.outputSchemaSha256);
      expect(harness.phase17Sonnet55ContractPinMismatches(computed)).toContain('outputSchemaSha256');
    } finally {
      drift.enabled = false;
    }
  });
});

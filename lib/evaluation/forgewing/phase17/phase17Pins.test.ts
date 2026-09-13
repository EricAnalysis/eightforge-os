import { describe, expect, it } from 'vitest';

import {
  computePhase17ContractPins,
  lfSha256,
  PHASE17_ACCEPTED_CONTRACT_PINS,
  phase17ContractPinMismatches,
} from '@/lib/evaluation/forgewing/phase17/phase17Pins';

describe('Phase 17 behavioral contract pins', () => {
  it('matches the accepted prompt, schema, task, candidate, projection, planner and policy pins', () => {
    // A failure here means a measured contract changed: any prior Phase 17
    // result no longer describes this code, and the accepted pins need review.
    expect(computePhase17ContractPins(process.cwd())).toEqual(PHASE17_ACCEPTED_CONTRACT_PINS);
  });

  it('binds the qualification to the continuation ceiling Phase 16 accepted', () => {
    expect(PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy).toMatchObject({
      version: 'phase-16-v1',
      continuationQualification: 'corpus_qualified',
      continuationQualificationCeiling: 'controlled',
    });
  });

  it('reports every drifted pin by name', () => {
    const drifted = {
      ...PHASE17_ACCEPTED_CONTRACT_PINS,
      promptSha256: '0'.repeat(64),
      operationalPolicy: { ...PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
        continuationQualification: 'production_qualified' },
    };
    expect(phase17ContractPinMismatches(drifted)).toEqual(['promptSha256', 'operationalPolicy']);
  });

  it('normalizes CRLF checkouts before digesting source', () => {
    expect(lfSha256('a\r\nb\r\n')).toBe(lfSha256('a\nb\n'));
  });
});

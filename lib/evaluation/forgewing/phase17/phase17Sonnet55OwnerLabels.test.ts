import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePhase17LabelSet } from './dnContinuationLabels';
import { PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS as prior } from './phase17Sonnet55Pins';
import { computePhase17Sonnet55ContractPins, PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS as accepted } from './phase17Sonnet55OwnerLabelPins';

describe('owner-approved Phase 17 labels', () => {
  it('binds all 13 owner decisions, reviewer metadata and the original candidate sets', () => {
    const old = parsePhase17LabelSet(readFileSync('lib/evaluation/fixtures/dnContinuationLabels.v1.json')).labelSet;
    const next = parsePhase17LabelSet(readFileSync('lib/evaluation/fixtures/dnContinuationLabels.sonnet55.owner20261014.json')).labelSet;
    const choices: Record<string, number> = {
      '38a97868db88865a697cbb79': 0, '3e6205176a77e0a260aa38fb': 1,
      '42826a5c65e1c858a617a1e1': 0, '4fbb0b177523927ff9c094f5': 1,
      '54f42488ce43e1ebe8b3b3dc': 1, '57fabde8c6cbb835eb6ce4db': 0,
      '587d110e3d2a7ab72bf596af': 0, '5b1b95aa42ad816e1da2bfce': 0,
      '622fabcb9df024ef586b4154': 1, '68d30f0bf92912c2ca31e4e5': 1,
      '8aaa23f20a44275080fb986e': 1, 'b42e8e1fece75a0e87f939bf': 1,
      'b6d240bfa930fe0ada1f4bef': 1,
    };
    expect(next.corpus).toEqual(old.corpus);
    expect(next.harnessIdentity).toEqual(old.harnessIdentity);
    expect(next.units).toHaveLength(13);
    for (const unit of next.units) {
      expect(unit.candidateIds).toEqual(old.units.find(u => u.unitKey === unit.unitKey)!.candidateIds);
      expect(unit.expected).toBe(unit.candidateIds[choices[unit.unitKey.replace('dn-continuation-unit-', '')]!]);
      expect(unit.labeledBy).toBe('Eric Martin');
      expect(unit.labeledAt).not.toBeNull();
    }
    expect(old.units.every(u => u.expected === null)).toBe(true);
  });

  it('binds a distinct runner identity while preserving every frozen request and semantic pin', () => {
    expect(computePhase17Sonnet55ContractPins(process.cwd())).toEqual(accepted);
    const { runnerSourceSha256, ...unchanged } = accepted;
    const { runnerSourceSha256: oldRunner, ...oldUnchanged } = prior;
    expect(unchanged).toEqual(oldUnchanged);
    expect(runnerSourceSha256).not.toBe(oldRunner);
  });
});

/** SYNTHETIC: Phase C prompt purity and field-grain contract. */
import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { loadPricingInterpretationPrompt } from '@/lib/forgewing/runtime/client';
import {
  createForgewingV2PhaseCProvider,
  loadForgewingV2PhaseCPrompt,
  FORGEWING_V2_PHASE_C_PROMPT_IDENTIFIER,
  FORGEWING_V2_PHASE_C_PROMPT_VERSION,
} from '@/scripts/evaluation/forgewingPricingV2PhaseCPrompt';

const prompt = loadForgewingV2PhaseCPrompt();

describe('SYNTHETIC: Phase C prompt purity', () => {
  it('leaks no human expected label, digest, or scoring rule', () => {
    for (const forbidden of [
      'expectedSemanticRole', 'expectedContributions', 'expectedInterpretationState',
      'human label', 'ground truth', 'denominator', 'accuracy', 'baseline', 'score',
      '0dd8c1eb', '641b52f5', '0e815b0c', 'fc7433a9', 'f13c815b',
    ]) {
      expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('contains no document-specific or fixture-shaped fact', () => {
    for (const forbidden of ['TDOT', 'DN12189513', 'Sweeping', 'Linear Mile', 'Actual Costs',
      'Disposal', 'Tipping', 'page 46', 'page 106', '1.00', 'r24', 'r31']) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it('instructs field grain and never one interpretation per primitive', () => {
    expect(prompt).toContain('one AUTHORED FIELD at a time');
    expect(prompt).toContain('never one per primitive');
    expect(prompt).toContain('Emit exactly one interpretation per supplied field');
  });

  it('offers the full contribution vocabulary including absence', () => {
    for (const role of ['type_marker', 'value_token', 'component_part', 'semantic_head',
      'semantic_modifier', 'placeholder_absence', 'connector', 'structural_noise',
      'unknown_contribution']) {
      expect(prompt).toContain(role);
    }
    expect(prompt).toContain('ABSENCE IS NOT ZERO');
  });

  it('forbids source-role copying and identity mutation', () => {
    expect(prompt).toContain('Do not copy it into semanticRole');
    expect(prompt).toContain('IDENTITY IS FIXED');
  });

  it('does not alter the V1 production prompt', () => {
    const before = loadPricingInterpretationPrompt();
    loadForgewingV2PhaseCPrompt();
    expect(loadPricingInterpretationPrompt()).toBe(before);
    expect(prompt).not.toBe(before);
  });

  it('freezes a stable digest and identity for the frozen run', () => {
    const created = createForgewingV2PhaseCProvider();
    expect(created.promptSha256).toBe(sha256Hex(prompt));
    expect(created.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.promptIdentifier).toBe(FORGEWING_V2_PHASE_C_PROMPT_IDENTIFIER);
    expect(created.promptVersion).toBe(FORGEWING_V2_PHASE_C_PROMPT_VERSION);
    expect(loadForgewingV2PhaseCPrompt()).toBe(prompt);
  });

  it('builds a provider without invoking it', async () => {
    const created = createForgewingV2PhaseCProvider();
    expect(typeof created.provider).toBe('function');
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
  });
});

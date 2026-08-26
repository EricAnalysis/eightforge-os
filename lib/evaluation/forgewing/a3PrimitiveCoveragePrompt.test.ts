import { describe, expect, it } from 'vitest';

import { loadPricingInterpretationPrompt } from '@/lib/forgewing/runtime/client';
import {
  A3_PRIMITIVE_COVERAGE_PROMPT_IDENTIFIER,
  A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX,
  createA3PrimitiveCoverageExperimentProvider,
  loadA3PrimitiveCoverageExperimentPrompt,
} from '@/scripts/evaluation/forgewingA3PrimitiveCoveragePrompt';

describe('A3 primitive-coverage evaluation prompt', () => {
  it('adds exactly one generic suffix without changing production prompt bytes', () => {
    const production = loadPricingInterpretationPrompt();
    const treatment = loadA3PrimitiveCoverageExperimentPrompt();
    expect(treatment).toBe(`${production}\n${A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX}\n`);
    expect(treatment.startsWith(production)).toBe(true);
    expect(treatment.split(A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX)).toHaveLength(2);
    expect(loadPricingInterpretationPrompt()).toBe(production);
    expect(A3_PRIMITIVE_COVERAGE_PROMPT_IDENTIFIER)
      .toBe('v3+a3-primitive-coverage-experiment');
  });

  it('contains no candidate-specific identity, source text, or target answer', () => {
    for (const prohibited of [
      'TDOT', 'Sweeping', 'Linear Mile', 'Actual Costs', 'Disposal / Tipping Fees',
      'r24', 'r31', '1.00 is a rate', '- is unknown',
    ]) expect(A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX).not.toContain(prohibited);
    expect(A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX).toContain('exactly one interpretation');
    expect(A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX).toContain('emit it as unknown instead of omitting it');
  });

  it('freezes a stable digest over the full treatment system prompt', () => {
    const first = createA3PrimitiveCoverageExperimentProvider();
    const second = createA3PrimitiveCoverageExperimentProvider();
    expect(first.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.promptSha256).toBe(first.promptSha256);
  });
});

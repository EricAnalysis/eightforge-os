import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  callClaudeForPricingInterpretationWithEvaluationPrompt,
  loadPricingInterpretationPrompt,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';

export const A3_PRIMITIVE_COVERAGE_PROMPT_IDENTIFIER =
  'v3+a3-primitive-coverage-experiment' as const;

export const A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX = `Primitive coverage requirement for this evaluation: Emit exactly one interpretation object for every admitted primitive observation in rowObservation.cells. Set sourceCellId to that primitive's own observationId and include that same ID in evidenceIds. When multiple primitives jointly form one semantic field, preserve the shared field reasoning while emitting a separate interpretation for each primitive that describes that primitive's semantic contribution. If a primitive has no independent semantic role, emit it as unknown instead of omitting it.`;

export function loadA3PrimitiveCoverageExperimentPrompt(): string {
  return `${loadPricingInterpretationPrompt()}\n${A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX}\n`;
}

export function createA3PrimitiveCoverageExperimentProvider(): Readonly<{
  provider: ForgewingProvider;
  promptIdentifier: typeof A3_PRIMITIVE_COVERAGE_PROMPT_IDENTIFIER;
  promptSha256: string;
}> {
  const prompt = loadA3PrimitiveCoverageExperimentPrompt();
  return {
    provider: (request) => callClaudeForPricingInterpretationWithEvaluationPrompt(request, prompt),
    promptIdentifier: A3_PRIMITIVE_COVERAGE_PROMPT_IDENTIFIER,
    promptSha256: sha256Hex(prompt),
  };
}

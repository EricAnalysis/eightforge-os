import type { RecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { PHASE17_APPROVED_MODEL } from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  loadRecoveryCandidateV2Prompt,
  type ForgewingProvider,
  type ForgewingProviderObserver,
} from '@/lib/forgewing/runtime/client';
import type { ForgewingRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';

/** Mock provider for Phase 17 tests. Reports observations like the real seam; never a network call. */

/** The synthetic cohort labels the "above" target row as the human answer. */
function aboveCandidateId(candidates: readonly RecoveryCandidateV2[]): string {
  return candidates.find((candidate) =>
    candidate.targetContextEvidence?.rawTexts[0]?.includes('above'))!.candidateId;
}

export const PHASE17_TEST_RUNTIME_CONFIG: ForgewingRuntimeConfig = {
  enabled: false,
  model: PHASE17_APPROVED_MODEL,
  timeoutMs: 3_000,
  maxCalls: 1,
  maxOutputTokens: 800,
};

export type MockDecision = (candidates: readonly RecoveryCandidateV2[]) =>
  | Readonly<{ output: string; stopReason?: string }>
  | Readonly<{ throws: Error }>;

/** A mock provider factory that reports observations like the real seam. */
export function mockPhase17ProviderFactory(decide: MockDecision, calls: { count: number } = { count: 0 }) {
  return (observer: ForgewingProviderObserver): ForgewingProvider => async (request) => {
    calls.count += 1;
    const parsed = JSON.parse(request.inputJson) as { candidates: RecoveryCandidateV2[] };
    const decision = decide(parsed.candidates);
    if ('throws' in decision) throw decision.throws;
    observer({
      messageId: `msg_mock_${calls.count}`,
      requestId: `req_mock_${calls.count}`,
      returnedModel: request.model,
      stopReason: decision.stopReason ?? 'end_turn',
      inputTokens: 2_000,
      outputTokens: 40,
      latencyMs: 25,
      // Mirrors the real seam: the digest of the exact system prompt it would send.
      systemPromptSha256: sha256Hex(loadRecoveryCandidateV2Prompt()),
    });
    return decision.output;
  };
}

export function selectionOutput(candidateId: string, confidence = 0.9,
  rationaleCode = 'geometric_continuation'): string {
  return JSON.stringify({ selectedCandidateId: candidateId, confidence, rationaleCode });
}

export const chooseAbove: MockDecision = (candidates) =>
  ({ output: selectionOutput(aboveCandidateId(candidates)) });

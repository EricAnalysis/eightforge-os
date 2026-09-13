import { z } from 'zod';

import { canonicalJson } from '@/lib/extraction/domain/hash';
import { RecoveryCandidateV2Schema, type RecoveryCandidateV2 }
  from '@/lib/extraction/recovery/recoveryCandidateV2';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForRecoveryCandidateV2,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import { readRecoveryOperationalConfig }
  from '@/lib/extraction/recovery/recoveryOperationalPolicy';

const outputSchema = z.object({
  selectedCandidateId: z.string().regex(/^recovery-candidate-v2-[a-f0-9]{64}$/),
  confidence: z.number().min(0).max(1),
  rationaleCode: z.string().min(1).max(200),
}).strict();

export type RecoveryCandidateV2RecommendationInput = Readonly<{
  organizationId: string;
  extractionSnapshotId: string;
  candidates: readonly RecoveryCandidateV2[];
}>;

export type RecoveryCandidateV2RecommendationResult =
  | Readonly<{ status: 'eligible_not_executed'; reason: 'recovery_disabled' | 'budget_exhausted'; providerCalls: 0 }>
  | Readonly<{ status: 'provider_failed' | 'structured_output_invalid' | 'evidence_binding_failed'; reason: string; providerCalls: number }>
  | Readonly<{ status: 'requires_human_review'; selectedCandidateId: string; confidence: number;
      rationaleCode: string; providerCalls: 1; model: string;
      promptTemplateId: typeof FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID;
      promptTemplateVersion: typeof FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION }>;

export async function runRecoveryCandidateV2Recommendation(
  input: RecoveryCandidateV2RecommendationInput,
  dependencies: Readonly<{
    config?: ForgewingRuntimeConfig;
    enabled?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
    provider?: ForgewingProvider;
    budget?: ForgewingCallBudget;
  }> = {},
): Promise<RecoveryCandidateV2RecommendationResult> {
  const parsed = z.array(RecoveryCandidateV2Schema).min(1).max(32).safeParse(input.candidates);
  if (!parsed.success || new Set(parsed.data.map((entry) => entry.candidateId)).size !== parsed.data.length) {
    return { status: 'evidence_binding_failed', reason: 'candidate_closure_failed', providerCalls: 0 };
  }
  const recoveryTypes = new Set(parsed.data.map((entry) => entry.recoveryType));
  if (recoveryTypes.size !== 1) {
    return { status: 'evidence_binding_failed', reason: 'candidate_closure_failed', providerCalls: 0 };
  }
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  const recoveryType = parsed.data[0]!.recoveryType;
  const activation = readRecoveryOperationalConfig(dependencies.env ?? process.env, {
    emitWarnings: true, context: 'recovery_candidate_v2_runner',
  })
    .activationByType[recoveryType];
  if (!config.enabled || dependencies.enabled === false || activation === 'disabled') {
    return { status: 'eligible_not_executed', reason: 'recovery_disabled', providerCalls: 0 };
  }
  const budget = dependencies.budget ?? new ForgewingCallBudget(1);
  if (!budget.tryConsume()) {
    return { status: 'eligible_not_executed', reason: 'budget_exhausted', providerCalls: 0 };
  }
  let raw: string;
  try {
    raw = await (dependencies.provider ?? callClaudeForRecoveryCandidateV2)({
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: Math.min(config.maxOutputTokens, 400),
      inputJson: canonicalJson({
        taskType: 'recovery_candidate_v2',
        candidates: parsed.data,
      }),
    });
  } catch (error) {
    return { status: 'provider_failed',
      reason: error instanceof Error ? error.message : String(error), providerCalls: 1 };
  }
  let output: z.infer<typeof outputSchema>;
  try {
    output = outputSchema.parse(JSON.parse(raw));
  } catch {
    return { status: 'structured_output_invalid', reason: 'invalid_json', providerCalls: 1 };
  }
  if (!parsed.data.some((candidate) => candidate.candidateId === output.selectedCandidateId)) {
    return { status: 'evidence_binding_failed', reason: 'unknown_candidate', providerCalls: 1 };
  }
  return {
    status: 'requires_human_review', ...output, providerCalls: 1,
    model: config.model,
    promptTemplateId: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
    promptTemplateVersion: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
  };
}

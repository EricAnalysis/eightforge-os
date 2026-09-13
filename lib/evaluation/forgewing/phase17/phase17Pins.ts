import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  RECOVERY_OPERATIONAL_POLICY,
  RECOVERY_OPERATIONAL_POLICY_DIGEST,
  RECOVERY_OPERATIONAL_POLICY_VERSION,
} from '@/lib/extraction/recovery/recoveryOperationalPolicy';
import {
  buildForgewingStructuredOutputRequest,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
  loadRecoveryCandidateV2Prompt,
} from '@/lib/forgewing/runtime/client';
import { RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/structuredOutput';

/**
 * Behavioral contract pins for Phase 17.
 *
 * A qualification describes one exact prompt, request builder, schema, task
 * validation, candidate contract, durable projection, progression planner and
 * operational policy. Each is digested here and compared with the accepted value
 * below; any difference aborts the run before a provider call. Changing an
 * accepted value is a deliberate, reviewed act that invalidates any previous
 * Phase 17 result.
 *
 * Two kinds of digest, deliberately different:
 *  - The prompt digest is over the EXACT runtime bytes the provider receives. It
 *    is never normalized: a CRLF checkout sends different bytes than production
 *    and must not pass as equivalent.
 *  - Source-file digests detect code drift and are LF-normalized, so a Windows
 *    checkout of unchanged code does not look like a contract change.
 */

export const PHASE17_CONTRACT_FILES = {
  task: 'lib/forgewing/tasks/recoveryCandidateV2.ts',
  candidate: 'lib/extraction/recovery/recoveryCandidateV2.ts',
  durableProposal: [
    'lib/forgewingRecoveryProposal.ts',
    'lib/server/forgewingRecoveryProposalPersistence.ts',
  ],
  planner: 'lib/extraction/recovery/recoveryEvaluationPlanner.ts',
  requestBuilder: 'lib/forgewing/runtime/client.ts',
} as const;

export const PHASE17_REQUEST_CONTRACT_MARKERS = {
  begin: '// forgewing-request-contract:begin',
  end: '// forgewing-request-contract:end',
} as const;

/** Request parameters read back from the production builder, not written by hand. */
export type Phase17RequestContract = Readonly<{
  temperature: number;
  maxRetries: number;
  bodyKeys: readonly string[];
  optionKeys: readonly string[];
  bindsModel: boolean;
  bindsMaxOutputTokens: boolean;
  bindsTimeout: boolean;
  bindsSystemPromptExactly: boolean;
  bindsOutputSchema: boolean;
  bindsUserInputExactly: boolean;
}>;

export type Phase17ContractPins = Readonly<{
  promptTemplateId: string;
  promptTemplateVersion: string;
  promptSha256: string;
  outputSchemaSha256: string;
  requestBuilderSourceSha256: string;
  requestContract: Phase17RequestContract;
  taskContractSha256: string;
  candidateContractSha256: string;
  durableProposalContractSha256: string;
  plannerContractSha256: string;
  operationalPolicy: Readonly<{
    version: string;
    digest: string;
    continuationQualification: string;
    continuationQualificationCeiling: string;
  }>;
}>;

/** Accepted at Phase 17 implementation. Updating these requires review. */
export const PHASE17_ACCEPTED_CONTRACT_PINS: Phase17ContractPins = {
  promptTemplateId: 'forgewing-recovery-candidate-v2',
  promptTemplateVersion: 'v2',
  promptSha256: '55bb0262885388b2d96ce33075eac73df6ce25bc23a92a6ae204e5f3242214da',
  outputSchemaSha256: 'c480562d6cbac049adc4ad6e0c4937399514bac6f43336e418c20b88e61b5b18',
  requestBuilderSourceSha256: 'e2b6cd67cf01fb196924a3a68a79abee19698d47a2bf323f6efacf1a674d2845',
  requestContract: {
    temperature: 0,
    maxRetries: 0,
    bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'system', 'temperature'],
    optionKeys: ['maxRetries', 'timeout'],
    bindsModel: true,
    bindsMaxOutputTokens: true,
    bindsTimeout: true,
    bindsSystemPromptExactly: true,
    bindsOutputSchema: true,
    bindsUserInputExactly: true,
  },
  taskContractSha256: 'b67847fd5668c40d3ec7143cbd90d4de8ed66986b82b259be2dce29429b2add9',
  candidateContractSha256: '6a48ebf3b62def7bd139af8db72ec580dc34dc5ec5ca0ac7c977dcebb8a307b9',
  durableProposalContractSha256: 'ba17f9acccd16696fbb7abcf8521572a0e5a6f15fbb0596b435ffd85b5c3203f',
  plannerContractSha256: 'f30dbad74456d89d4c7a41a3a28768dc182f2c5bffea7003e87be2d1265d21aa',
  operationalPolicy: {
    version: 'phase-16-v1',
    digest: '19bb1e926871fbf24c8e5d46cc2e4c23d62e444d6420d89c6df8b5bdc6d64e86',
    continuationQualification: 'corpus_qualified',
    continuationQualificationCeiling: 'controlled',
  },
};

/** Code-drift digest only. Never used for bytes sent to a provider. */
export function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Digest of the exact prompt string the provider receives, without normalization. */
export function exactPromptSha256(prompt: string): string {
  return sha256Hex(prompt);
}

export function phase17PromptHasCarriageReturn(prompt: string): boolean {
  return prompt.includes('\r');
}

function fileDigest(repoRoot: string, relative: string): string {
  return lfSha256(readFileSync(path.join(repoRoot, relative), 'utf8'));
}

/** LF-normalized digest of the marked request-builder region in client.ts. */
export function requestBuilderSourceDigest(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const begin = text.indexOf(PHASE17_REQUEST_CONTRACT_MARKERS.begin);
  const end = text.indexOf(PHASE17_REQUEST_CONTRACT_MARKERS.end);
  if (begin < 0 || end <= begin
    || text.indexOf(PHASE17_REQUEST_CONTRACT_MARKERS.begin, begin + 1) >= 0) {
    throw new Error('PHASE17_REQUEST_CONTRACT_MARKERS_INVALID');
  }
  return lfSha256(text.slice(begin, end + PHASE17_REQUEST_CONTRACT_MARKERS.end.length));
}

/** Builds a probe request through production code and reads its contract back. */
export function derivePhase17RequestContract(prompt: string): Phase17RequestContract {
  const probe = { model: 'phase17-probe-model', timeoutMs: 2_468, maxOutputTokens: 357,
    inputJson: '{"phase17":"probe"}' };
  const { body, options } = buildForgewingStructuredOutputRequest(
    probe, prompt, RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA);
  return {
    temperature: body.temperature,
    maxRetries: options.maxRetries,
    bodyKeys: Object.keys(body).sort(),
    optionKeys: Object.keys(options).sort(),
    bindsModel: body.model === probe.model,
    bindsMaxOutputTokens: body.max_tokens === probe.maxOutputTokens,
    bindsTimeout: options.timeout === probe.timeoutMs,
    bindsSystemPromptExactly: body.system === prompt,
    bindsOutputSchema: body.output_config.format.schema === RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA
      && body.output_config.format.type === 'json_schema',
    bindsUserInputExactly: body.messages.length === 1 && body.messages[0]!.role === 'user'
      && body.messages[0]!.content === probe.inputJson,
  };
}

export function computePhase17ContractPins(repoRoot: string): Phase17ContractPins {
  const continuation = RECOVERY_OPERATIONAL_POLICY.priced_schedule_continuation_attribution;
  const prompt = loadRecoveryCandidateV2Prompt();
  return {
    promptTemplateId: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
    promptTemplateVersion: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
    promptSha256: exactPromptSha256(prompt),
    outputSchemaSha256: hashCanonical(RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA),
    requestBuilderSourceSha256: requestBuilderSourceDigest(
      readFileSync(path.join(repoRoot, PHASE17_CONTRACT_FILES.requestBuilder), 'utf8')),
    requestContract: derivePhase17RequestContract(prompt),
    taskContractSha256: fileDigest(repoRoot, PHASE17_CONTRACT_FILES.task),
    candidateContractSha256: fileDigest(repoRoot, PHASE17_CONTRACT_FILES.candidate),
    durableProposalContractSha256: hashCanonical(PHASE17_CONTRACT_FILES.durableProposal
      .map((relative) => ({ relative, sha256: fileDigest(repoRoot, relative) }))),
    plannerContractSha256: fileDigest(repoRoot, PHASE17_CONTRACT_FILES.planner),
    operationalPolicy: {
      version: RECOVERY_OPERATIONAL_POLICY_VERSION,
      digest: RECOVERY_OPERATIONAL_POLICY_DIGEST,
      continuationQualification: continuation.qualification,
      continuationQualificationCeiling: continuation.qualificationCeiling,
    },
  };
}

export function phase17ContractPinMismatches(
  actual: Phase17ContractPins,
  accepted: Phase17ContractPins = PHASE17_ACCEPTED_CONTRACT_PINS,
): readonly string[] {
  return (Object.keys(accepted) as (keyof Phase17ContractPins)[]).flatMap((key) =>
    hashCanonical(actual[key]) === hashCanonical(accepted[key]) ? [] : [key]);
}

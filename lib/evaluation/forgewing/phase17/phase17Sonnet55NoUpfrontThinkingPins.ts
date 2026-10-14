import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  PHASE17_ACCEPTED_CONTRACT_PINS,
  exactPromptSha256,
  lfSha256,
  type Phase17ContractPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Pins';
import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION,
  PHASE17_SONNET_55_NO_UPFRONT_THINKING_MODEL,
  type Phase17Sonnet55NoUpfrontThinkingPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55NoUpfrontThinkingContract';
import {
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
  loadRecoveryCandidateV2Prompt,
} from '@/lib/forgewing/runtime/client';
import { buildPhase17Sonnet55NoUpfrontThinkingStructuredOutputRequest,
  PHASE17_SONNET_55_NO_UPFRONT_THINKING_OUTPUT_SCHEMA }
  from '@/lib/forgewing/runtime/phase17Sonnet55NoUpfrontThinkingQualificationClient';

export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES = {
  requestBuilder: 'lib/forgewing/runtime/phase17Sonnet55NoUpfrontThinkingQualificationClient.ts',
  runner: 'lib/evaluation/forgewing/phase17/phase17Sonnet55NoUpfrontThinkingRun.ts',
  qualification: 'lib/evaluation/forgewing/phase17/phase17Qualification.ts',
  contract: 'lib/evaluation/forgewing/phase17/phase17Contract.ts',
} as const;

export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_MARKERS = {
  begin: '// phase17-sonnet-55-request-contract:begin',
  end: '// phase17-sonnet-55-request-contract:end',
} as const;

export type Phase17Sonnet55NoUpfrontThinkingRequestContract = Readonly<{
  sampling: Readonly<{ temperature: Readonly<{ state: 'omitted' }> }>;
  schemaTransformation: 'confidence-provider-bounds-omitted-local-bounds-preserved-v1';
  thinking: Readonly<{ type: 'between_tools' }>;
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

export type Phase17Sonnet55NoUpfrontThinkingContractPins = Omit<Phase17ContractPins,
  'requestBuilderSourceSha256' | 'requestContract'> & Readonly<{
  requestBuilderSourceSha256: string;
  requestContract: Phase17Sonnet55NoUpfrontThinkingRequestContract;
  clientSourceSha256: string;
  runnerSourceSha256: string;
  qualificationFrameworkVersion: typeof PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION;
  qualificationSemanticsSha256: string;
}>;

function fileDigest(repoRoot: string, relative: string): string {
  return lfSha256(readFileSync(path.join(repoRoot, relative), 'utf8'));
}

export function phase17Sonnet55NoUpfrontThinkingRequestBuilderSourceDigest(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const begin = text.indexOf(PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_MARKERS.begin);
  const end = text.indexOf(PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_MARKERS.end);
  if (begin < 0 || end <= begin
    || text.indexOf(PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_MARKERS.begin, begin + 1) >= 0) {
    throw new Error('PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_CONTRACT_MARKERS_INVALID');
  }
  return lfSha256(text.slice(begin, end + PHASE17_SONNET_55_NO_UPFRONT_THINKING_REQUEST_MARKERS.end.length));
}

export function derivePhase17Sonnet55NoUpfrontThinkingRequestContract(prompt: string): Phase17Sonnet55NoUpfrontThinkingRequestContract {
  const probe = {
    model: PHASE17_SONNET_55_NO_UPFRONT_THINKING_MODEL,
    timeoutMs: 2_468,
    maxOutputTokens: 357,
    inputJson: '{"phase17":"sonnet-5-5-probe"}',
  };
  const { body, options } = buildPhase17Sonnet55NoUpfrontThinkingStructuredOutputRequest(probe, prompt);
  return {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-local-bounds-preserved-v1',
    thinking: { type: 'between_tools' },
    maxRetries: options.maxRetries,
    bodyKeys: Object.keys(body).sort(),
    optionKeys: Object.keys(options).sort(),
    bindsModel: body.model === probe.model,
    bindsMaxOutputTokens: body.max_tokens === probe.maxOutputTokens,
    bindsTimeout: options.timeout === probe.timeoutMs,
    bindsSystemPromptExactly: body.system === prompt,
    bindsOutputSchema: body.output_config.format.type === 'json_schema',
    bindsUserInputExactly: body.messages.length === 1
      && body.messages[0]!.role === 'user'
      && body.messages[0]!.content === probe.inputJson,
  };
}

export function phase17Sonnet55NoUpfrontThinkingQualificationSemanticsDigest(repoRoot: string): string {
  return hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    qualificationSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES.qualification),
    contractSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES.contract),
  });
}

export function computePhase17Sonnet55NoUpfrontThinkingContractPins(repoRoot: string): Phase17Sonnet55NoUpfrontThinkingContractPins {
  const prompt = loadRecoveryCandidateV2Prompt();
  return {
    promptTemplateId: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
    promptTemplateVersion: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
    promptSha256: exactPromptSha256(prompt),
    outputSchemaSha256: hashCanonical(PHASE17_SONNET_55_NO_UPFRONT_THINKING_OUTPUT_SCHEMA),
    requestBuilderSourceSha256: phase17Sonnet55NoUpfrontThinkingRequestBuilderSourceDigest(readFileSync(
      path.join(repoRoot, PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES.requestBuilder), 'utf8')),
    clientSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES.requestBuilder),
    runnerSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_NO_UPFRONT_THINKING_CONTRACT_FILES.runner),
    requestContract: derivePhase17Sonnet55NoUpfrontThinkingRequestContract(prompt),
    taskContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.taskContractSha256,
    candidateContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.candidateContractSha256,
    durableProposalContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.durableProposalContractSha256,
    plannerContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.plannerContractSha256,
    operationalPolicy: PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
    qualificationFrameworkVersion: PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION,
    qualificationSemanticsSha256: phase17Sonnet55NoUpfrontThinkingQualificationSemanticsDigest(repoRoot),
  };
}

/**
 * The additive identity intentionally reuses every v1 semantic pin and changes
 * only its model/request/framework identity. Filled from reviewed literals so a
 * later v1 drift cannot silently redefine this contract.
 */
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_ACCEPTED_CONTRACT_PINS: Phase17Sonnet55NoUpfrontThinkingContractPins = {
  promptTemplateId: 'forgewing-recovery-candidate-v2',
  promptTemplateVersion: 'v2',
  promptSha256: '55bb0262885388b2d96ce33075eac73df6ce25bc23a92a6ae204e5f3242214da',
  outputSchemaSha256: 'e9bd736705d8b6e6c6109300e1c8ba6a77b242c4e79b6537cf5eca035ecc0864',
  requestBuilderSourceSha256: '28381eeebae79d02b04085e5000197f05dcb8787c41adee7ce27baed9f2af43c',
  clientSourceSha256: '1ba0cc20a698e0f2eaa159dc5badcacc1a035a4f5e7b6befadbdd8911d17bdf3',
  runnerSourceSha256: 'bf0ba12383df8517beb67f2992f8f5deb6323c577fd40b86ccc3a06e2cfe905d',
  requestContract: {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-local-bounds-preserved-v1',
    thinking: { type: 'between_tools' },
    maxRetries: 0,
    bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'],
    optionKeys: ['maxRetries', 'timeout'],
    bindsModel: true,
    bindsMaxOutputTokens: true,
    bindsTimeout: true,
    bindsSystemPromptExactly: true,
    bindsOutputSchema: true,
    bindsUserInputExactly: true,
  },
  taskContractSha256: '127c41006855b910d423ec6d436c220a0e24bb98974b20e71a9580a8679719ae',
  candidateContractSha256: '26ed2eb160be1d88a223a5737fca75b0950fcc537b3235aae72bd6e89575308f',
  durableProposalContractSha256: '3e0992f270f908e7800140af374fc892bd27f8dad638fac1d67546810f27be0c',
  plannerContractSha256: '5c3e0c4e755c5f30fabc0d89da31b0cc891a82379fa6fd4b74cc132d82c09fef',
  operationalPolicy: {
    version: 'phase-16-v1',
    digest: '58d29066479981434bf0af04c4cb18cd0e09a826033bcfc099d2acd4bafc4fa5',
    continuationQualification: 'corpus_qualified',
    continuationQualificationCeiling: 'controlled',
  },
  qualificationFrameworkVersion: PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION,
  qualificationSemanticsSha256: '0629287e2753f21f3d35cd6d5a71db2cdec9ec6c150a847d587888d11130c70b',
};

export function phase17Sonnet55NoUpfrontThinkingContractPinMismatches(
  actual: Phase17Sonnet55NoUpfrontThinkingContractPins,
  accepted: Phase17Sonnet55NoUpfrontThinkingContractPins = PHASE17_SONNET_55_NO_UPFRONT_THINKING_ACCEPTED_CONTRACT_PINS,
): readonly string[] {
  return (Object.keys(accepted) as (keyof Phase17Sonnet55NoUpfrontThinkingContractPins)[]).flatMap((key) =>
    hashCanonical(actual[key]) === hashCanonical(accepted[key]) ? [] : [key]);
}

export function phase17Sonnet55NoUpfrontThinkingPinsForArtifact(
  base: Omit<Phase17Sonnet55NoUpfrontThinkingPins, keyof Phase17Sonnet55NoUpfrontThinkingContractPins>,
  contract: Phase17Sonnet55NoUpfrontThinkingContractPins,
): Phase17Sonnet55NoUpfrontThinkingPins {
  return { ...base, ...contract } as Phase17Sonnet55NoUpfrontThinkingPins;
}



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
  PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION,
  PHASE17_SONNET_55_BEHAVIORAL_PROMPT_MODEL,
  type Phase17Sonnet55BehavioralPromptPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55BehavioralPromptContract';
import { buildPhase17Sonnet55BehavioralPromptStructuredOutputRequest,
  loadPhase17Sonnet55BehavioralPromptPrompt,
  PHASE17_SONNET_55_BEHAVIORAL_PROMPT_OUTPUT_SCHEMA,
  PHASE17_SONNET_55_BEHAVIORAL_PROMPT_PROMPT_ID,
  PHASE17_SONNET_55_BEHAVIORAL_PROMPT_PROMPT_VERSION }
  from '@/lib/forgewing/runtime/phase17Sonnet55BehavioralPromptQualificationClient';

export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES = {
  requestBuilder: 'lib/forgewing/runtime/phase17Sonnet55BehavioralPromptQualificationClient.ts',
  runner: 'lib/evaluation/forgewing/phase17/phase17Sonnet55BehavioralPromptRun.ts',
  qualification: 'lib/evaluation/forgewing/phase17/phase17Qualification.ts',
  contract: 'lib/evaluation/forgewing/phase17/phase17Contract.ts',
} as const;

export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_MARKERS = {
  begin: '// phase17-sonnet-55-request-contract:begin',
  end: '// phase17-sonnet-55-request-contract:end',
} as const;

export type Phase17Sonnet55BehavioralPromptRequestContract = Readonly<{
  sampling: Readonly<{ temperature: Readonly<{ state: 'omitted' }> }>;
  schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1';
  thinking: Readonly<{ type: 'between_tools' }>;
  maxRetries: number;
  bodyKeys: readonly string[];
  optionKeys: readonly string[];
  bindsModel: boolean;
  bindsMaxOutputTokens: boolean;
  bindsTimeout: boolean;
  bindsSystemPromptExactly: boolean;
  bindsOutputSchema: boolean;
  bindsThinkingMode: boolean;
  bindsUserInputExactly: boolean;
}>;

export type Phase17Sonnet55BehavioralPromptContractPins = Omit<Phase17ContractPins,
  'requestBuilderSourceSha256' | 'requestContract'> & Readonly<{
  requestBuilderSourceSha256: string;
  requestContract: Phase17Sonnet55BehavioralPromptRequestContract;
  clientSourceSha256: string;
  runnerSourceSha256: string;
  qualificationFrameworkVersion: typeof PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION;
  qualificationSemanticsSha256: string;
}>;

function fileDigest(repoRoot: string, relative: string): string {
  return lfSha256(readFileSync(path.join(repoRoot, relative), 'utf8'));
}
export function phase17Sonnet55BehavioralPromptRequestBuilderSourceDigest(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const begin = text.indexOf(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_MARKERS.begin);
  const end = text.indexOf(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_MARKERS.end);
  if (begin < 0 || end <= begin
    || text.indexOf(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_MARKERS.begin, begin + 1) >= 0) {
    throw new Error('PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_CONTRACT_MARKERS_INVALID');
  }
  return lfSha256(text.slice(begin, end + PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REQUEST_MARKERS.end.length));
}

export function derivePhase17Sonnet55BehavioralPromptRequestContract(prompt: string): Phase17Sonnet55BehavioralPromptRequestContract {
  const probe = {
    model: PHASE17_SONNET_55_BEHAVIORAL_PROMPT_MODEL,
    timeoutMs: 2_468,
    maxOutputTokens: 357,
    inputJson: '{"phase17":"sonnet-5-5-probe"}',
  };
  const { body, options } = buildPhase17Sonnet55BehavioralPromptStructuredOutputRequest(probe, prompt);
  return {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1',
    thinking: { type: 'between_tools' },
    maxRetries: options.maxRetries,
    bodyKeys: Object.keys(body).sort(),
    optionKeys: Object.keys(options).sort(),
    bindsModel: body.model === probe.model,
    bindsMaxOutputTokens: body.max_tokens === probe.maxOutputTokens,
    bindsTimeout: options.timeout === probe.timeoutMs,
    bindsSystemPromptExactly: body.system === prompt,
    bindsOutputSchema: body.output_config.format.type === 'json_schema',
    bindsThinkingMode: body.thinking.type === 'between_tools' && !('effort' in body.output_config),
    bindsUserInputExactly: body.messages.length === 1
      && body.messages[0]!.role === 'user'
      && body.messages[0]!.content === probe.inputJson,
  };
}

export function phase17Sonnet55BehavioralPromptQualificationSemanticsDigest(repoRoot: string): string {
  return hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    qualificationSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES.qualification),
    contractSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES.contract),
  });
}

export function computePhase17Sonnet55BehavioralPromptContractPins(repoRoot: string): Phase17Sonnet55BehavioralPromptContractPins {
  const prompt = loadPhase17Sonnet55BehavioralPromptPrompt();
  return {
    promptTemplateId: PHASE17_SONNET_55_BEHAVIORAL_PROMPT_PROMPT_ID,
    promptTemplateVersion: PHASE17_SONNET_55_BEHAVIORAL_PROMPT_PROMPT_VERSION,
    promptSha256: exactPromptSha256(prompt),
    outputSchemaSha256: hashCanonical(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_OUTPUT_SCHEMA),
    requestBuilderSourceSha256: phase17Sonnet55BehavioralPromptRequestBuilderSourceDigest(readFileSync(
      path.join(repoRoot, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES.requestBuilder), 'utf8')),
    clientSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES.requestBuilder),
    runnerSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_CONTRACT_FILES.runner),
    requestContract: derivePhase17Sonnet55BehavioralPromptRequestContract(prompt),
    taskContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.taskContractSha256,
    candidateContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.candidateContractSha256,
    durableProposalContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.durableProposalContractSha256,
    plannerContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.plannerContractSha256,
    operationalPolicy: PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
    qualificationFrameworkVersion: PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION,
    qualificationSemanticsSha256: phase17Sonnet55BehavioralPromptQualificationSemanticsDigest(repoRoot),
  };
}

/**
 * The additive identity intentionally reuses every v1 semantic pin and changes
 * only its model/request/framework identity. Filled from reviewed literals so a
 * later v1 drift cannot silently redefine this contract.
 */
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_ACCEPTED_CONTRACT_PINS: Phase17Sonnet55BehavioralPromptContractPins = {
  promptTemplateId: 'forgewing-recovery-candidate-v2-phase17-behavioral-prompt',
  promptTemplateVersion: 'v12-owner-approved-20261015',
  promptSha256: '4fc7afc5f4a94f15d9451a6dcb955e29608df384b0e9a9901161c94f0c0afc5a',
  outputSchemaSha256: 'a22352a9ceff9492046afaff22ddaa2f4a15456152aef51ebc2d6a0810e0420a',
  requestBuilderSourceSha256: 'e0f657b65495fff950682dd8589758df2ababb612e4ecffa554c45979708412d',
  clientSourceSha256: '7848aeff3d51d577d0e1fe5c09d662e90283f1a2a769a6bdaba18dcbce7c65ca',
  runnerSourceSha256: '6c1272bf50c2372bd41df6645f44e2cd4da2374f57ad94914226ae53a852663e',
  requestContract: {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1',
    thinking: { type: 'between_tools' },
    maxRetries: 0,
    bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'],
    optionKeys: ['maxRetries', 'timeout'],
    bindsModel: true,
    bindsMaxOutputTokens: true,
    bindsTimeout: true,
    bindsSystemPromptExactly: true,
    bindsOutputSchema: true,
    bindsThinkingMode: true,
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
  qualificationFrameworkVersion: PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION,
  qualificationSemanticsSha256: '0629287e2753f21f3d35cd6d5a71db2cdec9ec6c150a847d587888d11130c70b',
};

export function phase17Sonnet55BehavioralPromptContractPinMismatches(
  actual: Phase17Sonnet55BehavioralPromptContractPins,
  accepted: Phase17Sonnet55BehavioralPromptContractPins = PHASE17_SONNET_55_BEHAVIORAL_PROMPT_ACCEPTED_CONTRACT_PINS,
): readonly string[] {
  return (Object.keys(accepted) as (keyof Phase17Sonnet55BehavioralPromptContractPins)[]).flatMap((key) =>
    hashCanonical(actual[key]) === hashCanonical(accepted[key]) ? [] : [key]);
}

export function phase17Sonnet55BehavioralPromptPinsForArtifact(
  base: Omit<Phase17Sonnet55BehavioralPromptPins, keyof Phase17Sonnet55BehavioralPromptContractPins>,
  contract: Phase17Sonnet55BehavioralPromptContractPins,
): Phase17Sonnet55BehavioralPromptPins {
  return { ...base, ...contract } as Phase17Sonnet55BehavioralPromptPins;
}

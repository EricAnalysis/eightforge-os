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
  PHASE17_SONNET_55_PROMPT_CLARIFICATION_FRAMEWORK_VERSION,
  PHASE17_SONNET_55_PROMPT_CLARIFICATION_MODEL,
  type Phase17Sonnet55PromptClarificationPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55PromptClarificationContract';
import { buildPhase17Sonnet55PromptClarificationStructuredOutputRequest,
  loadPhase17Sonnet55PromptClarificationPrompt,
  PHASE17_SONNET_55_PROMPT_CLARIFICATION_OUTPUT_SCHEMA,
  PHASE17_SONNET_55_PROMPT_CLARIFICATION_PROMPT_ID,
  PHASE17_SONNET_55_PROMPT_CLARIFICATION_PROMPT_VERSION }
  from '@/lib/forgewing/runtime/phase17Sonnet55PromptClarificationQualificationClient';

export const PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES = {
  requestBuilder: 'lib/forgewing/runtime/phase17Sonnet55PromptClarificationQualificationClient.ts',
  runner: 'lib/evaluation/forgewing/phase17/phase17Sonnet55PromptClarificationRun.ts',
  qualification: 'lib/evaluation/forgewing/phase17/phase17Qualification.ts',
  contract: 'lib/evaluation/forgewing/phase17/phase17Contract.ts',
} as const;

export const PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_MARKERS = {
  begin: '// phase17-sonnet-55-request-contract:begin',
  end: '// phase17-sonnet-55-request-contract:end',
} as const;

export type Phase17Sonnet55PromptClarificationRequestContract = Readonly<{
  sampling: Readonly<{ temperature: Readonly<{ state: 'omitted' }> }>;
  schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1';
  thinking: Readonly<{ type: 'adaptive'; effort: 'low' }>;
  maxRetries: number;
  bodyKeys: readonly string[];
  optionKeys: readonly string[];
  bindsModel: boolean;
  bindsMaxOutputTokens: boolean;
  bindsTimeout: boolean;
  bindsSystemPromptExactly: boolean;
  bindsOutputSchema: boolean;
  bindsEffort: boolean;
  bindsUserInputExactly: boolean;
}>;

export type Phase17Sonnet55PromptClarificationContractPins = Omit<Phase17ContractPins,
  'requestBuilderSourceSha256' | 'requestContract'> & Readonly<{
  requestBuilderSourceSha256: string;
  requestContract: Phase17Sonnet55PromptClarificationRequestContract;
  clientSourceSha256: string;
  runnerSourceSha256: string;
  qualificationFrameworkVersion: typeof PHASE17_SONNET_55_PROMPT_CLARIFICATION_FRAMEWORK_VERSION;
  qualificationSemanticsSha256: string;
}>;

function fileDigest(repoRoot: string, relative: string): string {
  return lfSha256(readFileSync(path.join(repoRoot, relative), 'utf8'));
}
export function phase17Sonnet55PromptClarificationRequestBuilderSourceDigest(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const begin = text.indexOf(PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_MARKERS.begin);
  const end = text.indexOf(PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_MARKERS.end);
  if (begin < 0 || end <= begin
    || text.indexOf(PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_MARKERS.begin, begin + 1) >= 0) {
    throw new Error('PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_CONTRACT_MARKERS_INVALID');
  }
  return lfSha256(text.slice(begin, end + PHASE17_SONNET_55_PROMPT_CLARIFICATION_REQUEST_MARKERS.end.length));
}

export function derivePhase17Sonnet55PromptClarificationRequestContract(prompt: string): Phase17Sonnet55PromptClarificationRequestContract {
  const probe = {
    model: PHASE17_SONNET_55_PROMPT_CLARIFICATION_MODEL,
    timeoutMs: 2_468,
    maxOutputTokens: 357,
    inputJson: '{"phase17":"sonnet-5-5-probe"}',
  };
  const { body, options } = buildPhase17Sonnet55PromptClarificationStructuredOutputRequest(probe, prompt);
  return {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1',
    thinking: { type: 'adaptive', effort: 'low' },
    maxRetries: options.maxRetries,
    bodyKeys: Object.keys(body).sort(),
    optionKeys: Object.keys(options).sort(),
    bindsModel: body.model === probe.model,
    bindsMaxOutputTokens: body.max_tokens === probe.maxOutputTokens,
    bindsTimeout: options.timeout === probe.timeoutMs,
    bindsSystemPromptExactly: body.system === prompt,
    bindsOutputSchema: body.output_config.format.type === 'json_schema',
    bindsEffort: body.output_config.effort === 'low',
    bindsUserInputExactly: body.messages.length === 1
      && body.messages[0]!.role === 'user'
      && body.messages[0]!.content === probe.inputJson,
  };
}

export function phase17Sonnet55PromptClarificationQualificationSemanticsDigest(repoRoot: string): string {
  return hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    qualificationSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES.qualification),
    contractSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES.contract),
  });
}

export function computePhase17Sonnet55PromptClarificationContractPins(repoRoot: string): Phase17Sonnet55PromptClarificationContractPins {
  const prompt = loadPhase17Sonnet55PromptClarificationPrompt();
  return {
    promptTemplateId: PHASE17_SONNET_55_PROMPT_CLARIFICATION_PROMPT_ID,
    promptTemplateVersion: PHASE17_SONNET_55_PROMPT_CLARIFICATION_PROMPT_VERSION,
    promptSha256: exactPromptSha256(prompt),
    outputSchemaSha256: hashCanonical(PHASE17_SONNET_55_PROMPT_CLARIFICATION_OUTPUT_SCHEMA),
    requestBuilderSourceSha256: phase17Sonnet55PromptClarificationRequestBuilderSourceDigest(readFileSync(
      path.join(repoRoot, PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES.requestBuilder), 'utf8')),
    clientSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES.requestBuilder),
    runnerSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_PROMPT_CLARIFICATION_CONTRACT_FILES.runner),
    requestContract: derivePhase17Sonnet55PromptClarificationRequestContract(prompt),
    taskContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.taskContractSha256,
    candidateContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.candidateContractSha256,
    durableProposalContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.durableProposalContractSha256,
    plannerContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.plannerContractSha256,
    operationalPolicy: PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
    qualificationFrameworkVersion: PHASE17_SONNET_55_PROMPT_CLARIFICATION_FRAMEWORK_VERSION,
    qualificationSemanticsSha256: phase17Sonnet55PromptClarificationQualificationSemanticsDigest(repoRoot),
  };
}

/**
 * The additive identity intentionally reuses every v1 semantic pin and changes
 * only its model/request/framework identity. Filled from reviewed literals so a
 * later v1 drift cannot silently redefine this contract.
 */
export const PHASE17_SONNET_55_PROMPT_CLARIFICATION_ACCEPTED_CONTRACT_PINS: Phase17Sonnet55PromptClarificationContractPins = {
  promptTemplateId: 'forgewing-recovery-candidate-v2-phase17-prompt-clarification',
  promptTemplateVersion: 'v7-owner-approved-20261015',
  promptSha256: 'ccf3a1a6dcd0f4d1eed545416bef66180f38ed4b3bf244d58eaa3915be78c652',
  outputSchemaSha256: 'a22352a9ceff9492046afaff22ddaa2f4a15456152aef51ebc2d6a0810e0420a',
  requestBuilderSourceSha256: '4f21adbe5fd3ff8cd2bab9ee8354f6cbf9df5d7b2eacb71b08cb76a1835afe6b',
  clientSourceSha256: 'c7ee685da49519dba8603fda1bed3ef9d13ef268741f287767574e4aa1621628',
  runnerSourceSha256: '7318d8d2461d312661ef4226513fce0e34fc453f7fe245a778b915d896d53802',
  requestContract: {
    sampling: { temperature: { state: 'omitted' } },
    schemaTransformation: 'confidence-provider-bounds-omitted-rationale-length-description-v1',
    thinking: { type: 'adaptive', effort: 'low' },
    maxRetries: 0,
    bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'],
    optionKeys: ['maxRetries', 'timeout'],
    bindsModel: true,
    bindsMaxOutputTokens: true,
    bindsTimeout: true,
    bindsSystemPromptExactly: true,
    bindsOutputSchema: true,
    bindsEffort: true,
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
  qualificationFrameworkVersion: PHASE17_SONNET_55_PROMPT_CLARIFICATION_FRAMEWORK_VERSION,
  qualificationSemanticsSha256: '0629287e2753f21f3d35cd6d5a71db2cdec9ec6c150a847d587888d11130c70b',
};

export function phase17Sonnet55PromptClarificationContractPinMismatches(
  actual: Phase17Sonnet55PromptClarificationContractPins,
  accepted: Phase17Sonnet55PromptClarificationContractPins = PHASE17_SONNET_55_PROMPT_CLARIFICATION_ACCEPTED_CONTRACT_PINS,
): readonly string[] {
  return (Object.keys(accepted) as (keyof Phase17Sonnet55PromptClarificationContractPins)[]).flatMap((key) =>
    hashCanonical(actual[key]) === hashCanonical(accepted[key]) ? [] : [key]);
}

export function phase17Sonnet55PromptClarificationPinsForArtifact(
  base: Omit<Phase17Sonnet55PromptClarificationPins, keyof Phase17Sonnet55PromptClarificationContractPins>,
  contract: Phase17Sonnet55PromptClarificationContractPins,
): Phase17Sonnet55PromptClarificationPins {
  return { ...base, ...contract } as Phase17Sonnet55PromptClarificationPins;
}

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
  PHASE17_SONNET_55_FRAMEWORK_VERSION,
  PHASE17_SONNET_55_MODEL,
  type Phase17Sonnet55Pins,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55Contract';
import {
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
  FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
  loadRecoveryCandidateV2Prompt,
} from '@/lib/forgewing/runtime/client';
import { buildPhase17Sonnet55StructuredOutputRequest }
  from '@/lib/forgewing/runtime/phase17Sonnet55QualificationClient';

export const PHASE17_SONNET_55_CONTRACT_FILES = {
  requestBuilder: 'lib/forgewing/runtime/phase17Sonnet55QualificationClient.ts',
  runner: 'lib/evaluation/forgewing/phase17/phase17Sonnet55Run.ts',
  qualification: 'lib/evaluation/forgewing/phase17/phase17Qualification.ts',
  contract: 'lib/evaluation/forgewing/phase17/phase17Contract.ts',
} as const;

export const PHASE17_SONNET_55_REQUEST_MARKERS = {
  begin: '// phase17-sonnet-55-request-contract:begin',
  end: '// phase17-sonnet-55-request-contract:end',
} as const;

export type Phase17Sonnet55RequestContract = Readonly<{
  sampling: Readonly<{ temperature: Readonly<{ state: 'omitted' }> }>;
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

export type Phase17Sonnet55ContractPins = Omit<Phase17ContractPins,
  'requestBuilderSourceSha256' | 'requestContract'> & Readonly<{
  requestBuilderSourceSha256: string;
  requestContract: Phase17Sonnet55RequestContract;
  clientSourceSha256: string;
  runnerSourceSha256: string;
  qualificationFrameworkVersion: typeof PHASE17_SONNET_55_FRAMEWORK_VERSION;
  qualificationSemanticsSha256: string;
}>;

function fileDigest(repoRoot: string, relative: string): string {
  return lfSha256(readFileSync(path.join(repoRoot, relative), 'utf8'));
}

export function phase17Sonnet55RequestBuilderSourceDigest(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const begin = text.indexOf(PHASE17_SONNET_55_REQUEST_MARKERS.begin);
  const end = text.indexOf(PHASE17_SONNET_55_REQUEST_MARKERS.end);
  if (begin < 0 || end <= begin
    || text.indexOf(PHASE17_SONNET_55_REQUEST_MARKERS.begin, begin + 1) >= 0) {
    throw new Error('PHASE17_SONNET_55_REQUEST_CONTRACT_MARKERS_INVALID');
  }
  return lfSha256(text.slice(begin, end + PHASE17_SONNET_55_REQUEST_MARKERS.end.length));
}

export function derivePhase17Sonnet55RequestContract(prompt: string): Phase17Sonnet55RequestContract {
  const probe = {
    model: PHASE17_SONNET_55_MODEL,
    timeoutMs: 2_468,
    maxOutputTokens: 357,
    inputJson: '{"phase17":"sonnet-5-5-probe"}',
  };
  const { body, options } = buildPhase17Sonnet55StructuredOutputRequest(probe, prompt);
  return {
    sampling: { temperature: { state: 'omitted' } },
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

export function phase17Sonnet55QualificationSemanticsDigest(repoRoot: string): string {
  return hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    qualificationSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_CONTRACT_FILES.qualification),
    contractSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_CONTRACT_FILES.contract),
  });
}

export function computePhase17Sonnet55ContractPins(repoRoot: string): Phase17Sonnet55ContractPins {
  const prompt = loadRecoveryCandidateV2Prompt();
  return {
    promptTemplateId: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID,
    promptTemplateVersion: FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION,
    promptSha256: exactPromptSha256(prompt),
    outputSchemaSha256: PHASE17_ACCEPTED_CONTRACT_PINS.outputSchemaSha256,
    requestBuilderSourceSha256: phase17Sonnet55RequestBuilderSourceDigest(readFileSync(
      path.join(repoRoot, PHASE17_SONNET_55_CONTRACT_FILES.requestBuilder), 'utf8')),
    clientSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_CONTRACT_FILES.requestBuilder),
    runnerSourceSha256: fileDigest(repoRoot, PHASE17_SONNET_55_CONTRACT_FILES.runner),
    requestContract: derivePhase17Sonnet55RequestContract(prompt),
    taskContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.taskContractSha256,
    candidateContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.candidateContractSha256,
    durableProposalContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.durableProposalContractSha256,
    plannerContractSha256: PHASE17_ACCEPTED_CONTRACT_PINS.plannerContractSha256,
    operationalPolicy: PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
    qualificationFrameworkVersion: PHASE17_SONNET_55_FRAMEWORK_VERSION,
    qualificationSemanticsSha256: phase17Sonnet55QualificationSemanticsDigest(repoRoot),
  };
}

/**
 * The additive identity intentionally reuses every v1 semantic pin and changes
 * only its model/request/framework identity. Filled from reviewed literals so a
 * later v1 drift cannot silently redefine this contract.
 */
export const PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS: Phase17Sonnet55ContractPins = {
  promptTemplateId: 'forgewing-recovery-candidate-v2',
  promptTemplateVersion: 'v2',
  promptSha256: '55bb0262885388b2d96ce33075eac73df6ce25bc23a92a6ae204e5f3242214da',
  outputSchemaSha256: 'c480562d6cbac049adc4ad6e0c4937399514bac6f43336e418c20b88e61b5b18',
  requestBuilderSourceSha256: '5f84dd3de7b3bd0a85d9ddd6ff49f0bad3039d6c6897419bd16ef716744cef4a',
  clientSourceSha256: 'f726bea91ac1fb6e3c15bf18dff47c6877f6792bf7671a4df9282a5ce812436d',
  runnerSourceSha256: '5545b509cb48fcb1dbbd82580fc236ba0c34981872efc5448dc0424c60ef28f0',
  requestContract: {
    sampling: { temperature: { state: 'omitted' } },
    maxRetries: 0,
    bodyKeys: ['max_tokens', 'messages', 'model', 'output_config', 'system'],
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
  qualificationFrameworkVersion: PHASE17_SONNET_55_FRAMEWORK_VERSION,
  qualificationSemanticsSha256: '0629287e2753f21f3d35cd6d5a71db2cdec9ec6c150a847d587888d11130c70b',
};

export function phase17Sonnet55ContractPinMismatches(
  actual: Phase17Sonnet55ContractPins,
  accepted: Phase17Sonnet55ContractPins = PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS,
): readonly string[] {
  return (Object.keys(accepted) as (keyof Phase17Sonnet55ContractPins)[]).flatMap((key) =>
    hashCanonical(actual[key]) === hashCanonical(accepted[key]) ? [] : [key]);
}

export function phase17Sonnet55PinsForArtifact(
  base: Omit<Phase17Sonnet55Pins, keyof Phase17Sonnet55ContractPins>,
  contract: Phase17Sonnet55ContractPins,
): Phase17Sonnet55Pins {
  return { ...base, ...contract } as Phase17Sonnet55Pins;
}

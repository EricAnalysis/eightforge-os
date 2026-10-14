import { hashCanonical } from '@/lib/extraction/domain/hash';
import { QUALIFICATION_CONTRACT_V3, qualificationSemanticsDigest, validateQualificationRecordsV3,
  qualificationSourceDigest, validateQualificationCaptures } from './qualificationContractV3';
import type { CorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';

const sources = { ...QUALIFICATION_CONTRACT_V3.sourceSha256 } as Record<string, string>;
delete sources['scripts/evaluation/b461/runQualificationV3.ts'];
/** Transport observation only: the exact v3 request, renderer, scorer and gates remain authoritative. */
export const QUALIFICATION_CONTRACT_V4 = Object.freeze({
  ...QUALIFICATION_CONTRACT_V3,
  version: 'b461-qualification-contract-v4-transport-observation',
  transportObservation: 'async-local-fetch-lifecycle-v1',
  sourceSha256: Object.freeze({ ...sources,
    'lib/evaluation/benchmark/qualificationContractV3.ts': '02bb559d3797e222ee9a82ea5fb2b00b2ac8bfc356ce9a22a224e5ee01d375a7',
    'lib/evaluation/benchmark/qualificationTransportObservation.ts': '4b108185e35d7fb2b31635beb2b87ee69ed6e9d56987526f33a7d829065d2f02',
    'scripts/evaluation/b461/runQualificationV4.ts': 'a3971650b41ede1dd30b7340e65f080a90976b623c7501c8f55d8fb3c0c34137',
  }),
});

export function assertQualificationContractV4(observed: {
  scorer: string; taxonomy: string; binding: string; tasks: readonly string[]; execution: unknown;
  activationBar: unknown; promptSha256: string; pins: CorpusPins; sourceSha256: Record<string, string>;
}): void {
  for (const key of ['scorer', 'taxonomy', 'binding', 'tasks', 'execution', 'activationBar', 'promptSha256', 'sourceSha256'] as const) {
    if (hashCanonical(observed[key]) !== hashCanonical(QUALIFICATION_CONTRACT_V4[key])) throw new Error(`qualification v4 contract mismatch: ${key}`);
  }
  if (hashCanonical(observed.pins) !== hashCanonical(QUALIFICATION_CONTRACT_V4.corpus)) throw new Error('qualification v4 corpus mismatch');
  if (qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V4) !== qualificationSemanticsDigest(QUALIFICATION_CONTRACT_V3)) throw new Error('qualification v4 semantics mismatch');
}
export const validateQualificationRecordsV4 = validateQualificationRecordsV3;
export { qualificationSourceDigest, validateQualificationCaptures };

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
    'lib/evaluation/benchmark/qualificationTransportObservation.ts': 'a921313df2de125dd9641ba128a4d5e0e982898285ccc3eb8803ec58dc5c10c3',
    'scripts/evaluation/b461/runQualificationV4.ts': '415359671d6820874140c33b5233af7098dd05b4f6adbe10d4757fcf5b59f10b',
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

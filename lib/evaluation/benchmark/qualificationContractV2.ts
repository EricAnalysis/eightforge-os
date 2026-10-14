import type { CorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  QUALIFICATION_CONTRACT,
  qualificationSourceDigest,
  validateQualificationCaptures,
  type QualificationExpectedRecord,
} from './qualificationContract';
import type { ValueReadingBenchmarkRecord } from './valueReadingBenchmark';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const sharedSourceSha256 = Object.fromEntries(Object.entries(QUALIFICATION_CONTRACT.sourceSha256)
  .filter(([file]) => file !== 'lib/forgewing/runtime/valueReadingClient.ts'
    && file !== 'scripts/evaluation/b461/runQualification.ts'));

/**
 * Additive Sonnet 5.5 registration. Every qualification-semantic field is the
 * frozen v1 value; only the model, truthful sampling identity and versioned
 * producer sources differ.
 */
export const QUALIFICATION_CONTRACT_V2 = freeze({
  version: 'b461-qualification-contract-v2',
  scorer: QUALIFICATION_CONTRACT.scorer,
  taxonomy: QUALIFICATION_CONTRACT.taxonomy,
  binding: QUALIFICATION_CONTRACT.binding,
  tasks: QUALIFICATION_CONTRACT.tasks,
  model: 'claude-sonnet-5-5',
  sampling: { temperature: 'omitted' },
  promptSha256: QUALIFICATION_CONTRACT.promptSha256,
  execution: QUALIFICATION_CONTRACT.execution,
  requestIdentity: QUALIFICATION_CONTRACT.requestIdentity,
  evidenceClasses: QUALIFICATION_CONTRACT.evidenceClasses,
  activationBar: QUALIFICATION_CONTRACT.activationBar,
  corpus: QUALIFICATION_CONTRACT.corpus,
  sourceSha256: {
    ...sharedSourceSha256,
    'lib/evaluation/benchmark/qualificationContract.ts': '74e3a1547aef8e8ddfbf0aa3bd6270732acc7d36f262855e015c6eda6c8be632',
    'lib/forgewing/runtime/valueReadingClientV2.ts': '6c331c9195ab6735f70f33f8bb866e1ae78b0aeb2a60768e792bcb603cbdb96f',
    'scripts/evaluation/b461/runQualificationV2.ts': '1744f71ea517b48586bcc9c39a0492759009087567bddabba5bf712cafe3cf15',
  },
});

export const qualificationSemanticsDigest = (contract: Pick<typeof QUALIFICATION_CONTRACT,
  'scorer' | 'taxonomy' | 'binding' | 'tasks' | 'promptSha256' | 'execution' | 'requestIdentity'
  | 'evidenceClasses' | 'activationBar' | 'corpus'>): string => hashCanonical({
    scorer: contract.scorer,
    taxonomy: contract.taxonomy,
    binding: contract.binding,
    tasks: contract.tasks,
    promptSha256: contract.promptSha256,
    execution: contract.execution,
    requestIdentity: contract.requestIdentity,
    evidenceClasses: contract.evidenceClasses,
    activationBar: contract.activationBar,
    corpus: contract.corpus,
  });

export function assertQualificationContractV2(observed: {
  scorer: string; taxonomy: string; binding: string; tasks: readonly string[]; execution: unknown;
  activationBar: unknown; promptSha256: string; pins: CorpusPins; sourceSha256: Record<string, string>;
}): void {
  const expected = QUALIFICATION_CONTRACT_V2;
  for (const key of ['scorer', 'taxonomy', 'binding', 'tasks', 'execution', 'activationBar', 'promptSha256', 'sourceSha256'] as const) {
    if (hashCanonical(observed[key]) !== hashCanonical(expected[key])) throw new Error(`qualification v2 contract mismatch: ${key}`);
  }
  if (hashCanonical(observed.pins) !== hashCanonical(expected.corpus)) throw new Error('qualification v2 contract mismatch: corpus pins');
  if (qualificationSemanticsDigest(expected) !== qualificationSemanticsDigest(QUALIFICATION_CONTRACT)) {
    throw new Error('qualification v2 semantics differ from frozen v1');
  }
}

/** Foreign/duplicate rows cannot alter either a class denominator or corpus-wide safety. */
export function validateQualificationRecordsV2(records: readonly ValueReadingBenchmarkRecord[],
  expected: readonly QualificationExpectedRecord[]): void {
  const targets = new Map(expected.map(target => [`${target.pageKey}/${target.rowKey}`, target]));
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.pageKey}/${record.rowKey}`;
    const target = targets.get(key);
    if (!target || record.evidenceClass !== target.evidenceClass) throw new Error(`foreign qualification row ${key}`);
    if (seen.has(key)) throw new Error(`duplicate qualification row ${key}`);
    seen.add(key);
    if (record.failureReason === 'dry_run') throw new Error(`dry qualification row ${key}`);
    if (record.providerCalled) {
      const contract = QUALIFICATION_CONTRACT_V2;
      const request = sha256Hex(JSON.stringify(['b46', record.pageKey, record.rowKey, record.renderDigestSha256,
        contract.model, contract.execution.promptTemplateId, contract.execution.promptTemplateVersion,
        contract.execution.outputSchemaVersion]));
      if (record.requestDigestSha256 !== request) throw new Error(`qualification request identity mismatch: ${key}`);
    } else if (record.outcome !== 'failed' || record.failureReason !== 'region_image_unavailable' || record.requestDigestSha256 !== null) {
      throw new Error(`qualification row has no provider measurement: ${key}`);
    }
  }
  for (const key of targets.keys()) if (!seen.has(key)) throw new Error(`missing qualification row ${key}`);
}

export { qualificationSourceDigest, validateQualificationCaptures };

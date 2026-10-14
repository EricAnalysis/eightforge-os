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
 * frozen v1 value except the owner-approved 500-token output cap. Explicit
 * thinking restores the no-upfront-thinking request behavior; source identities
 * bind the run-scoped renderer and response-envelope diagnostics.
 */
export const QUALIFICATION_CONTRACT_V3 = freeze({
  version: 'b461-qualification-contract-v3',
  scorer: QUALIFICATION_CONTRACT.scorer,
  taxonomy: QUALIFICATION_CONTRACT.taxonomy,
  binding: QUALIFICATION_CONTRACT.binding,
  tasks: QUALIFICATION_CONTRACT.tasks,
  model: 'claude-sonnet-5-5',
  sampling: { temperature: 'omitted' },
  thinking: { type: 'between_tools' },
  requestBodyIdentity: 'sha256-json-request-body-v1',
  rendererLifecycle: 'request-scoped-pdf-page-reuse-v1',
  promptSha256: QUALIFICATION_CONTRACT.promptSha256,
  execution: { ...QUALIFICATION_CONTRACT.execution, maxOutputTokens: 500 },
  requestIdentity: QUALIFICATION_CONTRACT.requestIdentity,
  evidenceClasses: QUALIFICATION_CONTRACT.evidenceClasses,
  activationBar: QUALIFICATION_CONTRACT.activationBar,
  corpus: QUALIFICATION_CONTRACT.corpus,
  sourceSha256: {
    ...sharedSourceSha256,
    'lib/evaluation/benchmark/qualificationContract.ts': '74e3a1547aef8e8ddfbf0aa3bd6270732acc7d36f262855e015c6eda6c8be632',
    'lib/forgewing/runtime/valueReadingClientV3.ts': '84c3b97d262adc7e61f11b0453486a480e0065b404e3116d2e49477ff4bdb28b',
    'lib/evaluation/benchmark/valueReadingBenchmarkRunV3.ts': '12db704bd92b9b9e9900ad2529c6dd85e1d28ef1a5897fb6d17ac9b6930e009d',
    'lib/server/valueReadingQualificationRenderer.ts': 'e83ebe9c26b383bfab9387f3f71038d2ca0d7fb0d9145c7e7c50b6cf1a9a2c6b',
    'scripts/evaluation/b461/runQualificationV3.ts': '0f1a1fc695df31e956fc17ad1758ecfa7ef337c07bdccd33fbb9057dbaba2494',
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

export function assertQualificationContractV3(observed: {
  scorer: string; taxonomy: string; binding: string; tasks: readonly string[]; execution: unknown;
  activationBar: unknown; promptSha256: string; pins: CorpusPins; sourceSha256: Record<string, string>;
}): void {
  const expected = QUALIFICATION_CONTRACT_V3;
  for (const key of ['scorer', 'taxonomy', 'binding', 'tasks', 'execution', 'activationBar', 'promptSha256', 'sourceSha256'] as const) {
    if (hashCanonical(observed[key]) !== hashCanonical(expected[key])) throw new Error(`qualification v3 contract mismatch: ${key}`);
  }
  if (hashCanonical(observed.pins) !== hashCanonical(expected.corpus)) throw new Error('qualification v3 contract mismatch: corpus pins');
  if (qualificationSemanticsDigest({ ...expected, execution: { ...expected.execution, maxOutputTokens: QUALIFICATION_CONTRACT.execution.maxOutputTokens } }) !== qualificationSemanticsDigest(QUALIFICATION_CONTRACT)) {
    throw new Error('qualification v3 semantics differ beyond the owner-approved 500-token cap');
  }
}

/** Foreign/duplicate rows cannot alter either a class denominator or corpus-wide safety. */
export function validateQualificationRecordsV3(records: readonly ValueReadingBenchmarkRecord[],
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
      const contract = QUALIFICATION_CONTRACT_V3;
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

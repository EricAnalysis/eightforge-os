import type { CorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import type { ValueReadingBenchmarkRecord, ValueReadingEvidenceClass } from './valueReadingBenchmark';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Source text is pinned in Git's LF form; artifact bytes are always hashed exactly. */
export const qualificationSourceDigest = (text: string): string => sha256Hex(text.replace(/\r\n/g, '\n'));

/** Measurement only. Changing a pin requires a new reviewed qualification registration. */
export const QUALIFICATION_CONTRACT = freeze({
  version: 'b461-qualification-contract-v1',
  scorer: 'b461-qualification-decision-v1',
  taxonomy: 'b461-failure-taxonomy-v1',
  binding: 'b461-target-binding-v2',
  tasks: ['confirm_scanned_amount', 'read_unreadable_amount', 'read_withheld_line', 'read_unresolved_line', 'choose_category'],
  model: 'claude-sonnet-4-6',
  promptSha256: '17ba8da5a1efdb172a6b347ce0bdc43c798e97a08b6098e400144a4d9c1bbcad',
  execution: { timeoutMs: 8000, maxOutputTokens: 300, promptTemplateId: 'forgewing-priced-value-reading',
    promptTemplateVersion: 'v2', outputSchemaVersion: 'value_reading_output_v2', cropRenderer: 'value_reading_region_crop_v2',
    cropScale: 3, cropPaddingPoints: 6, cropMaxWidthPx: 2600, cropMaxHeightPx: 1000, maxNeighbouringLines: 6 },
  requestIdentity: 'sha256(JSON.stringify([b46,pageKey,rowKey,renderDigestSha256,model,promptTemplateId,promptTemplateVersion,outputSchemaVersion]))',
  evidenceClasses: { 'Golden:8': 'ocr_price_sheet', 'Golden:10': 'ocr_price_sheet', 'Golden:11': 'ocr_price_sheet',
    'Hillsdale:1': 'native_price_sheet', 'Hillsdale:3': 'ocr_price_sheet', 'DN:106': 'dense_native_priced_schedule',
    'DN:107': 'dense_scanned_ocr_priced_schedule' } satisfies Record<string, ValueReadingEvidenceClass>,
  activationBar: { benchmarkVersion: 'b4.6.1', minRatePrecision: 0.99, maxWrongSourceRegionBindings: 0,
    maxUnsupportedNumericInventions: 0, maxUnsupportedValueInventions: 0, minResolvedShareOfReadable: 0.8,
    maxP50TotalLatencyMs: 3000, maxP95TotalLatencyMs: 8000, maxUsdPerAttempt: 0.05, maxUsdPerCorrect: 0.1,
    minReuseRate: 1, minRowsPerClass: 20 },
  corpus: { schema: 'eightforge_eval_corpus_pins_v1', documents: [
    { label: 'DN', file: 'dn.pdf', sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272' },
    { label: 'Golden', file: 'golden.pdf', sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f' },
    { label: 'Hillsdale', file: 'hillsdale.pdf', sha256: '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537' },
  ] },
  sourceSha256: {
    'lib/evaluation/benchmark/qualificationScoring.ts': '4ca779f86e8eebc417426b34c0ebb4d6706788a01c18995e7fee16ad5323fa18',
    'lib/evaluation/benchmark/qualificationTaxonomy.ts': 'ec465e6915d7cd598cf2fd88a81525671dbb2318f3368d2e6223d0696569d218',
    'lib/evaluation/benchmark/qualificationBinding.ts': '907eed9999c9349c3704d14b97c36597d44be662af2446989be4323a5da7f791',
    'lib/evaluation/benchmark/valueReadingBenchmark.ts': '67823ca99579bc16b58ad67cae67f0977a7773a40beb5e099956f64e6d9c1e3b',
    'lib/evaluation/benchmark/valueReadingBenchmarkRun.ts': '462deb0f02834a546cda1898cd0cb2064219bc977175bd60b4bb514b5195df59',
    'lib/evaluation/benchmark/benchmarkContract.ts': '9458b30432496bc7123d83885b7c522dacdfd73620b17eb7edc028ae48585485',
    'lib/evaluation/benchmark/qualificationSet.ts': '914443c46a25630d4a717735438c935d00588825ab5506b3e592dbdaae4d31d0',
    'lib/evaluation/benchmark/qualificationExclusions.ts': '9dfee36f130426fbf207c2978adcb16d1977ec7666011f51b9186e22c375619c',
    'lib/valueReadingContract.ts': '6a0734f8e9794d0e0ea0fe28e559d223acb0ea08f9eb469b1aed4c501ac89ec8',
    'lib/server/valueReadingEngine.ts': '558016477010958e9a5c992edac19952c606e544cbad2ba8892af23889a82386',
    'lib/server/valueReadingRegionRenderer.ts': '81d5e9da4841df3fdc484548154f65446b0d43f309c80136a2b49c4b9ee361e3',
    'lib/forgewing/runtime/valueReadingClient.ts': 'd1a40e0a229871b53e0024929d73f58be4dc0a7818eb31c575f63862797db098',
    'scripts/evaluation/b461/runQualification.ts': 'b64b34dd9c7fb23b5c638fd69339154e8b7d09f81cf58bb39a26e690f12bb770',
  },
});

export function assertQualificationContract(observed: {
  scorer: string; taxonomy: string; binding: string; tasks: readonly string[]; execution: unknown;
  activationBar: unknown; promptSha256: string; pins: CorpusPins; sourceSha256: Record<string, string>;
}): void {
  const expected = QUALIFICATION_CONTRACT;
  for (const key of ['scorer', 'taxonomy', 'binding', 'tasks', 'execution', 'activationBar', 'promptSha256', 'sourceSha256'] as const) {
    if (hashCanonical(observed[key]) !== hashCanonical(expected[key])) throw new Error(`qualification contract mismatch: ${key}`);
  }
  if (hashCanonical(observed.pins) !== hashCanonical(expected.corpus)) throw new Error('qualification contract mismatch: corpus pins');
}

/** Validate the producer's complete artifact manifest before any capture becomes inventory input. */
export function validateQualificationCaptures(pins: CorpusPins, manifest: unknown, hashes: unknown,
  readArtifact: (relative: string) => Uint8Array): { runtimeIdentityDigest: string; captureSetDigest: string } {
  const runtime = manifest as Record<string, unknown> | null;
  const index = hashes as Record<string, unknown> | null;
  if (runtime?.schema !== 'eightforge_eval_runtime_manifest_v1' || index?.schema !== 'eightforge_eval_capture_hashes_v1') {
    throw new Error('qualification requires pinned runtime-manifest.json and capture-hashes.json');
  }
  const identity = runtime.identity as Record<string, unknown> | null;
  if (!identity || identity.schema !== 'eightforge_eval_runtime_identity_v1'
    || hashCanonical(identity) !== runtime.runtime_identity_digest
    || runtime.runtime_identity_digest !== index.runtime_identity_digest) throw new Error('capture runtime identity mismatch');
  if (identity.fixture_manifest_digest !== hashCanonical(pins)
    || hashCanonical(identity.source_pdf_sha256) !== hashCanonical(Object.fromEntries(pins.documents.map(pin => [pin.label, pin.sha256])))) {
    throw new Error('capture corpus identity mismatch');
  }
  const captures = index.captures as Record<string, string> | null;
  if (!captures || Array.isArray(captures) || hashCanonical(captures) !== index.capture_set_digest
    || runtime.capture_set_digest !== index.capture_set_digest) throw new Error('capture set digest mismatch');
  for (const file of [...pins.documents.map(pin => `extraction/${pin.label}.json`), 'inventory.json', 'reconstruction-dump.json']) {
    if (!captures[file]) throw new Error(`capture manifest missing ${file}`);
  }
  for (const [file, digest] of Object.entries(captures)) {
    if (!/^(?:extraction\/[A-Za-z0-9_-]+\.json|inventory\.json|reconstruction-dump\.json)$/.test(file)
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid capture manifest entry ${file}`);
    if (sha256Hex(readArtifact(file)) !== digest) throw new Error(`capture artifact digest mismatch: ${file}`);
  }
  return { runtimeIdentityDigest: String(runtime.runtime_identity_digest), captureSetDigest: String(index.capture_set_digest) };
}

export type QualificationExpectedRecord = { pageKey: string; rowKey: string; evidenceClass: ValueReadingEvidenceClass };

/** Foreign/duplicate rows cannot alter either a class denominator or corpus-wide safety. */
export function validateQualificationRecords(records: readonly ValueReadingBenchmarkRecord[], expected: readonly QualificationExpectedRecord[]): void {
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
      const contract = QUALIFICATION_CONTRACT;
      const request = sha256Hex(JSON.stringify(['b46', record.pageKey, record.rowKey, record.renderDigestSha256,
        contract.model, contract.execution.promptTemplateId, contract.execution.promptTemplateVersion, contract.execution.outputSchemaVersion]));
      if (record.requestDigestSha256 !== request) throw new Error(`qualification request identity mismatch: ${key}`);
    } else if (record.outcome !== 'failed' || record.failureReason !== 'region_image_unavailable' || record.requestDigestSha256 !== null) {
      throw new Error(`qualification row has no provider measurement: ${key}`);
    }
  }
  for (const key of targets.keys()) if (!seen.has(key)) throw new Error(`missing qualification row ${key}`);
}

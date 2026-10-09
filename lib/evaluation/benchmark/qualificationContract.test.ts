import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCorpusPins } from '@/lib/evaluation/pinnedEvaluationCapture';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { QUALIFICATION_BINDING_VERSION } from './qualificationBinding';
import { QUALIFICATION_DECISION_VERSION } from './qualificationScoring';
import { QUALIFICATION_TASKS } from './qualificationSet';
import { QUALIFICATION_TAXONOMY_VERSION } from './qualificationTaxonomy';
import { VALUE_READING_ACTIVATION_BAR, type ValueReadingBenchmarkRecord } from './valueReadingBenchmark';
import { VALUE_READING_EXECUTION } from '@/lib/valueReadingContract';
import { assertQualificationContract, QUALIFICATION_CONTRACT, validateQualificationCaptures, validateQualificationRecords, qualificationSourceDigest } from './qualificationContract';

const pins = parseCorpusPins(QUALIFICATION_CONTRACT.corpus);
function captureFixture() {
  const artifacts = Object.fromEntries([...pins.documents.map(pin => `extraction/${pin.label}.json`),
    'inventory.json', 'reconstruction-dump.json'].map(file => [file, new TextEncoder().encode(`{"file":"${file}"}\n`)]));
  const captures = Object.fromEntries(Object.entries(artifacts).map(([file, bytes]) => [file, sha256Hex(bytes)]));
  const identity = { schema: 'eightforge_eval_runtime_identity_v1', node_version: 'observed-node',
    fixture_manifest_digest: hashCanonical(pins), source_pdf_sha256: Object.fromEntries(pins.documents.map(pin => [pin.label, pin.sha256])) };
  const identityDigest = hashCanonical(identity);
  const setDigest = hashCanonical(captures);
  return { artifacts, manifest: { schema: 'eightforge_eval_runtime_manifest_v1', identity,
    runtime_identity_digest: identityDigest, capture_set_digest: setDigest },
  hashes: { schema: 'eightforge_eval_capture_hashes_v1', captures, runtime_identity_digest: identityDigest, capture_set_digest: setDigest } };
}
function validate(fixture: ReturnType<typeof captureFixture>) {
  return validateQualificationCaptures(pins, fixture.manifest, fixture.hashes, file => fixture.artifacts[file]!);
}
const expected = [{ pageKey: 'dn-p107', rowKey: 'r-0001', evidenceClass: 'dense_scanned_ocr_priced_schedule' as const }];
function record(overrides: Partial<ValueReadingBenchmarkRecord> = {}): ValueReadingBenchmarkRecord {
  const render = 'a'.repeat(64);
  return { ...expected[0]!, outcome: 'correct', fields: { description: true, unit: true, category: null, rate: true },
    rateError: null, boundTo: null, inventions: [], semantic: null, providerCalled: true,
    failureReason: null, renderMs: 10, providerMs: 10, totalMs: 20, inputTokens: 1, outputTokens: 1, usd: 0.001,
    renderDigestSha256: render, reuseEligible: true, outputDigestSha256: 'b'.repeat(64),
    requestDigestSha256: sha256Hex(JSON.stringify(['b46', expected[0]!.pageKey, expected[0]!.rowKey, render,
      QUALIFICATION_CONTRACT.model, VALUE_READING_EXECUTION.promptTemplateId,
      VALUE_READING_EXECUTION.promptTemplateVersion, VALUE_READING_EXECUTION.outputSchemaVersion])), ...overrides };
}

describe('frozen B4.6.1 qualification registration', () => {
  it('matches the actual tracked scorer, taxonomy, request execution, prompt, corpus and bar', () => {
    const observed = { scorer: QUALIFICATION_DECISION_VERSION, taxonomy: QUALIFICATION_TAXONOMY_VERSION,
      binding: QUALIFICATION_BINDING_VERSION, tasks: QUALIFICATION_TASKS, execution: VALUE_READING_EXECUTION,
      activationBar: VALUE_READING_ACTIVATION_BAR, pins,
      promptSha256: sha256Hex(readFileSync('lib/forgewing/prompts/valueReading.md')),
      sourceSha256: Object.fromEntries(Object.keys(QUALIFICATION_CONTRACT.sourceSha256).map(file => [file, qualificationSourceDigest(readFileSync(file, 'utf8'))])) };
    expect(() => assertQualificationContract(observed)).not.toThrow();
    expect(() => assertQualificationContract({ ...observed, execution: { ...VALUE_READING_EXECUTION, timeoutMs: 9000 } })).toThrow('execution');
    expect(() => assertQualificationContract({ ...observed, taxonomy: 'other' })).toThrow('taxonomy');
    expect(() => assertQualificationContract({ ...observed, promptSha256: 'c'.repeat(64) })).toThrow('promptSha256');
    expect(() => assertQualificationContract({ ...observed, pins: { ...pins, documents: pins.documents.slice(1) } })).toThrow('corpus pins');
  });
});

describe('pinned capture integrity', () => {
  it('accepts complete producer manifests and observes runtime identity without fixing a machine', () => {
    const fixture = captureFixture();
    expect(validate(fixture)).toEqual({ runtimeIdentityDigest: fixture.hashes.runtime_identity_digest, captureSetDigest: fixture.hashes.capture_set_digest });
  });
  it('refuses missing manifests and incomplete capture sets', () => {
    expect(() => validateQualificationCaptures(pins, null, null, () => new Uint8Array())).toThrow('requires pinned');
    const fixture = captureFixture();
    delete fixture.hashes.captures['extraction/Golden.json'];
    fixture.hashes.capture_set_digest = hashCanonical(fixture.hashes.captures);
    fixture.manifest.capture_set_digest = fixture.hashes.capture_set_digest;
    expect(() => validate(fixture)).toThrow('missing extraction/Golden.json');
  });
  it('rejects changed extraction bytes even with intact source PDF identity', () => {
    const fixture = captureFixture();
    fixture.artifacts['extraction/Golden.json'] = new TextEncoder().encode('tampered extraction');
    expect(() => validate(fixture)).toThrow('artifact digest mismatch');
  });
  it('rejects stale runtime/capture identities and corpus substitutions', () => {
    const fixture = captureFixture();
    fixture.manifest.identity.node_version = 'changed';
    expect(() => validate(fixture)).toThrow('runtime identity mismatch');
    fixture.manifest.runtime_identity_digest = hashCanonical(fixture.manifest.identity);
    fixture.hashes.runtime_identity_digest = fixture.manifest.runtime_identity_digest;
    fixture.manifest.identity.fixture_manifest_digest = 'f'.repeat(64);
    fixture.manifest.runtime_identity_digest = hashCanonical(fixture.manifest.identity);
    fixture.hashes.runtime_identity_digest = fixture.manifest.runtime_identity_digest;
    expect(() => validate(fixture)).toThrow('corpus identity mismatch');
  });
  it('refuses traversal even with a self-consistent capture-set digest', () => {
    const fixture = captureFixture();
    fixture.hashes.captures['../foreign.json'] = 'a'.repeat(64);
    fixture.hashes.capture_set_digest = hashCanonical(fixture.hashes.captures);
    fixture.manifest.capture_set_digest = fixture.hashes.capture_set_digest;
    expect(() => validate(fixture)).toThrow('invalid capture manifest entry');
  });
});

describe('live decision record identity', () => {
  it('accepts exactly the selected targets and their pinned request identity', () => {
    expect(() => validateQualificationRecords([record()], expected)).not.toThrow();
  });
  it('rejects foreign, duplicate, wrong-class and missing rows', () => {
    expect(() => validateQualificationRecords([record({ rowKey: 'foreign' })], expected)).toThrow('foreign');
    expect(() => validateQualificationRecords([record(), record()], expected)).toThrow('duplicate');
    expect(() => validateQualificationRecords([record({ evidenceClass: 'ocr_price_sheet' })], expected)).toThrow('foreign');
    expect(() => validateQualificationRecords([], expected)).toThrow('missing');
  });
  it('rejects a request measured under another model or prompt and dry-run records', () => {
    expect(() => validateQualificationRecords([record({ requestDigestSha256: 'f'.repeat(64) })], expected)).toThrow('request identity');
    expect(() => validateQualificationRecords([record({ providerCalled: false, failureReason: 'dry_run' })], expected)).toThrow('dry');
  });
  it('retains a failed crop in the selected denominator while refusing fabricated uncalled successes', () => {
    expect(() => validateQualificationRecords([record({ providerCalled: false, outcome: 'failed',
      failureReason: 'region_image_unavailable', requestDigestSha256: null })], expected)).not.toThrow();
    expect(() => validateQualificationRecords([record({ providerCalled: false, requestDigestSha256: null })], expected)).toThrow('no provider measurement');
  });
});

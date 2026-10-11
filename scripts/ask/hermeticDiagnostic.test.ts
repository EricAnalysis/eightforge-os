import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { classifyQuestion } from '@/lib/ask/classifier';
import { retrieveProjectTruth } from '@/lib/ask/retrieval';
import { buildAskResponse } from '@/lib/ask/answerBuilder';
import { buildPortfolioAskAnswer } from '@/lib/ask/portfolioAnswerBuilder';
import type { AskResponse } from '@/lib/ask/types';
import type { AskAnswerContract } from '@/lib/ask/globalCommand';
import { QUERIES } from './diagnosticCorpus';
import { FIXTURE_VERSION, fixtureAdmin, operations, portfolio, project, tables } from './diagnosticFixture';

const CORPUS_VERSION = 'ask-operator-corpus-60-v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Response = AskResponse | AskAnswerContract;
type Expectation = { kind: 'material'; values: string[] } | { kind: 'refusal'; missing: RegExp };
// Contracts describe missing canonical inputs, not the historical failure IDs.
const contracts: Record<number, Expectation> = {};
const material = (ids: number[], values: string[]) => ids.forEach(id => contracts[id] = { kind: 'material', values });
const refusal = (ids: number[], missing: RegExp) => ids.forEach(id => contracts[id] = { kind: 'refusal', missing });
const canonicalSourceIds: Record<number, string[]> = {};
const portfolioContracts: Record<number, { sources: string[]; projectId: string }> = {};
for (const id of [17, 60, 59]) portfolioContracts[id] = {
  sources: ['portfolio-safe project status aggregate'], projectId: 'synthetic-project' };
for (const id of [21, 58]) portfolioContracts[id] = {
  sources: ['portfolio-safe project status aggregate'], projectId: 'synthetic-ready' };
for (const id of [18, 19, 20]) portfolioContracts[id] = {
  sources: ['portfolio command center aggregates', 'operational queue project rollups'], projectId: 'synthetic-project' };
const sourceIds = (ids: number[], identities: string[]) => ids.forEach(id => canonicalSourceIds[id] = identities);
sourceIds([1, 23], ['project:synthetic-project:invoice:SYN-101:billed_amount']);
sourceIds([3, 24, 54], ['project:synthetic-project:validator-summary']);
sourceIds([2, 27, 28, 29], ['project:synthetic-project:validator-summary']);
sourceIds([42], ['project:synthetic-project:total_billed', 'project:synthetic-project:nte_amount']);
sourceIds([5], ['project:synthetic-project:validator-summary']);
sourceIds([4], ['synthetic-total-fact', 'project:synthetic-project:invoice:SYN-101:billed_amount']);
// Exposure is a prebuilt validation snapshot field, not an independently
// persisted total_at_risk scalar row (retrieval intentionally creates none).
sourceIds([6], ['project:synthetic-project:validator-summary']);
sourceIds([25, 53, 57], ['project:synthetic-project:execution_summary']);
sourceIds([49], ['project:synthetic-project:validator-summary:reviewed_documents_with_warnings']);
sourceIds([52], ['project:synthetic-project:validator-summary:first_document_to_inspect']);
material([1, 3, 23, 24, 54], ['block', '2']);
material([2, 27, 28], ['SYN-101', '700,000', '115,559']);
// Invoice exposure cannot establish ticket-specific costs.
refusal([5], /ticket.*cost/i);
material([4], ['815,559', 'SYN-101']);
material([6, 29], ['115,559']);
material([25, 53, 57], ['none', 'execution']);
material([42], ['1,000,000', '815,559']);
material([49], ['no document', 'canonical']);
material([52], ['no document', 'canonical']);
material([17, 60], ['Synthetic Operations', '1']);
material([18], ['115,559']);
material([19], ['Synthetic Operations']);
material([20], ['rate mismatch', '2']);
material([21, 58], ['Synthetic Ready', '1']);
material([59], ['Synthetic Operations', '1']);
refusal([7, 56], /review|history|audit/i);
refusal([8, 35], /contract|governing/i);
refusal([9, 40], /fee|clause|contract/i);
refusal([10], /fema|reimburs|contract/i);
refusal([11, 45], /compliance|contract|clause/i);
refusal([12, 46], /private|contract|clause/i);
refusal([13], /bond|contract|clause/i);
refusal([14, 47], /funding|quantity|contract|clause/i);
refusal([15, 44], /monitor|contract|clause/i);
refusal([16, 43], /payment|contract|clause/i);
refusal([22], /ceiling/i);
refusal([26, 30], /invoice_exception_eligibility|approval|exception/i);
refusal([31, 32, 33, 34], /ticket|finding|review/i);
refusal([36], /amendment|rate|contract/i);
refusal([37], /supersed|replace|document/i);
refusal([38], /conflict|fact/i);
refusal([39, 41], /rate|finding/i);
refusal([48, 50, 51, 55], /review|override|human|audit/i);

function check(response: Response, expectation: Expectation, queryId?: number): void {
  const text = response.answer ?? '';
  if (expectation.kind === 'refusal') {
    assert.ok(response.actionableGap, 'Missing canonical input must produce a typed actionable gap');
    assert.equal(response.actionableGap.gapClass, 'upstream');
    assert.ok(response.actionableGap.missing.length > 0);
    assert.match(response.actionableGap.missing, expectation.missing);
    assert.ok(response.actionableGap.resolutionWorkflow.length > 0);
    assert.ok(response.actionableGap.nextAction.length > 0);
    if ('confidence' in response) {
      assert.equal(response.confidence, 'low');
      assert.equal(response.sections?.confidenceState, 'Not Found');
      assert.equal(response.sources.length, 0, 'Refusal must not carry unrelated evidence as support');
    }
    else assert.equal(response.dataFound, false);
    assert.match(text, /cannot|not answerable|isn't answerable|unavailable|missing|not found/i);
    return;
  }
  assert.equal(response.actionableGap, undefined, 'Supported canonical input must be read');
  if ('confidence' in response) assert.notEqual(response.sections?.confidenceState, 'Not Found');
  else assert.equal(response.dataFound, true);
  for (const value of expectation.values) assert.ok(text.toLowerCase().includes(value.toLowerCase()), `Missing canonical value ${value}`);
  assert.ok(response.sources.length > 0, 'Material claims require sources');
  if ('evidence' in response) {
    const expected = portfolioContracts[queryId ?? 17];
    assert.ok(expected, 'Portfolio contract must identify its canonical inputs');
    assert.deepEqual(response.sources, expected.sources, 'Portfolio source identity mismatch');
    assert.ok(response.evidence.length > 0, 'Material portfolio claims require evidence links');
    assert.ok(response.evidence.some(item => item.href?.includes(`/projects/${expected.projectId}`)
      && /aggregate|validation|readiness/.test(item.source ?? '')), 'Portfolio evidence must identify the expected project aggregate');
  }
  else {
    const allowed = canonicalSourceIds[queryId ?? 27] ?? [];
    assert.ok(response.sources.some(source => source.factId && allowed.includes(source.factId)), 'Material project claim requires its canonical source identity');
    assert.ok(response.sources.some(source => (source.snippet ?? '').length > 0), 'Source must carry stored evidence');
  }
}

describe('versioned hermetic Ask correctness (material answers and explicit refusals)', () => {
  it('executes every corpus query through real classifier, retrieval, and builders without credentials', async () => {
    assert.equal(QUERIES.length, 60);
    assert.deepEqual(QUERIES.map(query => query.id), Array.from({ length: 60 }, (_, index) => index + 1));
    assert.deepEqual(Object.keys(contracts).map(Number).sort((a, b) => a - b), QUERIES.map(query => query.id));
    const records = [];
    for (const query of QUERIES) {
      let response: Response;
      if (query.scope === 'project') {
        const question = classifyQuestion(query.text);
        const retrieval = await retrieveProjectTruth({ admin: fixtureAdmin() as never, question, project,
          projectId: project.id, orgId: 'synthetic-org' });
        response = buildAskResponse({ question, retrieval, project, projectId: project.id, orgId: 'synthetic-org' });
      } else {
        response = buildPortfolioAskAnswer({ question: query.text, portfolio: portfolio as never,
          operations: operations as never, promptVersion: 'hermetic-v1',
          stalenessByProjectId: new Map([[project.id, { isStale: true, label: 'Synthetic stale snapshot' } as never]]) });
      }
      let failure: string | null = null;
      try { check(response, contracts[query.id], query.id); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      records.push({ queryId: query.id, matrixId: query.matrixId ?? null, contract: contracts[query.id].kind,
        answer: response.answer, sources: response.sources, actionableGap: response.actionableGap ?? null, failure });
    }
    const result = { corpusVersion: CORPUS_VERSION, corpusSha256: digest(QUERIES), fixtureVersion: FIXTURE_VERSION,
      inputSha256: digest({ project, tables, portfolio, operations }),
      contractSha256: digest({ contracts: Object.entries(contracts).map(([id, contract]) =>
        [id, contract.kind === 'refusal' ? { kind: contract.kind, missing: contract.missing.toString() } : contract]), canonicalSourceIds, portfolioContracts }),
      expectedMaterialCoverage: records.filter(record => record.contract === 'material').length,
      expectedRefusalCoverage: records.filter(record => record.contract === 'refusal').length,
      correctnessFailures: records.filter(record => record.failure).length, records };
    const out = process.env.ASK_DIAGNOSTIC_ARTIFACT_DIR ?? path.resolve('scripts/ask/artifacts');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'hermetic-correctness.json'), JSON.stringify(result, null, 2));
    const identity = JSON.parse(readFileSync(path.resolve(__dirname, 'diagnosticIdentity.json'), 'utf8'));
    for (const key of ['corpusVersion', 'corpusSha256', 'fixtureVersion', 'inputSha256', 'contractSha256',
      'expectedMaterialCoverage', 'expectedRefusalCoverage'] as const) {
      assert.equal(result[key], identity[key], `Diagnostic identity drift: ${key}`);
    }
    assert.deepEqual(records.filter(record => record.failure).map(record => ({ query: record.queryId, failure: record.failure })), []);
  });

  it('rejects plausible prose, unrelated evidence, and gaps disguised as answers', () => {
    const unrelatedPortfolio = { answer: 'Synthetic Operations blocked count 1', dataFound: true,
      sources: ['unrelated'], evidence: [{ href: '/projects/unrelated', source: 'unrelated' }] } as unknown as Response;
    assert.throws(() => check(unrelatedPortfolio, contracts[17], 17), /Portfolio source identity/);
    assert.throws(() => check({ ...unrelatedPortfolio, sources: portfolioContracts[17].sources } as Response,
      contracts[17], 17), /expected project aggregate/);
    const fake = { answer: 'Invoice SYN-101 supported $700,000; unsupported $115,559.', confidence: 'verified', sources: [] } as unknown as Response;
    assert.throws(() => check(fake, contracts[27]), /sources/);
    assert.throws(() => check({ ...fake, sources: [{ type: 'fact', factId: 'real-but-unrelated-vendor-fact', label: 'Unrelated', snippet: 'Vendor only' }] } as unknown as Response, contracts[27]), /canonical source identity/);
    assert.throws(() => check(fake, contracts[22]), /typed actionable gap/);
    assert.throws(() => check({ ...fake, actionableGap: { gapClass: 'upstream', missing: 'ceiling', resolutionWorkflow: 'Open Portfolio', nextAction: 'Open Portfolio' } } as unknown as Response, contracts[27]), /must be read/);
  });

  it('filters synthetic storage by scope and exposes no mutation API', async () => {
    const admin = fixtureAdmin();
    assert.deepEqual((await admin.from('document_facts').select().eq('organization_id', 'other')).data, []);
    assert.equal('insert' in admin.from('document_facts'), false);
    assert.equal('rpc' in admin, false);
    assert.throws(() => admin.from('unversioned-table'), /Unversioned fixture table/);
  });
});

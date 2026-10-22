/**
 * Case Investigation v3: pre-contract latency and compatibility probe. NOT a qualification.
 * Explicit, manual command; never run in CI.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/probeLatencyV3.ts -- \
 *     --corpus <r2 dir> --out <new dir outside the repository> [--cases 10] --confirm-paid-probe
 *
 * Owner-approved (2026-10-22) to measure whether the v3 answer budget can meet the unchanged
 * latency bars before a v3 contract is frozen. It uses the production runner and Claude adapter
 * unchanged, on the corpus's synthetic conflict-fixture cases only (no customer content), with
 * each frozen v2 context given its v3 relationships provenance by the production helpers.
 *
 * Nothing that could tune the prompt is kept: the answer text is never stored or printed, and
 * no label is read. Only status, latency, token counts and the runner's violation categories
 * are written.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { auditRawAnswer, costUsd } from '@/lib/evaluation/caseInvestigation/qualificationV2';
import { CASE_INVESTIGATION_EXECUTION, createClaudeCaseInvestigationProvider } from '@/lib/forgewing/runtime/caseInvestigationClient';
import {
  documentRelationshipRecordIds, type InvestigationContext, investigationContextDigests,
} from '@/lib/resolution/investigationContext';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import { PROVIDER_RANKABLE_ACTION_KINDS, runProviderCaseInvestigation } from '@/lib/server/caseInvestigationRunner';

const MODEL = 'claude-sonnet-4-6';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

type Entry = Readonly<{ caseId: string; source: string; excluded: unknown; transmittedDigest: string; readDigest: string }>;
type CaseFile = Readonly<{ resolutionCase: ResolutionCase; providerContext: InvestigationContext }>;

/** The frozen v2 context, with only the relationships provenance re-derived by the production rule. */
function withV3Provenance(file: CaseFile): InvestigationContext {
  const slices = file.providerContext.slices.map((slice) => slice.kind !== 'document_relationships' ? slice : {
    ...slice,
    provenance: { ...slice.provenance,
      recordIds: documentRelationshipRecordIds(file.resolutionCase.documentId, slice.payload as never) },
  });
  return { ...file.providerContext, slices, ...investigationContextDigests(file.providerContext.caseId, slices) };
}

async function main() {
  if (!process.argv.includes('--confirm-paid-probe')) throw new Error('the probe makes provider calls: pass --confirm-paid-probe');
  const corpus = flag('corpus');
  const cases = Number(flag('cases', '10'));
  const out = path.resolve(flag('out'));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`refusing a non-empty --out: ${out}`);
  if (!path.relative(process.cwd(), out).startsWith('..')) throw new Error('--out must be outside the repository');
  mkdirSync(out, { recursive: true });

  const manifest = readJson<{ entries: Entry[] }>(path.join(corpus, 'corpus-manifest.repo.json'));
  const selected = manifest.entries.filter((entry) => entry.excluded == null && entry.source === 'conflict_fixture')
    .sort((left, right) => left.caseId.localeCompare(right.caseId)).slice(0, cases);
  if (selected.length !== cases) throw new Error(`only ${selected.length} conflict-fixture cases`);

  let observed: { usage: { input_tokens?: number; output_tokens?: number } | null; stopReason: string | null;
    raw: string | null } = { usage: null, stopReason: null, raw: null };
  const observingClient = () => {
    const real = getClaudeClient();
    return { messages: { async create(body: never, options: never) {
      const message = await (real.messages.create as unknown as (b: never, o: never) => Promise<{
        content: { type: string; text?: string }[]; stop_reason?: string | null;
        usage?: { input_tokens?: number; output_tokens?: number } }>)(body, options);
      observed = { usage: message.usage ?? null, stopReason: message.stop_reason ?? null,
        raw: message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') };
      return message;
    } } };
  };
  const provider = createClaudeCaseInvestigationProvider({ model: MODEL, client: observingClient as never });

  const results: Record<string, unknown>[] = [];
  for (const entry of selected) {
    const file = readJson<CaseFile>(path.join(corpus, 'cases', `${sha256(entry.caseId).slice(0, 16)}.json`));
    // The refactored digest helper must reproduce the frozen v2 identity before anything is re-derived.
    if (investigationContextDigests(entry.caseId, file.providerContext.slices).transmittedDigest !== entry.transmittedDigest) {
      throw new Error(`v2 digest not reproduced: ${entry.caseId}`);
    }
    const context = withV3Provenance(file);
    observed = { usage: null, stopReason: null, raw: null };
    let latencyMs = 0;
    const result = await runProviderCaseInvestigation({ organizationId: 'case-investigation-v3-probe',
      projectId: 'probe', caseId: entry.caseId, requestedBy: 'case-investigation-v3-probe' }, {
      readContext: (async () => ({ status: 'ok', resolutionCase: file.resolutionCase, context })) as never,
      resolveEligibility: (async () => ({ eligible: true, entitlementEventId: 'probe', dataPolicyEventIds: [],
        dailyCap: cases })) as never,
      reserve: (async () => ({ status: 'reserved', reservationId: `probe-${results.length + 1}`, usedInWindow: results.length })) as never,
      provider: { providerModel: provider.providerModel, async investigate(request) {
        const started = performance.now();
        try { return await provider.investigate(request); } finally { latencyMs = performance.now() - started; }
      } },
    });
    const offered = [...new Set(file.resolutionCase.actions.map((action) => action.kind))]
      .filter((kind) => PROVIDER_RANKABLE_ACTION_KINDS.has(kind));
    const transmitted = context.slices.filter((slice) => slice.transmitted)
      .map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload }));
    results.push({
      caseIdSha256: sha256(entry.caseId), status: result.status, latencyMs: Math.round(latencyMs),
      inputTokens: observed.usage?.input_tokens ?? null, outputTokens: observed.usage?.output_tokens ?? null,
      stopReason: observed.stopReason,
      violations: observed.raw != null ? auditRawAnswer(observed.raw, { offeredActionKinds: offered, transmitted }) : null,
    });
    console.log(`[probe] ${results.length}/${cases} ${result.status} ${Math.round(latencyMs)}ms out=${observed.usage?.output_tokens ?? '-'}`);
  }
  const latencies = results.map((entry) => entry.latencyMs as number).sort((left, right) => left - right);
  const nearestRank = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)]!;
  const spend = results.reduce<number>((sum, entry) => sum + (entry.inputTokens != null && entry.outputTokens != null
    ? costUsd(entry.inputTokens as number, entry.outputTokens as number) : 0), 0);
  const summary = { probe: 'case_investigation_v3_latency_probe', model: MODEL, execution: CASE_INVESTIGATION_EXECUTION,
    calls: results.length, medianLatencyMs: nearestRank(0.5), p95LatencyMs: nearestRank(0.95),
    proposed: results.filter((entry) => entry.status === 'proposed').length, knownSpendUsd: Number(spend.toFixed(6)) };
  writeFileSync(path.join(out, 'probe.json'), `${JSON.stringify({ summary, results }, null, 2)}\n`);
  console.log(`[probe] ${JSON.stringify(summary)}`);
}

await main();

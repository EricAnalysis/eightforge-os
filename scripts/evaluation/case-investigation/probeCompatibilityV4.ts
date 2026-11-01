/**
 * Case Investigation v4: provider compatibility probe. NOT a qualification. Explicit, manual
 * command; never run in CI.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/case-investigation/probeCompatibilityV4.ts -- \
 *     --out <new dir outside the repository> --confirm-paid-probe
 *
 * Answers one question: does `claude-sonnet-5-5` accept the v4 request body and return a parseable
 * structured answer, so a basic provider or schema defect is not discovered by the 111-case run?
 *
 * Three invented contexts through the production runner and adapter. They are not corpus cases and
 * hold no customer content, so no qualification case is seen before the run. Nothing that could
 * tune the prompt is kept: the answer text is never stored or printed, and no label is read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CASE_INVESTIGATION_MODEL_V4, CASE_INVESTIGATION_PRICING_V4 } from '@/lib/evaluation/caseInvestigation/qualificationV4';
import { auditRawAnswer, costUsd } from '@/lib/evaluation/caseInvestigation/qualificationV2';
import {
  buildCaseInvestigationMessagesRequest, CASE_INVESTIGATION_EXECUTION, createClaudeCaseInvestigationProvider,
} from '@/lib/forgewing/runtime/caseInvestigationClient';
import { investigationContextDigests, type InvestigationSlice } from '@/lib/resolution/investigationContext';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import { CASE_INVESTIGATION_SYSTEM_PROMPT, providerRequestContext, runProviderCaseInvestigation } from '@/lib/server/caseInvestigationRunner';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Invented records for an invented project; the case id prefix keeps them out of any corpus. */
function syntheticCase(index: number, detail: string, actions: readonly string[]) {
  const caseId = `compatibility-probe-${index}`;
  const slices = [{
    kind: 'case_evidence', contentClass: 'text_excerpts', transmitted: true,
    provenance: { source: 'resolution_case', documentId: `probe-document-${index}`, physicalPageNumber: 1, recordIds: [`probe-record-${index}-a`, `probe-record-${index}-b`] },
    payload: { detail },
  }] as unknown as InvestigationSlice[];
  const context = { caseId, purpose: 'provider_investigation', slices, omissions: [], ...investigationContextDigests(caseId, slices) };
  const resolutionCase = { caseId, kind: 'validator_finding', documentId: `probe-document-${index}`,
    finding: { checkKey: `probe-check-${index}`, ruleId: 'PROBE_RULE' }, actions: actions.map((kind) => ({ kind })) };
  return { caseId, context, resolutionCase, slices, actions };
}

const CASES = [
  syntheticCase(1, 'Invented invoice line 7 bills 40 units at 12.50; the invented rate schedule lists 11.75 for the same item.', ['open_document', 'open_linked_documents']),
  syntheticCase(2, 'Invented ticket T-100 records 30 units; invented ticket T-200 records 35 units for the same load, so the two sources conflict.', ['open_document']),
  syntheticCase(3, 'Invented invoice 55 has no supporting document in the invented project file.', ['upload_document', 'open_document']),
];

async function main() {
  if (!process.argv.includes('--confirm-paid-probe')) throw new Error('the probe makes provider calls: pass --confirm-paid-probe');
  const out = path.resolve(flag('out'));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`refusing a non-empty --out: ${out}`);
  if (!path.relative(process.cwd(), out).startsWith('..')) throw new Error('--out must be outside the repository');
  mkdirSync(out, { recursive: true });

  type Seen = { usage: { input_tokens?: number; output_tokens?: number } | null; stopReason: string | null; model: string | null;
    blockTypes: string[]; raw: string | null; error: { name: string; status: number | null } | null };
  let seen: Seen = { usage: null, stopReason: null, model: null, blockTypes: [], raw: null, error: null };
  const observingClient = () => {
    const real = getClaudeClient();
    return { messages: { async create(body: never, options: never) {
      try {
        const message = await (real.messages.create as unknown as (b: never, o: never) => Promise<{
          content: { type: string; text?: string }[]; stop_reason?: string | null; model?: string;
          usage?: { input_tokens?: number; output_tokens?: number } }>)(body, options);
        seen = { ...seen, usage: message.usage ?? null, stopReason: message.stop_reason ?? null, model: message.model ?? null,
          blockTypes: message.content.map((block) => block.type),
          raw: message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') };
        return message;
      } catch (error) {
        seen = { ...seen, error: { name: error instanceof Error ? error.constructor.name : 'unknown',
          status: typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : null } };
        throw error;
      }
    } } };
  };
  const provider = createClaudeCaseInvestigationProvider({ model: CASE_INVESTIGATION_MODEL_V4, client: observingClient as never });

  const results: Record<string, unknown>[] = [];
  for (const item of CASES) {
    seen = { usage: null, stopReason: null, model: null, blockTypes: [], raw: null, error: null };
    let latencyMs = 0;
    const result = await runProviderCaseInvestigation({ organizationId: 'case-investigation-v4-probe', projectId: 'probe',
      caseId: item.caseId, requestedBy: 'case-investigation-v4-probe' }, {
      readContext: (async () => ({ status: 'ok', resolutionCase: item.resolutionCase, context: item.context })) as never,
      resolveEligibility: (async () => ({ eligible: true, entitlementEventId: 'probe', dataPolicyEventIds: [], dailyCap: CASES.length })) as never,
      reserve: (async () => ({ status: 'reserved', reservationId: `probe-${results.length + 1}`, usedInWindow: results.length })) as never,
      provider: { providerModel: provider.providerModel, async investigate(request) {
        const started = performance.now();
        try { return await provider.investigate(request); } finally { latencyMs = performance.now() - started; }
      } },
    });
    const built = buildCaseInvestigationMessagesRequest(CASE_INVESTIGATION_MODEL_V4, { system: CASE_INVESTIGATION_SYSTEM_PROMPT,
      context: providerRequestContext(item.slices.map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload }))),
      offeredActionKinds: item.actions });
    // Categories and sizes only, the same reasons the runner applies; never the answer's text.
    const transmitted = item.slices.map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload }));
    const parsed = (() => { try { return JSON.parse(seen.raw ?? '') as Record<string, unknown>; } catch { return null; } })();
    const shape = parsed && { keys: Object.keys(parsed).sort(), diagnosisChars: String(parsed.diagnosis ?? '').length,
      rationaleChars: String(parsed.rationale ?? '').length, citations: Array.isArray(parsed.citations) ? parsed.citations.length : null,
      ranked: Array.isArray(parsed.rankedActionKinds) ? parsed.rankedActionKinds.length : null };
    const violations = seen.raw != null ? auditRawAnswer(seen.raw, { offeredActionKinds: item.actions, transmitted }) : null;
    console.log(`[probe] shape ${JSON.stringify(shape)} violations ${JSON.stringify(violations)}`);
    results.push({ case: item.caseId, status: result.status, latencyMs: Math.round(latencyMs), responseModel: seen.model, shape, violations,
      stopReason: seen.stopReason, blockTypes: seen.blockTypes, error: seen.error, inputTokens: seen.usage?.input_tokens ?? null,
      outputTokens: seen.usage?.output_tokens ?? null, requestBodyKeys: Object.keys(built.body), requestBodySha256: sha256(JSON.stringify(built.body)) });
    console.log(`[probe] ${results.length}/${CASES.length} ${result.status} ${Math.round(latencyMs)}ms model=${seen.model ?? '-'} stop=${seen.stopReason ?? '-'} out=${seen.usage?.output_tokens ?? '-'} error=${seen.error?.status ?? '-'}`);
  }
  const knownSpendUsd = results.reduce<number>((sum, entry) => sum + (entry.inputTokens != null && entry.outputTokens != null
    ? costUsd(entry.inputTokens as number, entry.outputTokens as number, CASE_INVESTIGATION_PRICING_V4) : 0), 0);
  const summary = { probe: 'case_investigation_v4_compatibility_probe', model: CASE_INVESTIGATION_MODEL_V4,
    execution: CASE_INVESTIGATION_EXECUTION, promptSha256: sha256(CASE_INVESTIGATION_SYSTEM_PROMPT), calls: results.length,
    accepted: results.filter((entry) => entry.error == null).length, knownSpendUsd: Number(knownSpendUsd.toFixed(6)) };
  writeFileSync(path.join(out, 'probe.json'), `${JSON.stringify({ summary, results }, null, 2)}\n`);
  console.log(`[probe] ${JSON.stringify(summary)}`);
}

await main();

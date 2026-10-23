import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';
import {
  reserveForgewingProviderCall,
  resolveForgewingWorkflowEligibility,
  type AiProviderContentClass,
  type ValueReadingEligibility,
} from '@/lib/server/forgewingGates';
import { readInvestigationContext, type InvestigationContextReadResult } from '@/lib/server/investigationContextRead';

/**
 * Provider-backed investigation of a ResolutionCase (Forgewing
 * generalization, phase 4). Wired end to end, and closed today: the
 * `case_investigation` policy is unqualified, so every request stops at the
 * gates until a benchmark qualifies it, exactly as value reading did (B4.6).
 *
 * When it does run: the context is the shared investigation context with the
 * provider purpose (only approved content classes, within budget); the gates
 * are the shared Forgewing gates for this workflow; one slot of its own
 * durable budget is spent, bound to the exact request, before the call. The
 * answer is a non-authoritative explanation that may only rank actions the
 * case already lists. It writes nothing and decides nothing.
 */

export const CASE_INVESTIGATION_PROMPT_VERSION = 'case_investigation_prompt_v3';

/**
 * The answer's bounds, enforced below and by forgewing_case_investigations' checks. Structured
 * outputs cannot express string lengths, so the prompt states them (v3); v2 enforced them unstated.
 * A shorter budget (400 / 600 characters, 500 tokens) was probed on 2026-10-22 and not adopted:
 * the model overran it or was truncated, and latency still missed the bar (runbook v3).
 */
export const CASE_INVESTIGATION_OUTPUT_LIMITS = Object.freeze({
  diagnosisMaxChars: 1200,
  rationaleMaxChars: 2000,
  rankedActionKindsMax: 8,
  evidenceRefsMin: 1,
  evidenceRefsMax: 12,
});

const LIMITS = CASE_INVESTIGATION_OUTPUT_LIMITS;

export const CASE_INVESTIGATION_SYSTEM_PROMPT = [
  'You investigate one EightForge Validator finding for a human operator.',
  'Use only the provided context. Do not invent values, documents or findings; every number you write must appear in the context.',
  'Explain the most likely cause, cite the context records it rests on, and rank only the offered action kinds.',
  'When sources conflict, explain the conflict; never choose which source is right.',
  'You decide nothing: never recommend approving, correcting or overriding the finding. The operator makes every decision through the listed actions.',
  `Keep the diagnosis within ${LIMITS.diagnosisMaxChars} characters and the rationale within ${LIMITS.rationaleMaxChars}. `
    + `Cite ${LIMITS.evidenceRefsMin} to ${LIMITS.evidenceRefsMax} records by the letter ref each slice's "cite" map gives them (for example "B"); never write a record id.`,
  'Write points as prose, or separate them with semicolons; never number or letter them.',
].join('\n');

/**
 * Case kinds a provider may investigate (P3b): Validator failures, including
 * the conflict rules. Others keep their deterministic investigation only.
 */
export const PROVIDER_INVESTIGABLE_CASE_KINDS: readonly ResolutionCase['kind'][] = Object.freeze(['validator_finding']);

/**
 * The only actions a provider may rank: navigation and typed human paths from
 * the B6.2 vocabulary. Never the decision (`resolve_execution_item` carries
 * approve / correct / override), never a value entry, never the Validator.
 */
export const PROVIDER_RANKABLE_ACTION_KINDS: ReadonlySet<ResolutionAction['kind']> = new Set([
  'open_document', 'link_invoice_line_rate', 'upload_document', 'open_linked_documents',
]);

export type CaseInvestigationProvider = Readonly<{
  providerModel: string;
  investigate(request: Readonly<{ system: string; context: unknown; offeredActionKinds: readonly string[] }>): Promise<string>;
}>;

const OutputSchema = z.object({
  diagnosis: z.string().min(1).max(LIMITS.diagnosisMaxChars),
  rankedActionKinds: z.array(z.string()).max(LIMITS.rankedActionKindsMax),
  rationale: z.string().min(1).max(LIMITS.rationaleMaxChars),
  /**
   * The transmitted context records the explanation rests on. A recordId has no length bound of
   * its own: it must equal a transmitted record id exactly (checked below), and those run past
   * 300 characters (v2 capped them at 200, so such a record could never be cited).
   */
  /** The transmitted records the explanation rests on, by their letter ref (`citableRecords`). */
  citations: z.array(z.string().min(1).max(8)).min(LIMITS.evidenceRefsMin).max(LIMITS.evidenceRefsMax),
}).strict();

/** Every number written in the answer, normalized (thousands separators and currency removed). */
export function numericTokens(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/gu)]
    .map((match) => match[0].replace(/,/gu, '').replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1'))
    .filter((token) => token.length > 0);
}

/** A record's citation ref: A, B, ... Z, AA, AB, ... Letters only, so a ref is never a number. */
export function citationRef(index: number): string {
  let ref = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) ref = String.fromCharCode(65 + ((rest - 1) % 26)) + ref;
  return ref;
}

/**
 * Every transmitted record, in context order, with the short ref the model cites it by (v3).
 * Echoed record ids (up to 315 characters) were a large share of v2's output, and output length
 * drove its latency; the runner maps each ref back to its slice kind and record id.
 */
export function citableRecords(transmitted: readonly Readonly<{ kind: string; provenance: { recordIds: readonly string[] } }>[]) {
  const records: { ref: string; sliceKind: string; recordId: string }[] = [];
  for (const slice of transmitted) {
    for (const recordId of new Set(slice.provenance.recordIds)) {
      records.push({ ref: citationRef(records.length), sliceKind: slice.kind, recordId });
    }
  }
  return records;
}

/** Exactly what the provider receives as context: each transmitted slice, with its records' letter refs. */
export function providerRequestContext(
  transmitted: readonly Readonly<{ kind: string; provenance: { recordIds: readonly string[] }; payload: unknown }>[],
) {
  const citable = citableRecords(transmitted);
  return transmitted.map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload,
    cite: Object.fromEntries(citable.filter((record) => record.sliceKind === slice.kind)
      .map((record) => [record.ref, record.recordId])) }));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * What the answer writes that the transmitted context never contained: every number, and every
 * UUID. A UUID is read whole, as an identifier the context must have carried (in a payload or a
 * provenance record), so its digits are never mistaken for loose numbers. Nothing else is exempt.
 */
export function unsupportedNumbers(answer: string,
  transmitted: readonly Readonly<{ provenance: unknown; payload: unknown }>[]): string[] {
  const sentIdentifiers = JSON.stringify(transmitted.map((slice) => [slice.provenance, slice.payload])).toLowerCase();
  const sentNumbers = new Set(numericTokens(JSON.stringify(transmitted.map((slice) => slice.payload))));
  return [
    ...[...answer.matchAll(UUID)].map((match) => match[0].toLowerCase()).filter((id) => !sentIdentifiers.includes(id)),
    ...numericTokens(answer.replace(UUID, ' ')).filter((token) => !sentNumbers.has(token)),
  ];
}

export type ProviderCaseInvestigation = Readonly<{
  authority: 'non_authoritative';
  diagnosis: string;
  rankedActionKinds: readonly ResolutionAction['kind'][];
  rationale: string;
  evidenceRefs: readonly Readonly<{ sliceKind: string; recordId: string }>[];
  promptVersion: string;
  /** Identity for the durable record (P3c): what was sent, and the slot it spent. */
  caseKind: ResolutionCase['kind'];
  findingCheckKey: string | null;
  ruleId: string | null;
  contextTransmittedDigest: string;
  reservationId: string;
  providerModel: string;
  requestDigestSha256: string;
}>;

export type ProviderCaseInvestigationResult =
  | Readonly<{ status: 'proposed'; investigation: ProviderCaseInvestigation }>
  | Readonly<{ status: 'gated'; reason: Extract<ValueReadingEligibility, { eligible: false }>['reason'] }>
  | Readonly<{ status: 'case_kind_not_supported' }>
  | Readonly<{ status: 'nothing_to_send' }>
  | Readonly<{ status: 'provider_not_configured' }>
  | Readonly<{ status: 'budget_exhausted' }>
  | Readonly<{ status: 'reservation_failed' }>
  | Readonly<{ status: 'provider_failed' }>
  | Readonly<{ status: 'output_invalid' }>
  | Exclude<InvestigationContextReadResult, { status: 'ok' }>;

export type CaseInvestigationRunnerDependencies = Readonly<{
  readContext?: typeof readInvestigationContext;
  resolveEligibility?: typeof resolveForgewingWorkflowEligibility;
  reserve?: typeof reserveForgewingProviderCall;
  provider?: CaseInvestigationProvider | null;
  admin?: unknown;
}>;

function offeredKinds(resolutionCase: ResolutionCase): ResolutionAction['kind'][] {
  return [...new Set(resolutionCase.actions.map((action) => action.kind))]
    .filter((kind) => PROVIDER_RANKABLE_ACTION_KINDS.has(kind));
}

export async function runProviderCaseInvestigation(
  query: Readonly<{ organizationId: string; projectId: string; caseId: string; requestedBy: string }>,
  dependencies: CaseInvestigationRunnerDependencies = {},
): Promise<ProviderCaseInvestigationResult> {
  const read = await (dependencies.readContext ?? readInvestigationContext)({
    organizationId: query.organizationId, projectId: query.projectId, caseId: query.caseId, purpose: 'provider_investigation',
  }, dependencies.admin !== undefined ? { admin: dependencies.admin as never } : {});
  if (read.status !== 'ok') return read;
  if (!PROVIDER_INVESTIGABLE_CASE_KINDS.includes(read.resolutionCase.kind)) return { status: 'case_kind_not_supported' };
  const transmitted = read.context.slices.filter((slice) => slice.transmitted);
  const contentClasses = [...new Set(transmitted.flatMap((slice) =>
    slice.contentClass === 'metadata' ? [] : [slice.contentClass]))] as AiProviderContentClass[];
  if (contentClasses.length === 0) return { status: 'nothing_to_send' };

  const eligibility = await (dependencies.resolveEligibility ?? resolveForgewingWorkflowEligibility)(
    dependencies.admin as never, { organizationId: query.organizationId, workflow: 'case_investigation', contentClasses });
  if (!eligibility.eligible) return { status: 'gated', reason: eligibility.reason };
  const provider = dependencies.provider ?? null;
  if (!provider) return { status: 'provider_not_configured' };

  const offered = offeredKinds(read.resolutionCase);
  const citable = citableRecords(transmitted);
  const requestDigestSha256 = createHash('sha256').update(JSON.stringify([
    CASE_INVESTIGATION_PROMPT_VERSION, provider.providerModel, CASE_INVESTIGATION_SYSTEM_PROMPT,
    read.context.transmittedDigest, offered,
  ])).digest('hex');
  const reservation = await (dependencies.reserve ?? reserveForgewingProviderCall)(dependencies.admin as never, {
    organizationId: query.organizationId, requestDigestSha256, reservedBy: query.requestedBy,
    dailyCap: eligibility.dailyCap, workflow: 'case_investigation',
  });
  if (reservation.status === 'budget_exhausted') return { status: 'budget_exhausted' };
  if (reservation.status !== 'reserved') return { status: 'reservation_failed' };

  let raw: string;
  try {
    raw = await provider.investigate({
      system: CASE_INVESTIGATION_SYSTEM_PROMPT,
      context: providerRequestContext(transmitted),
      offeredActionKinds: offered,
    });
  } catch {
    return { status: 'provider_failed' };
  }
  let parsed: z.infer<typeof OutputSchema>;
  try {
    parsed = OutputSchema.parse(JSON.parse(raw));
  } catch {
    return { status: 'output_invalid' };
  }
  // A ranking may only name offered (rankable) actions the case lists, each once.
  const offeredSet = new Set<string>(offered);
  if (parsed.rankedActionKinds.some((kind) => !offeredSet.has(kind))
    || new Set(parsed.rankedActionKinds).size !== parsed.rankedActionKinds.length) {
    return { status: 'output_invalid' };
  }
  // Every citation must name a transmitted record, each once; it resolves to that slice and record.
  const byRef = new Map(citable.map((record) => [record.ref, record]));
  if (parsed.citations.some((ref) => !byRef.has(ref)) || new Set(parsed.citations).size !== parsed.citations.length) {
    return { status: 'output_invalid' };
  }
  const evidenceRefs = parsed.citations.map((ref) => ({ sliceKind: byRef.get(ref)!.sliceKind, recordId: byRef.get(ref)!.recordId }));
  // No invented numbers: every number (and identifier) in the answer appears in what was sent.
  if (unsupportedNumbers(`${parsed.diagnosis} ${parsed.rationale}`, transmitted).length > 0) {
    return { status: 'output_invalid' };
  }
  return {
    status: 'proposed',
    investigation: {
      authority: 'non_authoritative',
      diagnosis: parsed.diagnosis,
      rankedActionKinds: parsed.rankedActionKinds as ResolutionAction['kind'][],
      rationale: parsed.rationale,
      evidenceRefs,
      promptVersion: CASE_INVESTIGATION_PROMPT_VERSION,
      caseKind: read.resolutionCase.kind,
      findingCheckKey: read.resolutionCase.finding?.checkKey ?? null,
      ruleId: read.resolutionCase.finding?.ruleId ?? null,
      contextTransmittedDigest: read.context.transmittedDigest,
      reservationId: reservation.reservationId,
      providerModel: provider.providerModel,
      requestDigestSha256,
    },
  };
}

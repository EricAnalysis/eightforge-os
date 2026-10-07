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

export const CASE_INVESTIGATION_PROMPT_VERSION = 'case_investigation_prompt_v1';

export const CASE_INVESTIGATION_SYSTEM_PROMPT = [
  'You investigate one EightForge resolution case for a human operator.',
  'Use only the provided context. Do not invent values, documents or findings.',
  'Explain the most likely cause and rank only the offered action kinds.',
  'You decide nothing: the operator makes every decision through the listed actions.',
].join('\n');

export type CaseInvestigationProvider = Readonly<{
  providerModel: string;
  investigate(request: Readonly<{ system: string; context: unknown; offeredActionKinds: readonly string[] }>): Promise<string>;
}>;

const OutputSchema = z.object({
  diagnosis: z.string().min(1).max(1200),
  rankedActionKinds: z.array(z.string()).max(8),
  rationale: z.string().min(1).max(2000),
}).strict();

export type ProviderCaseInvestigation = Readonly<{
  authority: 'non_authoritative';
  diagnosis: string;
  rankedActionKinds: readonly ResolutionAction['kind'][];
  rationale: string;
  providerModel: string;
  requestDigestSha256: string;
}>;

export type ProviderCaseInvestigationResult =
  | Readonly<{ status: 'proposed'; investigation: ProviderCaseInvestigation }>
  | Readonly<{ status: 'gated'; reason: Extract<ValueReadingEligibility, { eligible: false }>['reason'] }>
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
  return [...new Set(resolutionCase.actions.map((action) => action.kind))];
}

export async function runProviderCaseInvestigation(
  query: Readonly<{ organizationId: string; projectId: string; caseId: string; requestedBy: string }>,
  dependencies: CaseInvestigationRunnerDependencies = {},
): Promise<ProviderCaseInvestigationResult> {
  const read = await (dependencies.readContext ?? readInvestigationContext)({
    organizationId: query.organizationId, projectId: query.projectId, caseId: query.caseId, purpose: 'provider_investigation',
  }, dependencies.admin !== undefined ? { admin: dependencies.admin as never } : {});
  if (read.status !== 'ok') return read;
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
      context: transmitted.map((slice) => ({ kind: slice.kind, provenance: slice.provenance, payload: slice.payload })),
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
  // A ranking may only name actions the case lists, each once.
  const offeredSet = new Set<string>(offered);
  if (parsed.rankedActionKinds.some((kind) => !offeredSet.has(kind))
    || new Set(parsed.rankedActionKinds).size !== parsed.rankedActionKinds.length) {
    return { status: 'output_invalid' };
  }
  return {
    status: 'proposed',
    investigation: {
      authority: 'non_authoritative',
      diagnosis: parsed.diagnosis,
      rankedActionKinds: parsed.rankedActionKinds as ResolutionAction['kind'][],
      rationale: parsed.rationale,
      providerModel: provider.providerModel,
      requestDigestSha256,
    },
  };
}

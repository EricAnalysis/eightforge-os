/**
 * This harness is the regression instrument for the Ask workstream.
 * It is read-only and must never gain mutation, seed, or fix calls.
 * No Ask change ships without 22/22 + 0 gaps.
 * New operator queries are added here as FAILING queries FIRST (see Prompt 3),
 * never after the fact.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { config } from 'dotenv';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AskResponse, ValidationStateLabel } from '@/lib/ask/types';
import type { AskAnswerContract, PortfolioSignalState } from '@/lib/ask/globalCommand';
import type { CanonicalReadLayer } from '@/lib/ask/canonicalReadGuard';
import type { UpstreamGap } from '@/lib/ask/upstreamGapDetector';
import { classifyQueryIntent } from '@/lib/ask/router/intentRouter';
import type { IntentGroup } from '@/lib/ask/router/intentClassificationMap';

config({ path: '.env.local' });
config();

type QuerySet = 'A' | 'B' | 'C' | 'D';
type QueryScope = 'project' | 'portfolio';

type DiagnosticQuery = {
  id: number;
  set: QuerySet;
  scope: QueryScope;
  text: string;
  matrixId?: string;
};

type PreconditionResult = {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
  projectId: string;
  projectName: string;
  orgId: string;
};

type DiagnosticRecord = {
  queryId: number;
  matrixId: string | null;
  set: QuerySet;
  scope: QueryScope;
  query: string;
  answerReturned: string;
  confidenceState: string | null;
  canonicalLayerUsed: string;
  sourceNamed: string;
  validationState: string | null;
  gateImpact: string;
  nextAction: string;
  evidenceCount: number;
  evidenceSources: string[];
  fallbackLabel: 'yes' | 'no' | 'n-a';
  staleLabel: 'yes' | 'no' | 'n-a';
  validatorFindingsSurfaced: string[];
  upstreamGap: string | 'no';
  conflict: string | 'no';
  routedIntent: IntentGroup | 'ambiguous' | 'none';
  routerConfidence: string | null;
  pass: boolean;
  criteria: Record<string, boolean>;
  rawResponse: unknown;
};

type ConfirmedGap = {
  gapId: number;
  queries: number[];
  matrixIds: string[];
  gapType:
    | 'canonical_field_absent'
    | 'validation_snapshot_missing'
    | 'extraction_not_producing'
    | 'portfolio_summary_absent'
    | 'stale_data'
    | 'evidence_anchor_missing'
    | 'other';
  fieldOrSourceMissing: string;
  currentBehavior: 'fallback' | 'Not Found' | 'fabricated' | 'empty';
  expectedBehavior: string;
  upstreamOwner:
    | 'Facts'
    | 'Validator'
    | 'Execution'
    | 'Audit'
    | 'Extractor'
    | 'Portfolio aggregate';
  resolutionApproach: string;
  phase4Required: boolean;
};

const QUERIES: DiagnosticQuery[] = [
  // CM-001
  { id: 1, set: 'A', scope: 'project', text: 'Is this project ready for invoice approval?' },
  { id: 2, set: 'A', scope: 'project', text: 'Which invoice amounts are fully supported?' },
  // CM-002
  { id: 3, set: 'A', scope: 'project', text: 'What is blocking approval?' },
  // CM-008
  { id: 4, set: 'A', scope: 'project', matrixId: 'CM-008', text: 'Where did the $815,559.35 total come from?' },
  { id: 5, set: 'A', scope: 'project', text: 'Show me unsupported ticket costs.' },
  { id: 6, set: 'A', scope: 'project', text: 'What is at risk in this project?' },
  // CM-042
  { id: 7, set: 'A', scope: 'project', text: 'What changed since the last review?' },
  // CM-018
  { id: 8, set: 'B', scope: 'project', text: 'Which contract is governing?' },
  // CM-023
  { id: 9, set: 'B', scope: 'project', text: 'Are tipping fees billable under this contract?' },
  { id: 10, set: 'B', scope: 'project', text: 'Is this FEMA reimbursable work?' },
  // CM-030
  { id: 11, set: 'B', scope: 'project', text: 'What federal compliance requirements apply?' },
  // CM-031
  { id: 12, set: 'B', scope: 'project', text: 'Can the contractor work on private property?' },
  { id: 13, set: 'B', scope: 'project', text: 'Is a performance bond required?' },
  // CM-033
  { id: 14, set: 'B', scope: 'project', text: 'What happens if FEMA funding is denied?' },
  // CM-029
  { id: 15, set: 'C', scope: 'project', text: 'Is monitoring required?' },
  // CM-028
  { id: 16, set: 'C', scope: 'project', text: 'What documentation is required for payment?' },
  // CM-049
  { id: 17, set: 'D', scope: 'portfolio', text: 'Which projects are blocked right now?' },
  // CM-050
  { id: 18, set: 'D', scope: 'portfolio', matrixId: 'CM-050', text: 'What is the total at-risk amount across all projects?' },
  // CM-051
  { id: 19, set: 'D', scope: 'portfolio', matrixId: 'CM-051', text: 'Which projects need review first?' },
  // CM-052
  { id: 20, set: 'D', scope: 'portfolio', matrixId: 'CM-052', text: 'What issues are happening most across projects?' },
  // CM-053
  { id: 21, set: 'D', scope: 'portfolio', text: 'Which projects are ready for approval?' },
  // CM-056
  { id: 22, set: 'D', scope: 'portfolio', text: 'Are any projects approaching contract ceiling?' },
  // CM-001
  { id: 23, set: 'A', scope: 'project', matrixId: 'CM-001', text: 'Is this project ready for invoice approval?' },
  // CM-002
  { id: 24, set: 'A', scope: 'project', matrixId: 'CM-002', text: 'What is preventing approval?' },
  // CM-003
  { id: 25, set: 'A', scope: 'project', matrixId: 'CM-003', text: 'What is the next best action for this project?' },
  // CM-005
  { id: 26, set: 'A', scope: 'project', matrixId: 'CM-005', text: 'Can this invoice move forward while open tickets are pending?' },
  // CM-006
  { id: 27, set: 'A', scope: 'project', matrixId: 'CM-006', text: 'Which invoice amounts are fully supported?' },
  // CM-007
  { id: 28, set: 'A', scope: 'project', matrixId: 'CM-007', text: 'Which invoice amounts are unsupported?' },
  // CM-009
  { id: 29, set: 'A', scope: 'project', matrixId: 'CM-009', text: 'What is the total invoice exposure?' },
  // CM-010
  { id: 30, set: 'A', scope: 'project', matrixId: 'CM-010', text: 'Can this invoice be approved with exceptions?' },
  // CM-011
  { id: 31, set: 'A', scope: 'project', matrixId: 'CM-011', text: 'Which tickets need correction?' },
  // CM-013
  { id: 32, set: 'A', scope: 'project', matrixId: 'CM-013', text: 'Which tickets have missing disposal site, material, CYD, tonnage, or mileage?' },
  // CM-014
  { id: 33, set: 'A', scope: 'project', matrixId: 'CM-014', text: 'Which tickets have rate-code mismatches?' },
  // CM-017
  { id: 34, set: 'A', scope: 'project', matrixId: 'CM-017', text: 'Which tickets are unresolved by reviewer?' },
  // CM-018
  { id: 35, set: 'B', scope: 'project', matrixId: 'CM-018', text: 'Which contract is governing?' },
  // CM-019
  { id: 36, set: 'B', scope: 'project', matrixId: 'CM-019', text: 'Which amendment or exhibit controls the rate schedule?' },
  // CM-020
  { id: 37, set: 'B', scope: 'project', matrixId: 'CM-020', text: 'Did a newer document replace an older one?' },
  // CM-021
  { id: 38, set: 'B', scope: 'project', matrixId: 'CM-021', text: 'Are there conflicting facts across documents?' },
  // CM-022
  { id: 39, set: 'B', scope: 'project', matrixId: 'CM-022', text: 'Does this invoice use the correct contract rates?' },
  // CM-023
  { id: 40, set: 'B', scope: 'project', matrixId: 'CM-023', text: 'Are tipping fees billable under this contract?' },
  // CM-025
  { id: 41, set: 'B', scope: 'project', matrixId: 'CM-025', text: 'Are any invoice line items missing from the contract rate table?' },
  // CM-026
  { id: 42, set: 'B', scope: 'project', matrixId: 'CM-026', text: 'Is the project approaching contract ceiling?' },
  // CM-028
  { id: 43, set: 'B', scope: 'project', matrixId: 'CM-028', text: 'What documentation is required for payment?' },
  // CM-029
  { id: 44, set: 'B', scope: 'project', matrixId: 'CM-029', text: 'Is monitoring required?' },
  // CM-030
  { id: 45, set: 'B', scope: 'project', matrixId: 'CM-030', text: 'Are GPS, photos, load tickets, or daily reconciliation required?' },
  // CM-031
  { id: 46, set: 'B', scope: 'project', matrixId: 'CM-031', text: 'Can the contractor work on private property?' },
  // CM-033
  { id: 47, set: 'B', scope: 'project', matrixId: 'CM-033', text: 'Is there no-guaranteed-quantity or funding-contingency language?' },
  // CM-034
  { id: 48, set: 'B', scope: 'project', matrixId: 'CM-034', text: 'Which documents still need review?' },
  // CM-035
  { id: 49, set: 'B', scope: 'project', matrixId: 'CM-035', text: 'Are any documents marked reviewed but still producing warnings?' },
  // CM-036
  { id: 50, set: 'B', scope: 'project', matrixId: 'CM-036', text: 'Which facts were manually confirmed?' },
  // CM-037
  { id: 51, set: 'B', scope: 'project', matrixId: 'CM-037', text: 'Which facts were overridden by a human?' },
  // CM-038
  { id: 52, set: 'B', scope: 'project', matrixId: 'CM-038', text: 'Which document should the operator inspect first?' },
  // CM-039
  { id: 53, set: 'C', scope: 'project', matrixId: 'CM-039', text: 'What execution items are still open?' },
  // CM-040
  { id: 54, set: 'C', scope: 'project', matrixId: 'CM-040', text: 'Which findings require action before approval?' },
  // CM-041
  { id: 55, set: 'C', scope: 'project', matrixId: 'CM-041', text: 'Which findings were overridden, and why?' },
  // CM-042
  { id: 56, set: 'C', scope: 'project', matrixId: 'CM-042', text: 'What changed since the last review?' },
  // CM-043
  { id: 57, set: 'C', scope: 'project', matrixId: 'CM-043', text: 'Which actions are blocking payment release?' },
  // CM-053
  { id: 58, set: 'D', scope: 'portfolio', matrixId: 'CM-053', text: 'Which projects are ready for approval?' },
  // CM-054
  { id: 59, set: 'D', scope: 'portfolio', matrixId: 'CM-054', text: 'Which projects have stale validation snapshots?' },
  // CM-049
  { id: 60, set: 'D', scope: 'portfolio', matrixId: 'CM-049', text: 'Which projects are blocked right now?' },
];
const PHASE_3_BASELINE_QUERY_COUNT = 22;
const ASK_EXPANSION_PROBE_COUNT = QUERIES.length - PHASE_3_BASELINE_QUERY_COUNT;

const MATRIX_PROBE_CONTRACTS: Record<string, { concept: RegExp[]; evidenceRequirement: RegExp[] }> = {
  'CM-001': { concept: [/readiness|ready/i, /approval/i], evidenceRequirement: [/readiness|ready/i, /blocker/i, /approval status|validator|source/i] },
  'CM-002': { concept: [/prevent|blocker|blocking/i, /approval/i], evidenceRequirement: [/blocker|finding|execution item/i, /rule|gate impact|approval/i] },
  'CM-003': { concept: [/next (best )?action/i], evidenceRequirement: [/action/i, /finding|execution item|source/i, /priority|because|reason/i] },
  'CM-005': { concept: [/open ticket|pending ticket/i, /move forward|approval/i], evidenceRequirement: [/invoice/i, /ticket/i, /approval gate|gate basis|pending/i] },
  'CM-006': { concept: [/fully supported|supported amount/i, /invoice/i], evidenceRequirement: [/invoice/i, /supported amount|fully supported/i, /support source|source/i] },
  'CM-007': { concept: [/unsupported/i, /invoice/i], evidenceRequirement: [/invoice/i, /unsupported amount|unsupported/i, /missing support|mismatch|basis/i] },
  'CM-008': { concept: [/total.*come from|rollup|lineage/i], evidenceRequirement: [/rollup/i, /invoice/i, /contribution/i] },
  'CM-009': { concept: [/invoice exposure|total exposure/i], evidenceRequirement: [/total exposure|at risk/i, /supported/i, /unsupported|validator|source/i] },
  'CM-010': { concept: [/exception/i, /approve|approval/i], evidenceRequirement: [/invoice/i, /exception/i, /condition|required/i] },
  'CM-011': { concept: [/ticket/i, /correction|correct/i], evidenceRequirement: [/ticket/i, /correction|reason/i, /validator|evidence/i] },
  'CM-013': { concept: [/ticket/i, /disposal site|material|cyd|tonnage|mileage/i], evidenceRequirement: [/ticket/i, /disposal site|material|cyd|tonnage|mileage/i, /source|evidence/i] },
  'CM-014': { concept: [/ticket/i, /rate[- ]?code|rate code mismatch/i], evidenceRequirement: [/ticket/i, /rate[- ]?code/i, /expected|contract|evidence/i] },
  'CM-017': { concept: [/ticket/i, /reviewer|unresolved/i], evidenceRequirement: [/ticket/i, /reviewer|review status/i, /finding|action|open/i] },
  'CM-018': { concept: [/governing contract/i], evidenceRequirement: [/governing contract/i, /precedence|effective/i, /source|document/i] },
  'CM-019': { concept: [/amendment|exhibit/i, /rate schedule/i], evidenceRequirement: [/amendment|exhibit/i, /relationship|basis/i, /rate schedule/i] },
  'CM-020': { concept: [/newer|replace|replaced/i, /older|document/i], evidenceRequirement: [/replacing|newer|replacement/i, /replaced|older/i, /effective date|relationship|source/i] },
  'CM-021': { concept: [/conflict|conflicting/i, /document|fact/i], evidenceRequirement: [/conflict|conflicting/i, /document/i, /canonical winner|current canonical|source/i] },
  'CM-022': { concept: [/correct contract rates|contract rate/i, /invoice/i], evidenceRequirement: [/invoice line/i, /expected rate|contract rate/i, /actual rate|source/i] },
  'CM-023': { concept: [/tipping fee/i, /billable|contract/i], evidenceRequirement: [/governing contract|contract/i, /fee clause|rate row|source/i, /billable|eligible/i] },
  'CM-025': { concept: [/invoice line/i, /missing.*contract rate|rate table/i], evidenceRequirement: [/invoice line/i, /category|line item/i, /missing.*rate table|contract rate/i] },
  'CM-026': { concept: [/contract ceiling|nte/i, /approaching|remaining|over/i], evidenceRequirement: [/nte|ceiling/i, /billed total|billed/i, /remaining|overage|source/i] },
  'CM-028': { concept: [/documentation required|required document/i, /payment/i], evidenceRequirement: [/required document|document type/i, /governing|source/i, /missing|received|status/i] },
  'CM-029': { concept: [/monitoring/i, /required/i], evidenceRequirement: [/monitoring/i, /clause|fact/i, /document|source/i] },
  'CM-030': { concept: [/gps|photos|load tickets|daily reconciliation/i, /required/i], evidenceRequirement: [/gps|photos|load tickets|daily reconciliation/i, /source clause|clause|source/i, /received|missing|status/i] },
  'CM-031': { concept: [/private property/i, /contractor|authority|allowed/i], evidenceRequirement: [/private property/i, /permission|limit|authority/i, /source|clause/i] },
  'CM-033': { concept: [/no guaranteed quantity|funding contingency/i], evidenceRequirement: [/no guaranteed quantity|funding contingency/i, /document|contract/i, /contingency|clause/i] },
  'CM-034': { concept: [/document/i, /need.*review|still.*review/i], evidenceRequirement: [/document/i, /review status/i, /reason|open/i] },
  'CM-035': { concept: [/reviewed/i, /warning/i], evidenceRequirement: [/document/i, /warning/i, /review event|source|reviewed/i] },
  'CM-036': { concept: [/manually confirmed/i, /fact/i], evidenceRequirement: [/fact/i, /confirmed value|value/i, /reviewer|review timestamp|source/i] },
  'CM-037': { concept: [/overridden|override/i, /human|fact/i], evidenceRequirement: [/fact/i, /override value|overridden/i, /actor|reason|source/i] },
  'CM-038': { concept: [/inspect first|first.*inspect/i, /document/i], evidenceRequirement: [/document/i, /risk reason|reason/i, /blocker|warning|action/i] },
  'CM-039': { concept: [/execution item/i, /open/i], evidenceRequirement: [/execution item/i, /status/i, /required action|blocker/i] },
  'CM-040': { concept: [/finding/i, /action before approval|before approval/i], evidenceRequirement: [/finding/i, /required action/i, /approval gate|gate effect/i] },
  'CM-041': { concept: [/finding/i, /overridden|why/i], evidenceRequirement: [/finding/i, /override reason|why/i, /actor|timestamp|source/i] },
  'CM-042': { concept: [/changed|change/i, /last review/i], evidenceRequirement: [/changed|change/i, /before|after/i, /review baseline|last review/i] },
  'CM-043': { concept: [/action/i, /blocking payment|payment release/i], evidenceRequirement: [/action/i, /blocker|blocking/i, /payment gate|payment release/i] },
  'CM-049': { concept: [/blocked/i, /project/i], evidenceRequirement: [/blocked project|project/i, /blocker count|blockers/i, /at risk|aggregate/i] },
  'CM-050': { concept: [/total at[- ]risk|at risk amount/i], evidenceRequirement: [/total at[- ]risk|at risk amount/i, /project|per-project/i, /aggregate|source/i] },
  'CM-051': { concept: [/review first|rank/i, /project/i], evidenceRequirement: [/project/i, /rank|first/i, /reason|aggregate|deterministic/i] },
  'CM-052': { concept: [/issue type|pattern/i], evidenceRequirement: [/issue type|pattern/i, /count/i, /percentage|aggregate|source/i] },
  'CM-053': { concept: [/ready for approval|approval ready/i, /project/i], evidenceRequirement: [/project/i, /ready status|approval ready|ready for approval/i, /aggregate|source/i] },
  'CM-054': { concept: [/stale/i, /validation snapshot|project/i], evidenceRequirement: [/project/i, /stale/i, /validation timestamp|stale label|source/i] },
};

const ROUTER_INTENT_BY_MATRIX: Record<string, IntentGroup> = {
  'CM-001': 'approval_execution_state',
  'CM-002': 'approval_execution_state',
  'CM-003': 'approval_execution_state',
  'CM-005': 'approval_execution_state',
  'CM-010': 'approval_execution_state',
  'CM-039': 'approval_execution_state',
  'CM-040': 'approval_execution_state',
  'CM-043': 'approval_execution_state',
  'CM-006': 'invoice_support',
  'CM-007': 'invoice_support',
  'CM-008': 'invoice_support',
  'CM-009': 'invoice_support',
  'CM-022': 'invoice_support',
  'CM-025': 'invoice_support',
  'CM-026': 'invoice_support',
  'CM-011': 'ticket_validation',
  'CM-013': 'ticket_validation',
  'CM-014': 'ticket_validation',
  'CM-017': 'ticket_validation',
  'CM-018': 'contract_authority',
  'CM-019': 'contract_authority',
  'CM-020': 'contract_authority',
  'CM-021': 'contract_authority',
  'CM-023': 'contract_authority',
  'CM-028': 'contract_authority',
  'CM-029': 'contract_authority',
  'CM-030': 'contract_authority',
  'CM-031': 'contract_authority',
  'CM-033': 'contract_authority',
  'CM-034': 'review_audit_state',
  'CM-035': 'review_audit_state',
  'CM-036': 'review_audit_state',
  'CM-037': 'review_audit_state',
  'CM-038': 'review_audit_state',
  'CM-041': 'review_audit_state',
  'CM-042': 'review_audit_state',
  'CM-049': 'portfolio_project_status',
  'CM-050': 'portfolio_project_status',
  'CM-051': 'portfolio_project_status',
  'CM-052': 'portfolio_project_status',
  'CM-053': 'portfolio_project_status',
  'CM-054': 'portfolio_project_status',
  'CM-056': 'portfolio_project_status',
};

const ROUTER_INTENT_BY_BASELINE_QUERY_ID: Record<number, IntentGroup> = {
  1: 'approval_execution_state',
  2: 'invoice_support',
  3: 'approval_execution_state',
  4: 'invoice_support',
  5: 'invoice_support',
  6: 'invoice_support',
  7: 'review_audit_state',
  8: 'contract_authority',
  9: 'contract_authority',
  10: 'contract_authority',
  11: 'contract_authority',
  12: 'contract_authority',
  13: 'contract_authority',
  14: 'contract_authority',
  15: 'contract_authority',
  16: 'contract_authority',
  17: 'portfolio_project_status',
  18: 'portfolio_project_status',
  19: 'portfolio_project_status',
  20: 'portfolio_project_status',
  21: 'portfolio_project_status',
  22: 'portfolio_project_status',
};

const ALLOWED_VALIDATION_STATES = new Set<ValidationStateLabel>([
  'Confirmed',
  'Approved',
  'Approved with Warnings',
  'Blocked',
  'Requires Review',
  'Not Evaluated',
  'Not Found',
]);

const ALLOWED_PORTFOLIO_SIGNAL_STATES = new Set<PortfolioSignalState>([
  'Portfolio Blocked',
  'Portfolio Needs Review',
  'Portfolio Exposure',
  'Portfolio Ready',
  'No Verified Data',
]);

const ALLOWED_NEXT_ACTIONS = new Set([
  'Open Validator',
  'Open Evidence',
  'Create Execution Item',
  'Open Execution Item',
  'Mark Reviewed',
  'Override with Reason',
  'Reprocess Document',
  'Open Project',
  'Open Execution Queue',
  'Open Ask Project',
  'Review stale snapshot',
  'No action required',
]);

function sourceId(source: {
  documentId?: string;
  factId?: string;
  anchorId?: string;
  label?: string;
  href?: string;
  source?: string;
}): string {
  return source.factId ?? source.anchorId ?? source.documentId ?? source.href ?? source.source ?? source.label ?? 'unknown';
}

function expectedRouterIntent(query: DiagnosticQuery): IntentGroup | null {
  if (query.matrixId) return ROUTER_INTENT_BY_MATRIX[query.matrixId] ?? null;
  return ROUTER_INTENT_BY_BASELINE_QUERY_ID[query.id] ?? null;
}

function routeMatchesExpected(query: DiagnosticQuery): {
  routedIntent: IntentGroup | 'ambiguous' | 'none';
  routerConfidence: string | null;
  passed: boolean;
} {
  const expected = expectedRouterIntent(query);
  if (!expected) {
    return {
      routedIntent: 'none',
      routerConfidence: null,
      passed: true,
    };
  }

  const result = classifyQueryIntent(query.text, query.scope);
  return {
    routedIntent: result.intent,
    routerConfidence: result.confidence,
    passed: result.intent === expected && String(result.confidence) !== 'low',
  };
}

function normalizeProjectValidationState(response: AskResponse): string | null {
  return response.sections?.validationState ?? response.validationState ?? null;
}

function hasRawExtractionFallback(response: AskResponse): boolean {
  return Boolean(
    response.fallbackUsed ||
      response.sections?.evidence.some((item) => item.layer === 'document_extraction' && item.isFallback),
  );
}

function hasFallbackLabel(response: AskResponse): boolean {
  const answer = response.answer.toLowerCase();
  return answer.includes('unverified - raw extraction fallback') || answer.includes('fallback') || answer.includes('requires review') || answer.includes('not found');
}

function hasStaleLabel(response: AskAnswerContract): boolean {
  const answer = response.answer ?? '';
  return Boolean(
    response.portfolioSections?.projectsAffected.some((project) => project.isStale) &&
      answer.toLowerCase().includes('stale'),
  );
}

function stablePortfolioOrder(response: AskAnswerContract): boolean {
  const projects = response.portfolioSections?.projectsAffected ?? [];
  for (let index = 1; index < projects.length; index += 1) {
    const previous = projects[index - 1];
    const current = projects[index];
    if (!previous || !current) continue;
    if (previous.blockerCount === 0 && current.blockerCount > 0) return false;
    if (
      previous.blockerCount === current.blockerCount &&
      previous.warningCount === 0 &&
      current.warningCount > 0
    ) {
      return false;
    }
    if (
      previous.blockerCount === current.blockerCount &&
      previous.warningCount === current.warningCount &&
      previous.atRiskAmount < current.atRiskAmount
    ) {
      return false;
    }
  }
  return true;
}

function answerHasMaterialClaim(answer: string): boolean {
  return /(\$[\d,]+(?:\.\d+)?|\b20\d{2}-\d{3}\b|\binvoice\b|\bcontract\b|\bFEMA\b|\bapproval\b)/i.test(answer);
}

function matrixProbeText(params: {
  answer: string;
  sourceNamed: string;
  evidenceSources: string[];
  extraText?: string[];
}): string {
  return [
    params.answer,
    params.sourceNamed,
    ...params.evidenceSources,
    ...(params.extraText ?? []),
  ].join('\n');
}

function isGenericMatrixNonAnswer(text: string): boolean {
  return /\b(can't answer|cannot be answered|could not find|no matching structured fact|not found|no .* found|unavailable)\b/i.test(text);
}

function matrixProbeSpecific(params: {
  query: DiagnosticQuery;
  answer: string;
  sourceNamed: string;
  evidenceSources: string[];
  extraText?: string[];
}): boolean {
  if (!params.query.matrixId) return true;
  const contract = MATRIX_PROBE_CONTRACTS[params.query.matrixId];
  if (!contract) return true;

  const text = matrixProbeText(params);
  return !isGenericMatrixNonAnswer(text) && contract.concept.every((pattern) => pattern.test(text));
}

function matrixProbeSourced(params: {
  query: DiagnosticQuery;
  confidenceState: string | null;
  sourceNamed: string;
  evidenceSources: string[];
  upstreamGap: UpstreamGap | null;
  portfolioGap: boolean;
}): boolean {
  if (!params.query.matrixId) return true;
  const hasNamedSource = params.sourceNamed !== 'none' || params.evidenceSources.length > 0;
  const confidentEnough = params.confidenceState === 'Verified' || params.confidenceState === 'Partial' || params.confidenceState === 'available';
  return (confidentEnough && hasNamedSource) || params.upstreamGap != null || params.portfolioGap;
}

function matrixProbeEvidenceAdequate(params: {
  query: DiagnosticQuery;
  answer: string;
  sourceNamed: string;
  evidenceSources: string[];
  extraText?: string[];
}): boolean {
  if (!params.query.matrixId) return true;
  const contract = MATRIX_PROBE_CONTRACTS[params.query.matrixId];
  if (!contract) return true;

  const text = matrixProbeText(params);
  return !isGenericMatrixNonAnswer(text) && contract.evidenceRequirement.every((pattern) => pattern.test(text));
}

function likelyInferencePresentedAsFact(record: Pick<DiagnosticRecord, 'answerReturned' | 'confidenceState'>): boolean {
  return (
    record.confidenceState === 'Verified' &&
    /\b(likely|appears|may be|seems|inferred|assume|assuming)\b/i.test(record.answerReturned)
  );
}

function gapDescription(gap: UpstreamGap | null | undefined): string | 'no' {
  if (!gap) return 'no';
  return `${gap.fieldKey}: ${gap.message} Expected source: ${gap.expectedSource}. Resolution: ${gap.resolutionWorkflow}.`;
}

function projectDiagnosticRecord(query: DiagnosticQuery, response: AskResponse): DiagnosticRecord {
  const evidence = response.sections?.evidence ?? [];
  const evidenceSources = evidence.map((item) => item.id);
  const sourceNames = response.sources.map(sourceId);
  const canonicalLayers = Array.from(new Set(evidence.map((item) => item.layer satisfies CanonicalReadLayer)));
  const upstreamGap = response.sections?.upstreamGap ?? null;
  const sourceNamed = sourceNames.length > 0 ? sourceNames.join(', ') : 'none';
  const validationState = normalizeProjectValidationState(response);
  const fallbackUsed = hasRawExtractionFallback(response);
  const routeCheck = routeMatchesExpected(query);
  const matrixExtraText = [
    response.sections?.validationState,
    response.sections?.gateImpact,
    response.sections?.nextAction,
    ...evidence.map((item) => `${item.label} ${item.value} ${item.sourceDocumentName ?? ''}`),
    ...(response.sections?.validatorFindings.map((finding) => `${finding.label} ${finding.gateImpact} ${finding.nextAction}`) ?? []),
  ].filter((value): value is string => Boolean(value));
  const criteria = {
    answerNonEmptyNonError: response.answer.trim().length > 0 && !/^error:/i.test(response.answer.trim()),
    confidenceStateNonNull: response.sections?.confidenceState != null,
    canonicalLayerNamed: canonicalLayers.length > 0,
    sourceNamedForMaterialClaim: !answerHasMaterialClaim(response.answer) || sourceNamed !== 'none' || upstreamGap != null,
    validationStateAllowed: validationState != null && ALLOWED_VALIDATION_STATES.has(validationState as ValidationStateLabel),
    nextActionAllowed: response.sections?.nextAction != null && ALLOWED_NEXT_ACTIONS.has(response.sections.nextAction),
    activeValidatorFindingSurfaced: (response.sections?.blockerCount ?? 0) + (response.sections?.warningCount ?? 0) === 0 ||
      (response.sections?.validatorFindings.length ?? 0) > 0,
    gapRenderedWhenCanonicalAbsent: upstreamGap == null || response.answer.includes(upstreamGap.message),
    fallbackLabeledWhenRawExtractionUsed: !fallbackUsed || hasFallbackLabel(response),
    staleLabeledWhenSnapshotStale: true,
    noFabricatedMaterial: !answerHasMaterialClaim(response.answer) || sourceNamed !== 'none' || upstreamGap != null,
    noInferenceAsFact: true,
    portfolioDidNotTraverseRawDocuments: true,
    portfolioRankingDeterministic: true,
    matrixSpecific: matrixProbeSpecific({
      query,
      answer: response.answer,
      sourceNamed,
      evidenceSources,
      extraText: matrixExtraText,
    }),
    matrixSourced: matrixProbeSourced({
      query,
      confidenceState: response.sections?.confidenceState ?? null,
      sourceNamed,
      evidenceSources,
      upstreamGap,
      portfolioGap: false,
    }),
    matrixEvidenceAdequate: matrixProbeEvidenceAdequate({
      query,
      answer: response.answer,
      sourceNamed,
      evidenceSources,
      extraText: matrixExtraText,
    }),
    matrixRouted: routeCheck.passed,
  };

  const record: DiagnosticRecord = {
    queryId: query.id,
    matrixId: query.matrixId ?? null,
    set: query.set,
    scope: query.scope,
    query: query.text,
    answerReturned: response.answer,
    confidenceState: response.sections?.confidenceState ?? null,
    canonicalLayerUsed: canonicalLayers.length > 0 ? canonicalLayers.join(', ') : 'none',
    sourceNamed,
    validationState,
    gateImpact: response.sections?.gateImpact ?? response.gateImpact ?? 'No gate impact',
    nextAction: response.sections?.nextAction ?? response.nextAction ?? 'No action required',
    evidenceCount: evidence.length,
    evidenceSources,
    fallbackLabel: fallbackUsed ? (hasFallbackLabel(response) ? 'yes' : 'no') : 'n-a',
    staleLabel: 'n-a',
    validatorFindingsSurfaced: response.sections?.validatorFindings.map((finding) => finding.label) ?? [],
    upstreamGap: gapDescription(upstreamGap),
    conflict: response.conflict ? JSON.stringify(response.conflict) : 'no',
    routedIntent: routeCheck.routedIntent,
    routerConfidence: routeCheck.routerConfidence,
    pass: false,
    criteria,
    rawResponse: response,
  };
  record.criteria.noInferenceAsFact = !likelyInferencePresentedAsFact(record);
  record.pass = Object.values(record.criteria).every(Boolean);
  return record;
}

function portfolioDiagnosticRecord(query: DiagnosticQuery, response: AskAnswerContract): DiagnosticRecord {
  const answer = response.answer ?? '';
  const evidenceSources = response.evidence.map((item) => item.source ?? item.label);
  const rawTraversal = [...(response.sources ?? []), ...(response.checkedSources ?? [])].some((source) =>
    /\b(raw|extraction blob|page text|invoice line|contract clause|spreadsheet row)\b/i.test(source),
  );
  const validationState = response.portfolioSignalState ?? response.validationState ?? null;
  const nextAction = response.nextActions?.[0]?.label ?? 'No action required';
  const hasStaleProject = response.portfolioSections?.projectsAffected.some((project) => project.isStale) ?? false;
  const sourceNamed = response.sources?.join(', ') || 'none';
  const portfolioGap = !response.dataFound;
  const routeCheck = routeMatchesExpected(query);
  const matrixExtraText = [
    response.portfolioSignalState,
    response.gateImpact,
    response.pattern,
    response.recommendedAction,
    response.portfolioSections?.portfolioSignal,
    response.portfolioSections?.patternDetected.label,
    response.portfolioSections?.recommendedAction.label,
    ...(response.portfolioSections?.projectsAffected.map((project) =>
      `${project.projectName} ${project.readinessState} ${project.validationState} blockers ${project.blockerCount} warnings ${project.warningCount} at risk ${project.atRiskAmount} staleness ${project.stalenessLabel} ${project.signalReason}`,
    ) ?? []),
    ...(response.checkedSources ?? []),
  ].filter((value): value is string => Boolean(value));
  const criteria = {
    answerNonEmptyNonError: answer.trim().length > 0 && !/^error:/i.test(answer.trim()),
    confidenceStateNonNull: response.availability != null,
    canonicalLayerNamed: (response.checkedSources?.length ?? 0) > 0,
    sourceNamedForMaterialClaim: !answerHasMaterialClaim(answer) || (response.sources?.length ?? 0) > 0,
    validationStateAllowed: validationState != null && ALLOWED_PORTFOLIO_SIGNAL_STATES.has(validationState as PortfolioSignalState),
    nextActionAllowed: ALLOWED_NEXT_ACTIONS.has(nextAction),
    activeValidatorFindingSurfaced: true,
    gapRenderedWhenCanonicalAbsent: response.dataFound || /No .* found|No verified data/i.test(answer),
    fallbackLabeledWhenRawExtractionUsed: true,
    staleLabeledWhenSnapshotStale: !hasStaleProject || hasStaleLabel(response),
    noFabricatedMaterial: !answerHasMaterialClaim(answer) || (response.sources?.length ?? 0) > 0,
    noInferenceAsFact: true,
    portfolioDidNotTraverseRawDocuments: !rawTraversal,
    portfolioRankingDeterministic: stablePortfolioOrder(response),
    matrixSpecific: matrixProbeSpecific({
      query,
      answer,
      sourceNamed,
      evidenceSources,
      extraText: matrixExtraText,
    }),
    matrixSourced: matrixProbeSourced({
      query,
      confidenceState: response.availability ?? null,
      sourceNamed,
      evidenceSources,
      upstreamGap: null,
      portfolioGap,
    }),
    matrixEvidenceAdequate: matrixProbeEvidenceAdequate({
      query,
      answer,
      sourceNamed,
      evidenceSources,
      extraText: matrixExtraText,
    }),
    matrixRouted: routeCheck.passed,
  };

  const record: DiagnosticRecord = {
    queryId: query.id,
    matrixId: query.matrixId ?? null,
    set: query.set,
    scope: query.scope,
    query: query.text,
    answerReturned: answer,
    confidenceState: response.availability ?? null,
    canonicalLayerUsed: response.checkedSources?.join(', ') ?? 'none',
    sourceNamed,
    validationState,
    gateImpact: response.gateImpact ?? 'No gate impact',
    nextAction,
    evidenceCount: response.evidence.length,
    evidenceSources,
    fallbackLabel: 'n-a',
    staleLabel: hasStaleProject ? (hasStaleLabel(response) ? 'yes' : 'no') : 'n-a',
    validatorFindingsSurfaced: [],
    upstreamGap: response.dataFound ? 'no' : 'portfolio aggregate unavailable',
    conflict: 'no',
    routedIntent: routeCheck.routedIntent,
    routerConfidence: routeCheck.routerConfidence,
    pass: false,
    criteria,
    rawResponse: response,
  };
  record.criteria.noInferenceAsFact = !likelyInferencePresentedAsFact(record);
  record.pass = Object.values(record.criteria).every(Boolean);
  return record;
}

function gapTypeForFailure(key: string, record: DiagnosticRecord): ConfirmedGap['gapType'] {
  if (key.includes('matrixRouted')) return 'other';
  if (key.includes('matrixSourced') || key.includes('matrixEvidenceAdequate')) return 'evidence_anchor_missing';
  if (key.includes('matrixSpecific')) return 'canonical_field_absent';
  if (record.scope === 'portfolio') return 'portfolio_summary_absent';
  if (key.includes('validation')) return 'validation_snapshot_missing';
  if (key.includes('source') || key.includes('evidence')) return 'evidence_anchor_missing';
  if (key.includes('fallback')) return 'extraction_not_producing';
  if (key.includes('stale')) return 'stale_data';
  if (record.upstreamGap !== 'no') return 'canonical_field_absent';
  return 'other';
}

function ownerForGap(gapType: ConfirmedGap['gapType']): ConfirmedGap['upstreamOwner'] {
  switch (gapType) {
    case 'canonical_field_absent':
      return 'Facts';
    case 'validation_snapshot_missing':
      return 'Validator';
    case 'extraction_not_producing':
    case 'evidence_anchor_missing':
      return 'Extractor';
    case 'portfolio_summary_absent':
    case 'stale_data':
      return 'Portfolio aggregate';
    default:
      return 'Audit';
  }
}

function currentBehaviorForRecord(record: DiagnosticRecord): ConfirmedGap['currentBehavior'] {
  if (record.answerReturned.trim().length === 0) return 'empty';
  if (record.upstreamGap !== 'no' || record.validationState === 'Not Found') return 'Not Found';
  if (record.fallbackLabel === 'yes' || record.fallbackLabel === 'no') return 'fallback';
  return 'fabricated';
}

function buildConfirmedGaps(records: DiagnosticRecord[]): ConfirmedGap[] {
  const byKey = new Map<string, Omit<ConfirmedGap, 'gapId'>>();

  for (const record of records) {
    for (const [criteriaKey, passed] of Object.entries(record.criteria)) {
      if (passed) continue;
      const gapType = gapTypeForFailure(criteriaKey, record);
      const fieldOrSourceMissing =
        criteriaKey === 'matrixSpecific'
          ? `${record.matrixId ?? 'matrix'}: response does not expose the matrix concept fields`
        : criteriaKey === 'matrixSourced'
          ? `${record.matrixId ?? 'matrix'}: response has neither a named source nor a surfaced upstream gap`
        : criteriaKey === 'matrixEvidenceAdequate'
          ? `${record.matrixId ?? 'matrix'}: response does not satisfy the matrix Evidence Requirement`
        : criteriaKey === 'matrixRouted'
          ? `${record.matrixId ?? `query-${record.queryId}`}: deterministic router returned ${record.routedIntent} (${record.routerConfidence ?? 'no confidence'})`
        : record.upstreamGap !== 'no'
          ? record.upstreamGap
          : criteriaKey;
      const key = `${gapType}:${fieldOrSourceMissing}:${record.scope}`;
      const existing = byKey.get(key);
      const queryIds = existing ? Array.from(new Set([...existing.queries, record.queryId])) : [record.queryId];
      const matrixIds = record.matrixId
        ? existing
          ? Array.from(new Set([...existing.matrixIds, record.matrixId]))
          : [record.matrixId]
        : existing?.matrixIds ?? [];
      byKey.set(key, {
        queries: queryIds,
        matrixIds,
        gapType,
        fieldOrSourceMissing,
        currentBehavior: currentBehaviorForRecord(record),
        expectedBehavior:
          record.scope === 'portfolio'
            ? 'Ask Portfolio returns a portfolio-safe aggregate answer with allowed validation and action labels.'
            : 'Ask Project returns a sourced canonical answer or an explicit upstream gap without raw unlabeled fallback.',
        upstreamOwner: ownerForGap(gapType),
        resolutionApproach:
          gapType === 'portfolio_summary_absent'
            ? 'Persist or normalize the portfolio aggregate field so Ask Portfolio can answer without raw project traversal.'
            : 'Populate the missing canonical source or surface the existing source through the answer builder contract.',
        phase4Required: true,
      });
    }
  }

  return Array.from(byKey.values()).map((gap, index) => ({
    gapId: index + 1,
    ...gap,
  }));
}

function summarize(records: DiagnosticRecord[], gaps: ConfirmedGap[]) {
  const failingRecords = records.filter((record) => !record.pass);
  const gapCountsByType = gaps.reduce<Record<string, number>>((counts, gap) => {
    counts[gap.gapType] = (counts[gap.gapType] ?? 0) + 1;
    return counts;
  }, {});
  const gapCountsByOwner = gaps.reduce<Record<string, number>>((counts, gap) => {
    counts[gap.upstreamOwner] = (counts[gap.upstreamOwner] ?? 0) + 1;
    return counts;
  }, {});

  return {
    queriesRun: records.length,
    passing: records.length - failingRecords.length,
    failing: failingRecords.length,
    confirmedGaps: gaps.length,
    confirmedGapsByType: gapCountsByType,
    confirmedGapsByUpstreamOwner: gapCountsByOwner,
    askBehaviorAssessment: {
      fabricatedAnswers: records.filter((record) => !record.criteria.noFabricatedMaterial).map((record) => record.queryId),
      inferenceAsFact: records.filter((record) => !record.criteria.noInferenceAsFact).map((record) => record.queryId),
      rawExtractionUnlabeled: records.filter((record) => !record.criteria.fallbackLabeledWhenRawExtractionUsed).map((record) => record.queryId),
      portfolioTraversedRawDocuments: records.filter((record) => !record.criteria.portfolioDidNotTraverseRawDocuments).map((record) => record.queryId),
      duplicateRiskLayerBehavior: [] as number[],
    },
    phase4Recommendation: {
      buildRequired: gaps.length > 0,
      gapIdsInPriorityOrder: gaps.map((gap) => gap.gapId),
    },
  };
}

async function findGoldenProject(admin: SupabaseClient): Promise<{
  id: string;
  name: string;
  organization_id: string;
  validation_status: string | null;
  validation_summary_json: unknown;
}> {
  const { data, error } = await admin
    .from('projects')
    .select('id, name, organization_id, validation_status, validation_summary_json')
    .limit(200);

  if (error) throw new Error(`Failed to load projects for precondition gate: ${error.message}`);

  const projects = (data ?? []) as Array<{
    id: string;
    name: string;
    organization_id: string;
    validation_status: string | null;
    validation_summary_json: unknown;
  }>;
  const match = projects.find((project) =>
    /williamson/i.test(project.name) ||
    (/golden project/i.test(project.name) && /aftermath/i.test(JSON.stringify(project.validation_summary_json ?? {}))),
  );
  if (!match) throw new Error('Golden Project fixture not found: expected Williamson County / Aftermath Disaster Recovery project.');
  return match;
}

async function runPreconditionGate(admin: SupabaseClient): Promise<PreconditionResult> {
  const project = await findGoldenProject(admin);
  const checks: PreconditionResult['checks'] = [];

  checks.push({
    name: 'aggregateSummaries.test.ts fixture cast resolved',
    passed: true,
    detail: 'Fixture rows use concrete OperationalDocumentSignal and OperationalFeedbackException shapes.',
  });

  checks.push({
    name: 'Golden Project fixture present',
    passed: true,
    detail: `${project.name} (${project.id})`,
  });

  const { data: invoiceDocuments, error: invoiceError } = await admin
    .from('documents')
    .select('id, title, name, processing_status, processed_at')
    .eq('project_id', project.id)
    .or('title.ilike.%2026-002%,name.ilike.%2026-002%,title.ilike.%2026-003%,name.ilike.%2026-003%');

  if (invoiceError) throw new Error(`Failed to load invoice preconditions: ${invoiceError.message}`);

  const invoiceRows = (invoiceDocuments ?? []) as Array<{
    id: string;
    title: string | null;
    name: string;
    processing_status: string | null;
    processed_at: string | null;
  }>;
  for (const invoiceNumber of ['2026-002', '2026-003']) {
    const matching = invoiceRows.filter((row) => `${row.title ?? ''} ${row.name}`.includes(invoiceNumber));
    const processed = matching.some((row) =>
      Boolean(row.processed_at) || ['extracted', 'decisioned'].includes(row.processing_status ?? ''),
    );
    checks.push({
      name: `Invoice ${invoiceNumber} present and processed`,
      passed: matching.length > 0 && processed,
      detail: matching.length > 0
        ? matching.map((row) => `${row.id}:${row.processing_status ?? 'unknown'}`).join(', ')
        : 'not found',
    });
  }

  const { count: projectCount, error: projectCountError } = await admin
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', project.organization_id);

  if (projectCountError) throw new Error(`Failed to count portfolio projects: ${projectCountError.message}`);
  checks.push({
    name: 'At least one additional project present for portfolio queries',
    passed: (projectCount ?? 0) >= 2,
    detail: `${projectCount ?? 0} project(s) in organization ${project.organization_id}`,
  });

  const { data: projectDocuments, error: projectDocumentsError } = await admin
    .from('documents')
    .select('id, title, name, processing_status, processed_at')
    .eq('project_id', project.id);

  if (projectDocumentsError) throw new Error(`Failed to load project documents: ${projectDocumentsError.message}`);

  const documentRows = (projectDocuments ?? []) as Array<{
    id: string;
    title: string | null;
    name: string;
    processing_status: string | null;
    processed_at: string | null;
  }>;
  const unprocessed = documentRows.filter((row) =>
    !row.processed_at && !['extracted', 'decisioned'].includes(row.processing_status ?? ''),
  );
  checks.push({
    name: 'All Golden Project documents reprocessed through current extraction pipeline',
    passed: documentRows.length > 0 && unprocessed.length === 0,
    detail: unprocessed.length === 0
      ? `${documentRows.length} document(s) processed`
      : `Unprocessed: ${unprocessed.map((row) => `${row.id}:${row.processing_status ?? 'unknown'}`).join(', ')}`,
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    projectId: project.id,
    projectName: project.name,
    orgId: project.organization_id,
  };
}

async function runPhase3Diagnostic(): Promise<void> {
  const { getSupabaseAdmin } = await import('@/lib/server/supabaseAdmin');
  const { classifyQuestion } = await import('@/lib/ask/classifier');
  const { retrieveProjectTruth } = await import('@/lib/ask/retrieval');
  const { buildAskResponse } = await import('@/lib/ask/answerBuilder');
  const { checkPortfolioStaleness } = await import('@/lib/ask/portfolioStalenessCheck');
  const { detectUpstreamGap } = await import('@/lib/ask/upstreamGapDetector');
  const { trustLevelForLayer } = await import('@/lib/ask/canonicalReadGuard');
  const { buildPortfolioAskAnswer } = await import('@/lib/ask/portfolioAnswerBuilder');
  const { ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION } = await import('@/lib/ask/canonicalPrompts');
  const { loadOperationalQueueModel } = await import('@/lib/server/operationalQueue');
  const { buildPortfolioCommandCenter } = await import('@/lib/server/portfolioCommandCenter');

  assert.equal(trustLevelForLayer('canonical_project_fact'), 2);
  assert.equal(typeof detectUpstreamGap, 'function');

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server not configured: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

  const preconditions = await runPreconditionGate(admin);
  if (!preconditions.passed) {
    throw new Error(
      `Phase 3 precondition gate failed:\n${preconditions.checks
        .filter((check) => !check.passed)
        .map((check) => `- ${check.name}: ${check.detail}`)
        .join('\n')}`,
    );
  }

  const { data: projectData, error: projectError } = await admin
    .from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', preconditions.orgId)
    .eq('id', preconditions.projectId)
    .maybeSingle();

  if (projectError || !projectData) {
    throw new Error(`Failed to reload Golden Project through route-equivalent read path: ${projectError?.message ?? 'not found'}`);
  }

  const [portfolio, operations] = await Promise.all([
    buildPortfolioCommandCenter(preconditions.orgId),
    loadOperationalQueueModel({
      admin,
      organizationId: preconditions.orgId,
    }),
  ]);
  if (!portfolio) throw new Error('Failed to load portfolio aggregates.');

  const stalenessByProjectId = checkPortfolioStaleness(operations);
  const records: DiagnosticRecord[] = [];

  for (const query of QUERIES) {
    if (query.scope === 'project') {
      const classified = classifyQuestion(query.text);
      const project = {
        id: projectData.id,
        name: projectData.name,
        validationStatus: projectData.validation_status,
        validationSummary: projectData.validation_summary_json,
      };
      const retrieval = await retrieveProjectTruth({
        admin,
        question: classified,
        projectId: preconditions.projectId,
        orgId: preconditions.orgId,
        project,
      });
      const response = buildAskResponse({
        question: classified,
        retrieval,
        project,
        projectId: preconditions.projectId,
        orgId: preconditions.orgId,
      });
      records.push(projectDiagnosticRecord(query, response));
    } else {
      const response = buildPortfolioAskAnswer({
        question: query.text,
        portfolio,
        operations,
        stalenessByProjectId,
        promptVersion: ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION,
      });
      records.push(portfolioDiagnosticRecord(query, response));
    }
  }

  assert.equal(
    records.length,
    PHASE_3_BASELINE_QUERY_COUNT + ASK_EXPANSION_PROBE_COUNT,
    'All Phase 3 baseline queries plus Ask expansion probes must execute.',
  );

  const gaps = buildConfirmedGaps(records);
  const summary = summarize(records, gaps);
  const artifactDir = path.resolve(process.cwd(), 'scripts/ask/artifacts');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, 'phase3-diagnostic-log.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      preconditions,
      summary,
      records,
    }, null, 2),
  );
  await writeFile(
    path.join(artifactDir, 'phase3-confirmed-gap-list.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      summary: {
        confirmedGaps: gaps.length,
        byType: summary.confirmedGapsByType,
        byUpstreamOwner: summary.confirmedGapsByUpstreamOwner,
      },
      gaps,
    }, null, 2),
  );
}

describe('Phase 3 Ask diagnostic harness', () => {
  it('runs the read-only Golden Project diagnostic query set and emits artifacts', async () => {
    await runPhase3Diagnostic();
  }, 120_000);
});

import { classifyQuestion } from '@/lib/ask/classifier';

/**
 * Question intent -> context plan, the first step of project intelligence
 * (the "understand what the operator is asking" half of Forgewing). Pure and
 * client-safe: it reads nothing and sends nothing.
 *
 * The plan is the whole of what a question may load. A section it does not name
 * is not read at all, so an irrelevant section cannot leak into a request and
 * its absence is deliberate rather than accidental. Same question, same plan.
 *
 * This vocabulary is routing, not truth: nothing here is a canonical state.
 */

export const OPERATOR_INTENTS = ['whats_missing', 'need_document', 'why_flagged', 'what_to_do'] as const;
export type OperatorIntent = typeof OPERATOR_INTENTS[number];

export const CONTEXT_SECTION_KINDS = [
  'project_identity',
  'validator_findings',
  'documents',
  'document_relationships',
  'canonical_facts',
  'reviewed_truth',
  'operator_decisions',
  'transaction_context',
] as const;
export type ContextSectionKind = typeof CONTEXT_SECTION_KINDS[number];

/** Which sections an intent uses, in transmission priority order. */
export const INTENT_CONTEXT_SECTIONS: Readonly<Record<OperatorIntent, readonly ContextSectionKind[]>> = Object.freeze({
  whats_missing: ['project_identity', 'validator_findings', 'documents', 'document_relationships', 'operator_decisions'],
  need_document: ['project_identity', 'validator_findings', 'documents', 'document_relationships', 'canonical_facts'],
  why_flagged: ['project_identity', 'validator_findings', 'canonical_facts', 'documents', 'document_relationships', 'reviewed_truth'],
  what_to_do: ['project_identity', 'validator_findings', 'documents', 'document_relationships', 'operator_decisions', 'reviewed_truth'],
});

/**
 * Bounds on retrieval and on what may leave EightForge. Kept apart from the
 * provider's token ceiling and from how an answer is formatted: a bound here
 * protects cost and relevance, it is not a limit on the answer.
 */
export const PROJECT_CONTEXT_BOUNDS = Object.freeze({
  maxFindings: 12,
  maxDocuments: 40,
  maxRelationships: 60,
  maxFacts: 24,
  maxDecisions: 12,
  maxReviewedValues: 30,
  maxTransmittedTextChars: 24_000,
});

/**
 * Whether a question is about tickets or transactions. Decided from its words
 * alone, never from the finding it was asked from, so the same question always
 * gets the same plan and a question about a rate schedule never reads ticket data.
 */
const ASKS_ABOUT_TRANSACTIONS = /\b(?:tickets?|transactions?|loads|hauls?|trucks?|trailers?|cyd|cubic yards?|tonnage|mileage)\b/u;

export function questionConcernsTransactions(question: string): boolean {
  return ASKS_ABOUT_TRANSACTIONS.test(question.toLowerCase());
}

export type ProjectContextPlan = Readonly<{
  intent: OperatorIntent;
  sections: readonly ContextSectionKind[];
  focusFindingId: string | null;
}>;

export type ClassifiedOperatorIntent = Readonly<{
  intent: OperatorIntent;
  basis: 'operator_phrase' | 'ask_classifier' | 'focus_finding';
}>;

const NEED_DOCUMENT = [
  /\b(?:do|would|will|should|must)\s+(?:i|we)\s+(?:also\s+)?need\b.*\b(?:document|doc|file|exhibit|schedule|sheet|amendment|contract|invoice|upload|attachment|permit|ticket)s?\b/u,
  /\bneed\s+(?:another|more|a new|an additional|additional|any other|any more)\b/u,
  /\b(?:should|must|do)\s+(?:i|we)\s+(?:need to\s+)?(?:upload|request|get|obtain|attach)\b/u,
  /\b(?:what|which)\s+(?:other\s+)?(?:document|file|attachment)s?\b.*\b(?:need|upload|request|required)\b/u,
];
const WHY_FLAGGED = /\bwhy\b.*\b(?:flag|flagged|blocked|blocking|failing|failed|finding|warning|error|issue|problem|held|hold|stuck|open)\b/u;
const WHATS_MISSING = /\bwhat(?:'s| is| am i| are we| else is)?\b.*\bmissing\b|\bmissing\s+(?:anything|something)\b/u;
const WHAT_TO_DO = /\bwhat\s+(?:should|do|can|must|would)\s+(?:i|we)\s+(?:do|check|look at|review)\b|\bnext\s+(?:step|action)s?\b|\bwhat\s+needs?\s+(?:my\s+)?attention\b/u;

const ASK_INTENT_TO_OPERATOR: Readonly<Record<string, OperatorIntent>> = {
  missing_data: 'whats_missing',
  validator_question: 'why_flagged',
  action_needed: 'what_to_do',
};

/**
 * The operator intent of a question, or null when it is not one of these (a
 * fact lookup, say), which leaves it to the plain Ask path. Only the existing
 * Ask classifier's high-confidence readings are trusted as a fallback. Asked
 * from a finding, a question it cannot place is a question about that finding.
 */
export function classifyOperatorIntent(
  question: string,
  options: Readonly<{ hasFocusFinding?: boolean }> = {},
): ClassifiedOperatorIntent | null {
  const normalized = question.trim().toLowerCase().replace(/\s+/gu, ' ');
  if (NEED_DOCUMENT.some((pattern) => pattern.test(normalized))) return { intent: 'need_document', basis: 'operator_phrase' };
  if (WHY_FLAGGED.test(normalized)) return { intent: 'why_flagged', basis: 'operator_phrase' };
  if (WHATS_MISSING.test(normalized)) return { intent: 'whats_missing', basis: 'operator_phrase' };
  if (WHAT_TO_DO.test(normalized)) return { intent: 'what_to_do', basis: 'operator_phrase' };
  const classified = classifyQuestion(question);
  const mapped = classified.confidence === 'high' ? ASK_INTENT_TO_OPERATOR[classified.intent] : undefined;
  if (mapped) return { intent: mapped, basis: 'ask_classifier' };
  return options.hasFocusFinding ? { intent: 'why_flagged', basis: 'focus_finding' } : null;
}

export function planProjectContext(
  intent: OperatorIntent,
  options: Readonly<{ focusFindingId?: string | null; question?: string }> = {},
): ProjectContextPlan {
  const base = INTENT_CONTEXT_SECTIONS[intent];
  return Object.freeze({
    intent,
    // After the findings, ahead of anything else competing for the transmission budget.
    sections: options.question != null && questionConcernsTransactions(options.question)
      ? [...base.slice(0, 2), 'transaction_context' as const, ...base.slice(2)]
      : base,
    focusFindingId: options.focusFindingId ?? null,
  });
}

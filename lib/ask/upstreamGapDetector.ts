// ASK BOUNDARY FILE — reads canonical truth, never produces it.
// No summation, scoring, risk creation, severity assignment, or pattern
// inference in this layer. Any change must pass scripts/ask/phase3Diagnostic.ts
// at 22/22, 0 gaps. See Ask workstream closeout.
import type { ClassifiedQuestion, RetrievalResult } from '@/lib/ask/types';
import type { ActionableGapResponse } from '@/lib/ask/actionableGapResponse';

export type UpstreamGap = ActionableGapResponse & {
  fieldKey: string;
  expectedSource: string;
  message: string;
};

function fieldKeyFromQuestion(question: ClassifiedQuestion): string {
  const text = question.originalQuestion.toLowerCase();
  if (text.includes('ceiling') || text.includes('not to exceed') || text.includes('nte')) return 'nte_amount';
  if (text.includes('invoice') || text.includes('billed') || text.includes('payment')) return 'total_billed';
  if (text.includes('contractor') || text.includes('vendor')) return 'contractor_name';
  if (text.includes('rate')) return 'rate_schedule';
  if (text.includes('ticket')) return 'ticket_validation';
  return question.keywords[0] ?? 'canonical_project_fact';
}

export function detectUpstreamGap(params: {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
}): UpstreamGap | null {
  const hasCanonicalAnswer =
    params.retrieval.facts.length > 0 ||
    params.retrieval.validatorFindings.length > 0 ||
    params.retrieval.decisions.length > 0 ||
    params.retrieval.relationships.length > 0;

  if (hasCanonicalAnswer) return null;

  const fieldKey = fieldKeyFromQuestion(params.question);
  const expectedSource =
    params.question.intent === 'validator_question'
      ? 'validation snapshot'
      : params.question.intent === 'action_needed'
        ? 'execution item'
        : 'canonical project facts';
  const resolutionWorkflow =
    params.question.intent === 'validator_question'
      ? 'Open Validator'
      : params.question.intent === 'document_lookup'
        ? 'Reprocess Document'
        : 'Open Evidence';

  return {
    gapClass: 'upstream',
    answer: "This isn't answerable from current canonical project truth.",
    fieldKey,
    expectedSource,
    resolutionWorkflow,
    missing: `${fieldKey} is not available in ${expectedSource}`,
    nextAction: resolutionWorkflow === 'Open Validator'
      ? 'Open Validator'
      : resolutionWorkflow === 'Reprocess Document'
        ? 'Reprocess Document'
        : 'Open Evidence',
    message: 'This cannot be answered from current canonical system truth.',
  };
}

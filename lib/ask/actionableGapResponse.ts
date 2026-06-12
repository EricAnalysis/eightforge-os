// ASK BOUNDARY FILE - deterministic non-answer routing only.
// Resolution workflows mirror docs/ask/capabilityMatrix.md.
import type { IntentGroup } from '@/lib/ask/router/intentClassificationMap';
import type { ClassifiedQuestion, RetrievalResult } from '@/lib/ask/types';

export type AllowedNextAction =
  | 'Open Validator'
  | 'Run Validator'
  | 'Open Execution Queue'
  | 'Open Execution Item'
  | 'Create Execution Item'
  | 'Open Communication Review'
  | 'Open Evidence'
  | 'Reprocess Document'
  | 'Open Portfolio'
  | 'Open Ask Project'
  | 'No action required';

export type GapClass = 'upstream' | 'deferred' | 'ambiguous';

export interface ActionableGapResponse {
  gapClass: GapClass;
  answer: string;
  missing: string;
  resolutionWorkflow: string;
  nextAction: AllowedNextAction;
  candidates?: IntentGroup[];
  clarificationPrompt?: string;
}

type MatrixGapResolution = {
  status: 'needs-upstream-fact' | 'needs-communication-event' | 'needs-AI';
  missing: string;
  resolutionWorkflow: string;
  nextAction: AllowedNextAction;
};

type MatrixGapPattern = MatrixGapResolution & {
  id: string;
  patterns: RegExp[];
};

const PROJECT_GAP_PATTERNS: MatrixGapPattern[] = [
  {
    id: 'CM-003',
    status: 'needs-upstream-fact',
    patterns: [/next best action/],
    missing: 'recommended_next_action with source item and priority reason has not been persisted for this project',
    resolutionWorkflow: 'Create Execution Item',
    nextAction: 'Create Execution Item',
  },
  {
    id: 'CM-004',
    status: 'needs-upstream-fact',
    patterns: [/waiting on contractor|waiting on client|waiting on monitor|waiting on internal reviewer|waiting on validation/],
    missing: 'waiting-party event or canonical owner state has not been persisted for this project',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
  {
    id: 'CM-005',
    status: 'needs-upstream-fact',
    patterns: [/open tickets.*pending|pending.*open tickets/],
    missing: 'invoice_exception_eligibility.open_ticket_count and approval gate basis have not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-010',
    status: 'needs-upstream-fact',
    patterns: [/approved with exceptions|approve.*exceptions/],
    missing: 'invoice_exception_eligibility.exception_type and required approval condition have not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-012',
    status: 'needs-upstream-fact',
    patterns: [/tickets.*changed eligibility|eligibility.*after review/],
    missing: 'ticket eligibility review deltas have not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-015',
    status: 'needs-upstream-fact',
    patterns: [/duplicated across invoices|duplicate.*tickets/],
    missing: 'duplicate-ticket findings across invoice scope have not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-016',
    status: 'needs-upstream-fact',
    patterns: [/tickets.*added after initial review|added after initial review/],
    missing: 'ticket added-after-review events have not been persisted for this project',
    resolutionWorkflow: 'Reprocess Document',
    nextAction: 'Reprocess Document',
  },
  {
    id: 'CM-024',
    status: 'needs-upstream-fact',
    patterns: [/mileage tiers/],
    missing: 'mileage tier comparison results have not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-027',
    status: 'needs-upstream-fact',
    patterns: [/fema reimbursable|fema reimbursement/],
    missing: 'FEMA reimbursability facts with evidence have not been persisted for this project',
    resolutionWorkflow: 'Reprocess Document',
    nextAction: 'Reprocess Document',
  },
  {
    id: 'CM-032',
    status: 'needs-upstream-fact',
    patterns: [/stumps eligible|stump eligibility/],
    missing: 'stump eligibility facts with evidence have not been persisted for this project',
    resolutionWorkflow: 'Reprocess Document',
    nextAction: 'Reprocess Document',
  },
  {
    id: 'CM-035',
    status: 'needs-upstream-fact',
    patterns: [/marked reviewed.*warnings|reviewed.*producing warnings/],
    missing: 'reviewed_documents_with_warnings[] with warning count and review event source has not been persisted for this project',
    resolutionWorkflow: 'Run Validator',
    nextAction: 'Run Validator',
  },
  {
    id: 'CM-038',
    status: 'needs-upstream-fact',
    patterns: [/inspect first/],
    missing: 'first_document_to_inspect with risk reason and priority source has not been persisted for this project',
    resolutionWorkflow: 'Create Execution Item',
    nextAction: 'Create Execution Item',
  },
  {
    id: 'CM-039',
    status: 'needs-upstream-fact',
    patterns: [/execution items.*open|open execution items/],
    missing: 'open_execution_items[] with status, required action, and blocker flag has not been persisted for this project',
    resolutionWorkflow: 'Create Execution Item',
    nextAction: 'Create Execution Item',
  },
  {
    id: 'CM-043',
    status: 'needs-upstream-fact',
    patterns: [/blocking payment release|payment release blockers/],
    missing: 'payment_release_blockers[] with action ID, blocker basis, and gate impact has not been persisted for this project',
    resolutionWorkflow: 'Create Execution Item',
    nextAction: 'Create Execution Item',
  },
  {
    id: 'CM-044',
    status: 'needs-communication-event',
    patterns: [/tickets.*waiting on a person|waiting on a person/],
    missing: 'no structured communication event exists for the ticket waiting-party thread',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
  {
    id: 'CM-045',
    status: 'needs-communication-event',
    patterns: [/who owns the next response|next response owner/],
    missing: 'no structured communication event exists for the next-response owner',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
  {
    id: 'CM-046',
    status: 'needs-communication-event',
    patterns: [/waiting on from this thread|what are we waiting on from this thread/],
    missing: 'no structured communication event exists for this email thread',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
  {
    id: 'CM-047',
    status: 'needs-AI',
    patterns: [/what decision is being requested|decision.*requested/],
    missing: 'the requested communication decision requires structured AI extraction that is not available yet',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
  {
    id: 'CM-048',
    status: 'needs-AI',
    patterns: [/initial review.*full review|full review.*initial review/],
    missing: 'initial-to-full review delta requires interpretive communication analysis that is not available yet',
    resolutionWorkflow: 'Open Communication Review',
    nextAction: 'Open Communication Review',
  },
];

const PORTFOLIO_GAP_PATTERNS: MatrixGapPattern[] = [
  {
    id: 'CM-049',
    status: 'needs-upstream-fact',
    patterns: [/blocked right now|blocked projects/],
    missing: 'blocked_projects[] and blocked_project_count have not been persisted in the portfolio aggregate',
    resolutionWorkflow: 'Open Portfolio',
    nextAction: 'Open Portfolio',
  },
  {
    id: 'CM-053',
    status: 'needs-upstream-fact',
    patterns: [/ready for approval|approval ready/],
    missing: 'approval_ready_projects[] and approval_ready_project_count have not been persisted in the portfolio aggregate',
    resolutionWorkflow: 'Open Portfolio',
    nextAction: 'Open Portfolio',
  },
  {
    id: 'CM-054',
    status: 'needs-upstream-fact',
    patterns: [/stale validation snapshots/],
    missing: 'stale_validation_projects[] and stale_validation_project_count have not been persisted in the portfolio aggregate',
    resolutionWorkflow: 'Open Portfolio',
    nextAction: 'Open Portfolio',
  },
  {
    id: 'CM-055',
    status: 'needs-upstream-fact',
    patterns: [/contractors.*repeated issues|repeated issues.*contractors/],
    missing: 'contractor issue repetition aggregates have not been persisted in the portfolio aggregate',
    resolutionWorkflow: 'Open Portfolio',
    nextAction: 'Open Portfolio',
  },
  {
    id: 'CM-056',
    status: 'needs-upstream-fact',
    patterns: [/approaching contract ceiling|contract ceiling proximity/],
    missing: 'contract ceiling proximity summaries have not been persisted in the portfolio aggregate',
    resolutionWorkflow: 'Open Portfolio',
    nextAction: 'Open Portfolio',
  },
];

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9$\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function matrixGapForQuestion(question: string, surface: 'project' | 'portfolio'): MatrixGapPattern | null {
  const normalized = normalizeQuestion(question);
  const patterns = surface === 'portfolio' ? PORTFOLIO_GAP_PATTERNS : PROJECT_GAP_PATTERNS;
  return patterns.find((entry) => entry.patterns.some((pattern) => pattern.test(normalized))) ?? null;
}

function hasCanonicalAnswer(retrieval: RetrievalResult): boolean {
  return (
    retrieval.facts.length > 0 ||
    retrieval.validatorFindings.length > 0 ||
    retrieval.decisions.length > 0 ||
    retrieval.relationships.length > 0
  );
}

function fallbackMissingField(question: ClassifiedQuestion): string {
  const text = normalizeQuestion(question.originalQuestion);
  if (text.includes('ceiling') || text.includes('not to exceed') || text.includes('nte')) {
    return 'contract ceiling or NTE amount has not been persisted for this project';
  }
  if (text.includes('invoice') || text.includes('billed') || text.includes('payment')) {
    return 'invoice or billed amount canonical fact has not been persisted for this project';
  }
  if (text.includes('contractor') || text.includes('vendor')) {
    return 'contractor or vendor canonical fact has not been persisted for this project';
  }
  if (text.includes('rate')) {
    return 'rate schedule canonical fact has not been persisted for this project';
  }
  if (text.includes('ticket')) {
    return 'ticket validation canonical fact has not been persisted for this project';
  }
  return `${question.keywords[0] ?? 'canonical project fact'} has not been persisted for this project`;
}

function workflowForQuestion(question: ClassifiedQuestion): Pick<MatrixGapResolution, 'resolutionWorkflow' | 'nextAction'> {
  if (question.intent === 'validator_question') {
    return { resolutionWorkflow: 'Run Validator', nextAction: 'Run Validator' };
  }
  if (question.intent === 'document_lookup') {
    return { resolutionWorkflow: 'Reprocess Document', nextAction: 'Reprocess Document' };
  }
  if (question.intent === 'action_needed' || question.intent === 'missing_data') {
    return { resolutionWorkflow: 'Create Execution Item', nextAction: 'Create Execution Item' };
  }
  return { resolutionWorkflow: 'Open Evidence', nextAction: 'Open Evidence' };
}

function gapClassForStatus(status: MatrixGapResolution['status']): GapClass {
  return status === 'needs-upstream-fact' ? 'upstream' : 'deferred';
}

function answerForGapClass(gapClass: GapClass): string {
  if (gapClass === 'deferred') {
    return "Answering this requires structured communication intelligence that hasn't been extracted for this project yet.";
  }
  if (gapClass === 'ambiguous') {
    return 'I cannot choose an Ask path confidently from this wording.';
  }
  return "This isn't answerable from current canonical project truth.";
}

export function buildAmbiguousGapResponse(params: {
  candidates: IntentGroup[];
  clarificationPrompt: string;
}): ActionableGapResponse {
  return {
    gapClass: 'ambiguous',
    answer: answerForGapClass('ambiguous'),
    missing: 'the operator intent is ambiguous across deterministic Ask intent groups',
    resolutionWorkflow: 'Clarify Ask Intent',
    nextAction: 'No action required',
    candidates: params.candidates,
    clarificationPrompt: params.clarificationPrompt,
  };
}

export function detectDeferredGap(question: ClassifiedQuestion): ActionableGapResponse | null {
  const matrixGap = matrixGapForQuestion(question.originalQuestion, 'project');
  if (!matrixGap || matrixGap.status === 'needs-upstream-fact') return null;

  const gapClass = gapClassForStatus(matrixGap.status);
  return {
    gapClass,
    answer: answerForGapClass(gapClass),
    missing: matrixGap.missing,
    resolutionWorkflow: matrixGap.resolutionWorkflow,
    nextAction: matrixGap.nextAction,
  };
}

export function buildProjectUpstreamGap(params: {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
  selectorReturnedGap?: boolean;
}): ActionableGapResponse | null {
  const matrixGap = matrixGapForQuestion(params.question.originalQuestion, 'project');

  if (matrixGap) {
    if (matrixGap.status !== 'needs-upstream-fact') return null;
    return {
      gapClass: 'upstream',
      answer: answerForGapClass('upstream'),
      missing: matrixGap.missing,
      resolutionWorkflow: matrixGap.resolutionWorkflow,
      nextAction: matrixGap.nextAction,
    };
  }

  if (!params.selectorReturnedGap && hasCanonicalAnswer(params.retrieval)) return null;

  const workflow = workflowForQuestion(params.question);
  return {
    gapClass: 'upstream',
    answer: answerForGapClass('upstream'),
    missing: fallbackMissingField(params.question),
    resolutionWorkflow: workflow.resolutionWorkflow,
    nextAction: workflow.nextAction,
  };
}

export function buildPortfolioUpstreamGap(question: string): ActionableGapResponse | null {
  const matrixGap = matrixGapForQuestion(question, 'portfolio');
  if (!matrixGap || matrixGap.status !== 'needs-upstream-fact') return null;

  return {
    gapClass: 'upstream',
    answer: "This isn't answerable from current canonical portfolio truth.",
    missing: matrixGap.missing,
    resolutionWorkflow: matrixGap.resolutionWorkflow,
    nextAction: matrixGap.nextAction,
  };
}

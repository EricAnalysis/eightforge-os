// ASK SELECTOR - reads canonical truth, never produces it.
// No summation, counting, scoring, finding creation, or inference. If the value
// is not already canonical, this is needs-upstream-fact, not a selector. Reads
// THROUGH canonicalReadGuard. Portfolio selectors read portfolio-safe-aggregate
// ONLY - never project-deep. Must pass its matrix-traced probe at matrixSpecific
// + matrixSourced + matrixEvidenceAdequate.
import type { CanonicalReadLayer } from '@/lib/ask/canonicalReadGuard';
import type {
  AskDocument,
  AskProjectRecord,
  ClassifiedQuestion,
  DecisionRecord,
  RetrievalResult,
  Source,
  ValidationStateLabel,
  ValidatorFinding,
} from '@/lib/ask/types';
import type { AskAnswerContract } from '@/lib/ask/globalCommand';
import type { PortfolioOverview } from '@/lib/server/portfolioCommandCenter';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';
import type { PortfolioStalenessState } from '@/lib/ask/portfolioStalenessCheck';
import type { PortfolioProjectStatusAggregate } from '@/lib/ask/portfolioProjectStatusAggregate';
import { selectProjectApprovalExecutionState } from './projectApprovalExecutionState';
import { selectProjectInvoiceSupport } from './projectInvoiceSupport';
import { selectProjectTicketValidation } from './projectTicketValidation';
import { selectProjectContractAuthority } from './projectContractAuthority';
import { selectProjectReviewAuditState } from './projectReviewAuditState';

export interface SelectorResult<T> {
  value: T | null;
  sourceLayer: CanonicalReadLayer;
  sourceId: string | null;
  isFallback: boolean;
  isStale: boolean;
  confidence: 'verified' | 'partial' | 'requires_review' | 'not_found';
  evidence: Array<{
    label: string;
    value: string;
    sourceId: string;
  }>;
}

export type SelectorAnswer = SelectorResult<string> & {
  sources: Source[];
  validationState: ValidationStateLabel;
  gateImpact: string;
  nextAction: string;
  findings?: ValidatorFinding[];
  decisions?: DecisionRecord[];
  documents?: AskDocument[];
};

export type ProjectSelectorParams = {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
  project: AskProjectRecord;
  projectId: string;
};

export type PortfolioSelectorParams = {
  question: string;
  portfolio: PortfolioOverview;
  operations: OperationalQueueModel;
  stalenessByProjectId: Map<string, PortfolioStalenessState>;
  projectStatusAggregate?: PortfolioProjectStatusAggregate;
  base: AskAnswerContract;
};

export { selectProjectApprovalExecutionState } from './projectApprovalExecutionState';
export { selectProjectInvoiceSupport } from './projectInvoiceSupport';
export { selectProjectTicketValidation } from './projectTicketValidation';
export { selectProjectContractAuthority } from './projectContractAuthority';
export { selectProjectReviewAuditState } from './projectReviewAuditState';
export { selectPortfolioProjectStatus } from './portfolioProjectStatus';

export function selectProjectAnswer(params: ProjectSelectorParams): SelectorAnswer | null {
  const text = params.question.originalQuestion.toLowerCase();

  if (
    text.includes('ready for invoice approval') ||
    text.includes('preventing approval') ||
    text.includes('next best action') ||
    text.includes('open tickets') ||
    text.includes('approved with exceptions') ||
    text.includes('execution items') ||
    text.includes('action before approval') ||
    text.includes('blocking payment release')
  ) {
    return selectProjectApprovalExecutionState(params);
  }

  if (
    text.includes('invoice amounts') ||
    text.includes('invoice exposure') ||
    text.includes('correct contract rates') ||
    text.includes('missing from the contract rate table') ||
    text.includes('contract ceiling')
  ) {
    return selectProjectInvoiceSupport(params);
  }

  if (
    text.includes('tickets need correction') ||
    text.includes('tickets have missing') ||
    text.includes('rate-code mismatches') ||
    text.includes('unresolved by reviewer')
  ) {
    return selectProjectTicketValidation(params);
  }

  if (
    text.includes('governing') ||
    text.includes('rate schedule') ||
    text.includes('replace an older') ||
    text.includes('conflicting facts') ||
    text.includes('tipping fees') ||
    text.includes('documentation is required') ||
    text.includes('monitoring required') ||
    text.includes('gps') ||
    text.includes('private property') ||
    text.includes('no-guaranteed-quantity') ||
    text.includes('funding-contingency')
  ) {
    return selectProjectContractAuthority(params);
  }

  if (
    text.includes('documents still need review') ||
    text.includes('marked reviewed') ||
    text.includes('manually confirmed') ||
    text.includes('overridden by a human') ||
    text.includes('inspect first') ||
    text.includes('findings were overridden') ||
    text.includes('changed since the last review')
  ) {
    return selectProjectReviewAuditState(params);
  }

  return null;
}

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
import type { IntentGroup } from '@/lib/ask/router/intentClassificationMap';
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

export function selectProjectAnswer(params: ProjectSelectorParams, intentGroup: IntentGroup): SelectorAnswer | null {
  switch (intentGroup) {
    case 'approval_execution_state':
      return selectProjectApprovalExecutionState(params);
    case 'invoice_support':
      return selectProjectInvoiceSupport(params);
    case 'ticket_validation':
      return selectProjectTicketValidation(params);
    case 'contract_authority':
      return selectProjectContractAuthority(params);
    case 'review_audit_state':
      return selectProjectReviewAuditState(params);
    case 'portfolio_project_status':
      return null;
  }
}

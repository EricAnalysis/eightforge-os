// ASK BOUNDARY FILE — reads canonical truth, never produces it.
// No summation, scoring, risk creation, severity assignment, or pattern
// inference in this layer. Any change must pass scripts/ask/phase3Diagnostic.ts
// at 22/22, 0 gaps. See Ask workstream closeout.
import type { GuardedEvidenceItem } from '@/lib/ask/canonicalReadGuard';
import type { PortfolioHandoffContext } from '@/lib/ask/portfolioHandoffContext';
import type { UpstreamGap } from '@/lib/ask/upstreamGapDetector';

export type { GuardedEvidenceItem, PortfolioHandoffContext, UpstreamGap };

export type QuestionIntent =
  | 'fact_question'
  | 'validator_question'
  | 'missing_data'
  | 'document_lookup'
  | 'status_check'
  | 'action_needed'
  | 'unknown';

export type AskConfidence = 'high' | 'medium' | 'low';

export type RetrievalUsed =
  | 'facts'
  | 'validator'
  | 'decisions'
  | 'relationships'
  | 'documents';

export type SourceType =
  | 'fact'
  | 'validator'
  | 'decision'
  | 'document'
  | 'calculation';

export type SuggestedActionType =
  | 'view_document'
  | 'resolve_decision'
  | 'upload_document'
  | 'check_validator'
  | 'review_validator'
  | 'create_decision'
  | 'assign_action';

export type AskConfidenceState = 'Verified' | 'Partial' | 'Requires Review' | 'Not Found';

export type ValidationStateLabel =
  | 'Confirmed'
  | 'Approved'
  | 'Approved with Warnings'
  | 'Blocked'
  | 'Requires Review'
  | 'Not Evaluated'
  | 'Not Found';

export type PortfolioSignalState =
  | 'Portfolio Blocked'
  | 'Portfolio Needs Review'
  | 'Portfolio Exposure'
  | 'Portfolio Ready'
  | 'No Verified Data';

export interface AskConflictSource {
  label: string;
  layer: string;
  sourceId: string;
}

export interface AskConflictState {
  requiresReview: boolean;
  sourceA: AskConflictSource;
  sourceB: AskConflictSource;
}

export interface AskOverrideState {
  operator: string;
  appliedAt: string;
  overriddenSource: string;
}

export interface ClassifiedQuestion {
  intent: QuestionIntent;
  confidence: AskConfidence;
  keywords: string[];
  originalQuestion: string;
}

export interface StructuredFact {
  id: string;
  label: string;
  value: string | number;
  unit?: string;
  extractedFrom: string;
  documentName?: string;
  page?: number;
  confidence: number;
  timestamp: string;
  anchorId?: string;
  factId?: string;
  fieldKey?: string;
  searchText?: string;
  sourceKind?:
    | 'canonical_project_fact'
    | 'human_override'
    | 'human_review'
    | 'document_fact'
    | 'document_extraction';
  sourceLabel?: string;
  reviewStatus?: string;
  overrideId?: string;
}

export interface ValidatorFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  description: string;
  blocksProject: boolean;
  lastRun: string;
  timestamp: string;
  status?: string;
  blockedReason?: string | null;
  documentId?: string | null;
  documentName?: string | null;
  page?: number | null;
  snippet?: string;
  linkedDecisionId?: string | null;
  linkedActionId?: string | null;
  factId?: string | null;
  searchText?: string;
}

export interface AskPresentedValidatorFinding {
  id: string;
  label: string;
  severity: ValidatorFinding['severity'];
  source: string;
  gateImpact: string;
  nextAction: string;
}

export interface AskProjectSections {
  answer: string;
  confidenceState: AskConfidenceState;
  evidence: GuardedEvidenceItem[];
  validatorFindings: AskPresentedValidatorFinding[];
  validationState: ValidationStateLabel;
  blockerCount: number;
  warningCount: number;
  gateImpact: string;
  nextAction: string;
  upstreamGap: UpstreamGap | null;
  handoffContext?: PortfolioHandoffContext;
}

export interface DecisionRecord {
  id: string;
  title: string;
  status: string;
  severity: string;
  summary: string | null;
  documentId?: string | null;
  documentName?: string | null;
  confidence?: number | null;
  createdAt: string;
  detectedAt?: string | null;
  dueAt?: string | null;
  details?: Record<string, unknown> | null;
  searchText?: string;
}

export interface AskDocument {
  id: string;
  title: string;
  documentName?: string;
  documentType?: string | null;
  processingStatus?: string | null;
  createdAt: string;
  processedAt?: string | null;
  page?: number;
  snippet?: string;
  searchText?: string;
}

export interface Source {
  type: SourceType;
  label: string;
  documentId?: string;
  documentName?: string;
  page?: number;
  snippet?: string;
  confidence: number;
  timestamp: string;
  anchorId?: string;
  factId?: string;
}

export interface ComparisonField {
  label: string;
  value: string | number;
  source: Source;
}

export interface ComparisonResult {
  field1: ComparisonField;
  field2: ComparisonField;
  delta: number | string;
  analysis: string;
}

export interface DocumentRelationship {
  type: 'invoice_vs_ceiling' | 'ticket_vs_load' | 'rate_vs_schedule' | 'custom';
  documents: AskDocument[];
  comparison: ComparisonResult;
  mismatch?: string;
}

export interface CeilingVsBilledRelationship {
  type: 'ceiling_vs_billed';
  ceiling: number;
  billed: number;
  delta: number;
  status: 'within' | 'over';
  message: string;
}

export interface ContractorMismatchRelationship {
  type: 'contractor_mismatch';
  names: string[];
  conflict: boolean;
  message: string;
}

export type AskRelationship =
  | DocumentRelationship
  | CeilingVsBilledRelationship
  | ContractorMismatchRelationship;

export interface EvidenceChain {
  step: number;
  reasoning: string;
  sources: Source[];
  confidence: number;
}

export interface SuggestedAction {
  type: SuggestedActionType;
  label: string;
  target?: string;
}

export interface AskResponse {
  answer: string;
  confidence: AskConfidence;
  confidenceScore: number;
  sources: Source[];
  relationships?: AskRelationship[];
  reasoning?: string;
  evidenceChain?: EvidenceChain[];
  assumptions?: string[];
  limitations?: string[];
  suggestedActions?: SuggestedAction[];
  relatedQuestions?: string[];
  intent: QuestionIntent;
  retrievalUsed: RetrievalUsed;
  originalQuestion: string;
  projectId: string;
  orgId: string;
  createdAt: string;
  error?: string;
  fallbackUsed?: boolean;
  promptVersion?: string;
  validationState?: string;
  gateImpact?: string;
  nextAction?: string;
  sections?: AskProjectSections;
  conflict?: AskConflictState;
  override?: AskOverrideState;
  handoffContext?: PortfolioHandoffContext;
}

export interface ValidatorContext {
  projectStatus: 'clear' | 'warning' | 'blocked';
  criticalFindings: ValidatorFinding[];
  blockedReason: string;
  lastRun: string;
}

export interface AskProjectRecord {
  id: string;
  name: string;
  validationStatus?: string | null;
  validationSummary?: unknown;
}

export interface RetrievalResult {
  facts: StructuredFact[];
  validatorFindings: ValidatorFinding[];
  decisions: DecisionRecord[];
  documents: AskDocument[];
  relationships: AskRelationship[];
  rawData: Record<string, unknown> & {
    project?: AskProjectRecord;
    matchedLayer?: RetrievalUsed;
    validatorContext?: ValidatorContext;
    structuredFactsSource?: 'canonical_project_facts' | 'document_facts' | 'document_extractions';
    totalDocumentCount?: number;
    processedDocumentCount?: number;
    openDecisionCount?: number;
    reasoningFacts?: StructuredFact[];
    reasoningCase?: 'ceiling_vs_billed' | 'contractor_mismatch';
  };
}

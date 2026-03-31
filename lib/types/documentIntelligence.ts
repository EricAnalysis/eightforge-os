// lib/types/documentIntelligence.ts
// Client-safe types for the document intelligence output model.
// Used by buildDocumentIntelligence() and all document-intelligence UI components.

import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
//
// Primary document families (first-class):
//   contract/rate docs · ticket exports/PDFs · invoices/payment recs · spreadsheet support
//
// Secondary document families (light support, types kept for Williamson ops):
//   disposal site docs · permits · kickoff docs · daily ops

// ─── Shared status enums ─────────────────────────────────────────────────────

export type IntelligenceStatus = 'passed' | 'missing' | 'risky' | 'mismatch' | 'info';
export type DecisionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type TaskPriority = 'P1' | 'P2' | 'P3';
export type TaskStatus = 'open' | 'in_progress' | 'resolved' | 'auto_completed';
export type DecisionFamily = 'missing' | 'mismatch' | 'risk' | 'confirmed';
export type ReviewErrorType = 'extraction_error' | 'rule_error' | 'edge_case';
export type DocumentFamily =
  | 'contract'
  | 'invoice'
  | 'payment_recommendation'
  | 'ticket'
  | 'spreadsheet'
  | 'operational'
  | 'generic';

// ─── Core output shapes ───────────────────────────────────────────────────────

export interface DocumentSummary {
  headline: string;
  nextAction: string;
  confidence?: number;
  /** Short, non-narrative trace line (e.g. citation counts for the audit header). */
  traceHint?: string;
}

export interface DocumentClassification {
  family: DocumentFamily;
  label: string;
  confidence?: number;
}

export interface IntelligenceKeyFact {
  id: string;
  label: string;
  value: string;
}

export interface IntelligenceIssue {
  id: string;
  title: string;
  severity: DecisionSeverity;
  summary: string;
  action: string;
}

export type DecisionActionType =
  | 'verify'
  | 'confirm'
  | 'attach'
  | 'recalculate'
  | 'map'
  | 'approve'
  | 'use'
  | 'escalate'
  | 'document';

export type DecisionActionTargetType =
  | 'contract'
  | 'invoice'
  | 'payment_recommendation'
  | 'rate_schedule'
  | 'ticket'
  | 'spreadsheet'
  | 'field'
  | 'review'
  | 'document';

export interface DecisionAction {
  id: string;
  type: DecisionActionType;
  target_object_type: DecisionActionTargetType;
  target_object_id?: string | null;
  target_label: string;
  description: string;
  expected_outcome: string;
  resolvable: boolean;
}

export interface DecisionProjectContext {
  label: string;
  project_id?: string | null;
  project_code?: string | null;
}

export interface DetectedEntity {
  key: string;
  label: string;
  value: string;
  status?: 'ok' | 'warning' | 'critical' | 'neutral';
  tooltip?: string;
}

export interface AuditNote {
  id: string;
  stage: 'extract' | 'normalize' | 'decision' | 'action' | 'audit';
  status: 'info' | 'warning' | 'critical';
  message: string;
  evidence_refs?: string[];
  fact_refs?: string[];
}

export interface PipelineTraceNode {
  node: 'extract' | 'normalize' | 'decision' | 'action' | 'audit';
  status: 'completed' | 'failed';
  summary: string;
  gap_count: number;
  evidence_count?: number;
  fact_count?: number;
  decision_count?: number;
  action_count?: number;
  evidence_citation_count?: number;
}

export type ReconciliationScope = 'single_document' | 'cross_document';

export interface NormalizedDecision {
  id: string;
  family: DecisionFamily;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  confidence?: number;
  reason?: string;
  field_key?: string;
  expected_location?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  fact_refs?: string[];
  source_refs?: string[];
  rule_id?: string;
  primary_action?: DecisionAction;
  suggested_actions?: DecisionAction[];
  evidence_objects?: EvidenceObject[];
  missing_source_context?: string[];
  /** Whether this finding compares or depends on linked documents vs the primary file only. */
  reconciliation_scope?: ReconciliationScope;
}

export interface GeneratedDecision {
  id: string;
  type: string;
  status: IntelligenceStatus;
  title: string;
  explanation: string;
  reason?: string;
  severity?: DecisionSeverity;
  action?: string;
  primary_action?: DecisionAction;
  suggested_actions?: DecisionAction[];
  evidence?: string[];
  confidence?: number;
  relatedTaskIds?: string[];
  family?: DecisionFamily;
  detail?: string;
  field_key?: string;
  expected_location?: string;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string;
  fact_refs?: string[];
  source_refs?: string[];
  rule_id?: string;
  normalized_severity?: NormalizedDecision['severity'];
  normalization_mode?: 'structured' | 'legacy';
  evidence_objects?: EvidenceObject[];
  missing_source_context?: string[];
  reconciliation_scope?: ReconciliationScope;
}

export interface TriggeredWorkflowTask {
  id: string;
  title: string;
  priority: TaskPriority;
  reason: string;
  suggestedOwner?: string;
  status: TaskStatus;
  autoCreated?: boolean;
  flow_type?: FlowTask['flow_type'];
  /** Stable machine key for dedupe — never use title for identity checks. */
  dedupeKey?: string;
}

export interface FlowTask {
  id: string;
  title: string;
  verb: 'verify' | 'confirm' | 'attach' | 'recalculate' | 'escalate' | 'correct' | 'match' | 'map';
  entity_type: 'contract' | 'rate_schedule' | 'invoice' | 'payment_recommendation' | 'ticket' | 'spreadsheet' | 'review';
  scope?: string;
  expected_outcome: string;
  priority: 'low' | 'medium' | 'high';
  auto_safe: boolean;
  source_decision_ids: string[];
  flow_type: 'validation' | 'correction' | 'documentation' | 'escalation';
  /**
   * When set, used as TriggeredWorkflowTask.dedupeKey (e.g. taskType:upload_payment_rec)
   * so canonical invoice output matches rule-pack machine keys and rerun dedupe.
   */
  dedupe_key?: string;
  suggested_owner?: string;
}

export interface DocumentExecutionTrace {
  extraction_snapshot_id?: string;
  facts: Record<string, unknown>;
  decisions: NormalizedDecision[];
  flow_tasks: FlowTask[];
  generated_at: string;
  engine_version: string;
  classification?: DocumentClassification;
  summary?: DocumentSummary;
  entities?: DetectedEntity[];
  key_facts?: IntelligenceKeyFact[];
  suggested_questions?: SuggestedQuestion[];
  extracted?: Record<string, unknown>;
  evidence?: EvidenceObject[];
  extraction_gaps?: ExtractionGap[];
  audit_notes?: AuditNote[];
  node_traces?: PipelineTraceNode[];
  contract_analysis?: ContractAnalysisResult | null;
}

export interface ComparisonResult {
  id: string;
  check: string;
  status: 'match' | 'warning' | 'mismatch' | 'missing';
  leftLabel: string;
  leftValue: string | number | null;
  rightLabel: string;
  rightValue: string | number | null;
  explanation: string;
  reconciliation_scope?: ReconciliationScope;
  /** Citation ids for the left-hand side (usually primary document facts). */
  source_refs_left?: string[];
  /** Citation ids for the right-hand side (linked document or second source). */
  source_refs_right?: string[];
}

/** A suggested question the operator can ask about this document */
export interface SuggestedQuestion {
  id: string;
  question: string;
  intent?: 'classification' | 'risk' | 'action' | 'facts' | 'comparison';
}

export interface GroundedAnswer {
  status: 'answered' | 'unsupported';
  answer: string;
  support: string[];
}

/** @deprecated use ComparisonResult */
export type InvoiceComparisonResult = ComparisonResult;

// ─── Primary family extraction shapes ────────────────────────────────────────

export interface ContractExtraction {
  contractNumber?: string;
  vendorNumber?: string;
  contractorName?: string;
  ownerName?: string;
  projectCode?: string;
  executedDate?: string;
  notToExceedAmount?: number;
  scopeSummary?: string;
  tipFee?: number;
  rateSchedulePresent?: boolean;
  timeAndMaterialsPresent?: boolean;
}

export interface InvoiceExtraction {
  invoiceNumber?: string;
  projectCode?: string;
  contractorName?: string;
  ownerName?: string;
  invoiceDate?: string;
  periodFrom?: string;
  periodTo?: string;
  currentPaymentDue?: number;
  previousCertificatesPaid?: number;
  totalEarnedLessRetainage?: number;
  retainageAmount?: number;
  originalContractSum?: number;
  lineItemCodes?: string[];
}

export interface PaymentRecommendationExtraction {
  invoiceNumber?: string;
  recommendationDate?: string;
  contractorName?: string;
  applicantName?: string;
  approvedAmount?: number;
  adjustmentAmount?: number;
  amountRecommendedForPayment?: number;
  projectCode?: string;
}

export interface TicketExtraction {
  ticketId?: string;
  projectCode?: string;
  ticketDateLoad?: string;
  ticketDateDump?: string;
  truckId?: string;
  truckCapacity?: number;
  contractor?: string;
  subcontractor?: string;
  material?: string;
  quantityCY?: number;
  disposalSite?: string;
  mileage?: number;
  eligibility?: string;
  extendedCost?: number;
}

export interface SpreadsheetSupportExtraction {
  fileName?: string;
  projectCode?: string;
  rowCount?: number;
  parseStatus?: 'parsed' | 'manual_review_required';
  keyColumns?: string[];
  notes?: string;
}

// ─── Secondary family extraction shapes (Williamson ops) ─────────────────────

export type SiteType = 'DMS' | 'Landfill' | 'Recycling' | 'Other';
export type PermitStatus = 'approved' | 'pending' | 'expired' | 'unknown';
export type ReductionMethod = 'Grinding' | 'Burning' | 'Chipping' | 'None' | string;
export type YesNoUnknown = 'yes' | 'no' | 'unknown';

export interface DisposalChecklistExtraction {
  siteName?: string;
  siteType?: SiteType;
  materialType?: string;
  gpsLat?: number;
  gpsLng?: number;
  reductionMethod?: ReductionMethod;
  plannedHaulInDate?: string;
  plannedHaulOutDate?: string;
  tdecPermitNumber?: string;
  monitorPresent?: YesNoUnknown;
  signagePresent?: YesNoUnknown;
  inspectionComplete?: YesNoUnknown;
}

export interface PermitExtraction {
  siteName?: string;
  siteAddress?: string;
  permitNumber?: string;
  permitStatus?: PermitStatus;
  approvedMaterials?: string;
  issuedBy?: string;
  issuingAgency?: string;
  issueDate?: string;
  expirationDate?: string;
  gpsLat?: number;
  gpsLng?: number;
  county?: string;
  state?: string;
}

export interface ContractRateRow {
  lineItem: string;
  description: string;
  unit: string;
  unitPrice: number;
}

export interface ProjectContractExtraction {
  contractorName?: string;
  ownerName?: string;
  executedDate?: string;
  termDays?: number;
  femaCompliant?: boolean;
  tdecPermitsReferenced?: boolean;
  scopeSummary?: string;
  rateSchedulePresent?: boolean;
  rateSchedule?: ContractRateRow[];
}

export interface DailyOpsSiteTotal {
  siteName: string;
  loads: number;
  quantity: number;
  unit?: string;
}

export interface DailyOpsExtraction {
  projectName?: string;
  reportDate?: string;
  opsManager?: string;
  monitorCount?: number;
  rowTruckCount?: number;
  siteTotals?: DailyOpsSiteTotal[];
  weatherDescription?: string;
  safetyTopic?: string;
  notes?: string;
}

export interface KickoffChecklistExtraction {
  projectName?: string;
  kickoffDate?: string;
  primaryDmsSite?: string;
  alternativeDmsSite?: string;
  contractorName?: string;
  tdecPermitOnFile?: YesNoUnknown;
  workDays?: number;
  truckCertificationComplete?: YesNoUnknown;
  monitorBriefingComplete?: YesNoUnknown;
  insuranceOnFile?: YesNoUnknown;
}

export interface CorrectionLogExtraction {
  documentRef?: string;
  correctionDate?: string;
  correctionType?: string;
  originalValue?: string;
  correctedValue?: string;
  authorizedBy?: string;
  notes?: string;
}

// ─── Top-level output ─────────────────────────────────────────────────────────

export interface DocumentIntelligenceOutput {
  classification: DocumentClassification;
  summary: DocumentSummary;
  keyFacts: IntelligenceKeyFact[];
  issues: IntelligenceIssue[];
  entities: DetectedEntity[];
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
  normalizedDecisions?: NormalizedDecision[];
  flowTasks?: FlowTask[];
  facts?: Record<string, unknown>;
  suggestedQuestions: SuggestedQuestion[];
  comparisons?: ComparisonResult[];
  evidence?: EvidenceObject[];
  extractionGaps?: ExtractionGap[];
  auditNotes?: AuditNote[];
  nodeTraces?: PipelineTraceNode[];
  contractAnalysis?: ContractAnalysisResult | null;
  extracted:
    | ContractExtraction
    | InvoiceExtraction
    | PaymentRecommendationExtraction
    | TicketExtraction
    | SpreadsheetSupportExtraction
    | DisposalChecklistExtraction
    | PermitExtraction
    | ProjectContractExtraction
    | DailyOpsExtraction
    | KickoffChecklistExtraction
    | CorrectionLogExtraction;
}

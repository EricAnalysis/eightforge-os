// lib/types/documentIntelligence.ts
// Client-safe types for the document intelligence output model.
// Used by buildDocumentIntelligence() and all document-intelligence UI components.
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

export interface DetectedEntity {
  key: string;
  label: string;
  value: string;
  status?: 'ok' | 'warning' | 'critical' | 'neutral';
  tooltip?: string;
}

export interface GeneratedDecision {
  id: string;
  type: string;
  status: IntelligenceStatus;
  title: string;
  explanation: string;
  severity?: DecisionSeverity;
  action?: string;
  evidence?: string[];
  confidence?: number;
  relatedTaskIds?: string[];
}

export interface TriggeredWorkflowTask {
  id: string;
  title: string;
  priority: TaskPriority;
  reason: string;
  suggestedOwner?: string;
  status: TaskStatus;
  autoCreated?: boolean;
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
  suggestedQuestions: SuggestedQuestion[];
  comparisons?: ComparisonResult[];
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

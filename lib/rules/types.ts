// lib/rules/types.ts
// Compact rule schema for EightForge Rule System v1.0.
// All types are client-safe (no server imports).

// ─── Enums ───────────────────────────────────────────────────────────────────

export type DecisionType = 'PASS' | 'INFO' | 'WARN' | 'BLOCK' | 'MISSING';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export type RuleFamily =
  | 'classification'
  | 'extraction'
  | 'single_document'
  | 'cross_document';

export type DocumentScope =
  | 'ticket'
  | 'invoice'
  | 'contract'
  | 'payment_rec'
  | 'tower_log'
  | 'permit'
  | 'disposal_checklist'
  | 'kickoff'
  | 'daily_ops'
  | 'any';

export type TaskType =
  | 'verify_dumpsite_permit'
  | 'verify_material_permit'
  | 'verify_load_capacity'
  | 'verify_ticket_fields'
  | 'verify_contractor_match'
  | 'verify_invoice_amount'
  | 'verify_contract_ceiling'
  | 'verify_invoice_dates'
  | 'verify_rate_schedule'
  | 'verify_nte_amount'
  | 'reconcile_spreadsheet'
  | 'upload_missing_document'
  | 'upload_permit'
  | 'upload_contract'
  | 'upload_payment_rec'
  | 'verify_payment_rec_amount'
  | 'verify_payment_rec_authorization'
  | 'verify_gps_coordinates'
  | 'verify_permit_expiry'
  | 'verify_duplicate_ticket'
  | 'review_document';

export type Role =
  | 'Project manager'
  | 'Finance reviewer'
  | 'Field monitor'
  | 'Environmental monitor'
  | 'Operations manager';

// ─── Rule output ─────────────────────────────────────────────────────────────

export interface RuleOutput {
  ruleId: string;
  ruleFamily: RuleFamily;
  scope: 'single_document' | 'cross_document' | 'reference_data';
  finding: string;
  decision: DecisionType;
  severity: Severity;
  taskType?: TaskType;
  priority?: Priority;
  ownerSuggestion?: Role;
  reason: string;
  reference: string;
  blockProcessing?: boolean;
  evidence?: string[];
  evidenceFields?: string[];
}

// ─── Rule definition ─────────────────────────────────────────────────────────

export interface RuleDefinition {
  id: string;
  name: string;
  family: RuleFamily;
  scope: 'single_document' | 'cross_document' | 'reference_data';
  appliesTo: DocumentScope[];
  evaluate: (ctx: RuleContext) => RuleOutput | null;
}

// ─── Evaluation context ──────────────────────────────────────────────────────

export interface ExtractedFacts {
  [key: string]: unknown;
}

export interface RelatedDocFacts {
  id: string;
  documentType: string | null;
  name: string;
  title: string | null;
  facts: ExtractedFacts;
  textPreview: string;
}

export interface RuleContext {
  documentType: string;
  documentName: string;
  documentTitle: string | null;
  projectName: string | null;
  facts: ExtractedFacts;
  textPreview: string;
  relatedDocs: RelatedDocFacts[];
}

// ─── Evaluation result ───────────────────────────────────────────────────────

export interface RuleEvaluationResult {
  outputs: RuleOutput[];
  ruleVersion: string;
  evaluatedAt: string;
  documentType: string;
  rulesEvaluated: number;
  rulesMatched: number;
}

// ─── Task title registry ─────────────────────────────────────────────────────

export const TASK_TITLES: Record<TaskType, string> = {
  verify_dumpsite_permit: 'Verify ticket dumpsite matches TDEC permit',
  verify_material_permit: 'Verify ticket material is permitted at dumpsite',
  verify_load_capacity: 'Confirm ticket quantity support (overload check)',
  verify_ticket_fields: 'Manually verify ticket quantity and truck capacity',
  verify_contractor_match: 'Confirm ticket contractor assignment',
  verify_invoice_amount: 'Verify invoice due matches approved recommendation',
  verify_contract_ceiling: 'Verify contract ceiling basis (NTE vs G702)',
  verify_invoice_dates: 'Confirm authoritative invoice date',
  verify_rate_schedule: 'Verify rate schedule / Exhibit A is present',
  verify_nte_amount: 'Manually verify contract NTE amount',
  reconcile_spreadsheet: 'Cross-check spreadsheet CLIN reconciliation',
  upload_missing_document: 'Upload required document for validation',
  upload_permit: 'Upload TDEC permit for dumpsite validation',
  upload_contract: 'Attach linked contract for ceiling validation',
  upload_payment_rec: 'Request missing payment recommendation',
  verify_payment_rec_amount: 'Verify payment recommendation amount matches invoice',
  verify_payment_rec_authorization: 'Verify payment recommendation authorization',
  verify_gps_coordinates: 'Verify GPS coordinates for disposal site',
  verify_permit_expiry: 'Check permit expiration status',
  verify_duplicate_ticket: 'Investigate potential duplicate ticket',
  review_document: 'Review document for completeness',
};

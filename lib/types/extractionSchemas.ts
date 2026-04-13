// lib/types/extractionSchemas.ts
// Typed extraction schemas per document type for EightForge OS.
// These drive both heuristic extraction and (later) OpenAI structured prompts.

// ── Shared sub-types ─────────────────────────────────────────────────────────

export type RateTableEntry = {
  material_type: string | null;
  unit: string | null; // "per ton", "per cubic yard", "per mile", "hourly"
  rate_amount: number | null; // parsed numeric value
  rate_raw: string; // original text snippet
};

export type InvoiceLineItem = {
  line_code: string | null;
  line_description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
  billing_rate_key: string | null;
  description_match_key: string | null;
  description?: string | null; // compatibility alias
  total?: number | null; // compatibility alias
  evidence_refs?: string[];
  raw_text?: string | null;
};

export type InvoiceLineItemAnchor = {
  group_index: number;
  line_code: string | null;
  description_match_key: string | null;
  evidence_refs: string[];
  raw_text: string | null;
};

export type InvoiceEvidenceAnchors = {
  invoice_totals_section: string[];
  invoice_number: string[];
  service_period: string[];
  line_item_groups: InvoiceLineItemAnchor[];
};

export type InvoiceRawSections = {
  invoice_number_text: string | null;
  service_period_text: string | null;
  invoice_totals_text: string | null;
};

export type Finding = {
  finding_text: string;
  severity: 'info' | 'warning' | 'critical' | null;
};

// ── Per-document-type schemas ────────────────────────────────────────────────

export type ContractExtraction = {
  schema_type: 'contract';
  vendor_name: string | null;
  contract_date: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  termination_clause: string | null;
  rate_table: RateTableEntry[];
  material_types: string[];
  hauling_rates: string[];
  tipping_fees: string[];
  fema_reference: boolean;
  insurance_requirements: string | null;
  bonding_requirements: string | null;
};

export type InvoiceExtraction = {
  schema_type: 'invoice';
  invoice_number: string | null;
  invoice_status: string | null;
  invoice_date: string | null;
  period_start: string | null;
  period_end: string | null;
  period_through: string | null;
  vendor_name: string | null;
  client_name: string | null;
  line_items: InvoiceLineItem[];
  line_item_count: number | null;
  subtotal_amount: number | null;
  total_amount: number | null;
  current_amount_due?: number | null; // compatibility alias for billed total
  payment_terms: string | null;
  po_number: string | null;
  evidence_anchors?: InvoiceEvidenceAnchors | null;
  raw_sections?: InvoiceRawSections | null;
};

export type ReportExtraction = {
  schema_type: 'report';
  report_type: string | null;
  reporting_period: string | null;
  findings: Finding[];
  metrics: Record<string, string | number> | null;
  compliance_status: string | null;
  author: string | null;
  date: string | null;
};

// ── Discriminated union ──────────────────────────────────────────────────────

export type TypedExtraction =
  | ContractExtraction
  | InvoiceExtraction
  | ReportExtraction;

export type SupportedDocumentType = 'contract' | 'invoice' | 'report';

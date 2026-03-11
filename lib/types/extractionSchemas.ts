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

export type LineItem = {
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  total: number | null;
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
  invoice_date: string | null;
  vendor_name: string | null;
  line_items: LineItem[];
  total_amount: number | null;
  payment_terms: string | null;
  po_number: string | null;
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

// lib/types/extraction.ts
// Canonical shape for extraction contract data passed through the pipeline.

export interface ExtractionContract {
  document_id: string;
  extraction_id: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fields: Record<string, unknown>;
  text_preview: string | null;
  ai_enrichment: Record<string, unknown> | null;
  created_at: string;
}

export type ExtractionKeyFact = {
  label: string;
  value: string | number | boolean | null;
};

export function extractKeyFacts(data: Record<string, unknown>): ExtractionKeyFact[] {
  const facts: ExtractionKeyFact[] = [];
  const fields = (data.fields ?? {}) as Record<string, unknown>;
  const typed = fields.typed_fields as Record<string, unknown> | null | undefined;

  if (typed?.schema_type) {
    facts.push({ label: 'Schema Type', value: String(typed.schema_type) });
  }
  if (typed?.vendor_name) {
    facts.push({ label: 'Vendor', value: String(typed.vendor_name) });
  }
  if (typed?.invoice_number) {
    facts.push({ label: 'Invoice #', value: String(typed.invoice_number) });
  }
  if (typed?.invoice_date) {
    facts.push({ label: 'Invoice Date', value: String(typed.invoice_date) });
  }
  if (typed?.total_amount != null) {
    facts.push({ label: 'Total Amount', value: Number(typed.total_amount) });
  }
  if (typed?.expiration_date) {
    facts.push({ label: 'Expiration', value: String(typed.expiration_date) });
  }
  if (typed?.contract_date) {
    facts.push({ label: 'Contract Date', value: String(typed.contract_date) });
  }
  if (typed?.compliance_status) {
    facts.push({ label: 'Compliance', value: String(typed.compliance_status) });
  }
  if (typed?.report_type) {
    facts.push({ label: 'Report Type', value: String(typed.report_type) });
  }
  if (typed?.payment_terms) {
    facts.push({ label: 'Payment Terms', value: String(typed.payment_terms) });
  }
  if (typed?.fema_reference === true) {
    facts.push({ label: 'FEMA Reference', value: true });
  }

  if (fields.detected_document_type) {
    facts.push({ label: 'Detected Type', value: String(fields.detected_document_type) });
  }

  const extraction = data.extraction as { mode?: string; text_preview?: string } | undefined;
  if (extraction?.mode) {
    facts.push({ label: 'Extraction Mode', value: String(extraction.mode) });
  }

  return facts;
}

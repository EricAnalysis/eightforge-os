import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  ExtractNodeOutput,
  ExtractedNodeDocument,
  NormalizeNodeOutput,
  PipelineFact,
} from '@/lib/pipeline/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[$,]/g, '').trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDisplayValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value == null) return 'Missing';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function evidenceText(evidence: EvidenceObject): string {
  return [evidence.location.label, evidence.text, evidence.value != null ? String(evidence.value) : '']
    .filter(Boolean)
    .join(' | ');
}

function findEvidenceByLabel(
  document: ExtractedNodeDocument,
  labels: string[],
): EvidenceObject[] {
  const normalizedLabels = labels.map(normalizeText);
  return document.evidence.filter((evidence) => {
    const label = normalizeText(evidence.location.label ?? '');
    return normalizedLabels.some((candidate) => label.includes(candidate));
  }).slice(0, 3);
}

function findEvidenceByRegex(
  document: ExtractedNodeDocument,
  regexes: RegExp[],
): { value: string | number | boolean | null; evidence: EvidenceObject[] } | null {
  for (const evidence of document.evidence) {
    const text = evidenceText(evidence);
    if (!text) continue;
    for (const regex of regexes) {
      const candidate = new RegExp(regex.source, regex.flags.includes('i') ? regex.flags : `${regex.flags}i`);
      const match = candidate.exec(text);
      if (!match) continue;
      return {
        value: match[1] ?? match[0] ?? null,
        evidence: [evidence],
      };
    }
  }
  return null;
}

/** Facts whose missing PDF/XLSX citations should surface as extraction gaps (not derived-only metrics). */
const FACT_KEYS_REQUIRING_CITATION = new Set([
  'contractor_name',
  'owner_name',
  'contract_ceiling',
  'rate_schedule_present',
  'executed_date',
  'invoice_number',
  'billed_amount',
  'contractor_name',
  'invoice_date',
  'approved_amount',
  'invoice_reference',
  'recommendation_date',
]);

function factCitationGaps(document: ExtractedNodeDocument, facts: PipelineFact[]): ExtractionGap[] {
  const gaps: ExtractionGap[] = [];
  for (const fact of facts) {
    if (fact.evidence_refs.length > 0) continue;
    if (!FACT_KEYS_REQUIRING_CITATION.has(fact.key)) continue;
    for (let i = 0; i < fact.missing_source_context.length; i++) {
      const note = fact.missing_source_context[i];
      if (!note) continue;
      gaps.push({
        id: `gap:fact:${document.document_id}:${fact.key}:${i}`,
        category: 'missing_fact_citation',
        severity:
          fact.key.includes('ceiling') || fact.key === 'billed_amount' || fact.key === 'approved_amount'
            ? 'warning'
            : 'info',
        message: `${fact.label}: ${note}`,
        source: 'pipeline',
      });
    }
  }
  return gaps;
}

function ticketRowFieldGaps(document: ExtractedNodeDocument): ExtractionGap[] {
  if (document.family !== 'ticket') return [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const ticketExport = asRecord(spreadsheet?.normalized_ticket_export);
  const summary = asRecord(ticketExport?.summary);
  const missingQuantityRows = Number(summary?.missing_quantity_rows ?? 0);
  const missingRateRows = Number(summary?.missing_rate_rows ?? 0);
  const gaps: ExtractionGap[] = [];
  if (missingQuantityRows > 0) {
    gaps.push({
      id: `gap:ticket:quantity:${document.document_id}`,
      category: 'ticket_row_incomplete',
      severity: 'warning',
      message: `${missingQuantityRows} ticket row(s) have no grounded quantity value.`,
      source: 'pipeline',
    });
  }
  if (missingRateRows > 0) {
    gaps.push({
      id: `gap:ticket:rate:${document.document_id}`,
      category: 'ticket_row_incomplete',
      severity: 'warning',
      message: `${missingRateRows} ticket row(s) have no grounded rate value.`,
      source: 'pipeline',
    });
  }
  return gaps;
}

function addFact(
  document: ExtractedNodeDocument,
  facts: PipelineFact[],
  key: string,
  label: string,
  value: unknown,
  evidenceRefs: string[],
  confidence: number,
): void {
  facts.push({
    id: `${document.document_id}:${key}`,
    key,
    label,
    value,
    display_value: toDisplayValue(value),
    confidence,
    evidence_refs: evidenceRefs,
    gap_refs: [],
    missing_source_context: evidenceRefs.length > 0 ? [] : ['No direct source location was captured for this fact.'],
    source_document_id: document.document_id,
    document_family: document.family,
  });
}

function normalizeContract(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTables = asArray<Record<string, unknown>>(asRecord(pdf?.tables)?.tables);
  const contractorEvidence = findEvidenceByLabel(document, ['contractor', 'vendor', 'company']);
  const ownerEvidence = findEvidenceByLabel(document, ['owner', 'county', 'client']);
  const ceilingEvidence = findEvidenceByRegex(document, [
    /(?:not\s+to\s+exceed|nte|maximum\s+contract)[^$0-9]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const executedDateEvidence = findEvidenceByRegex(document, [
    /(?:executed|effective)[^0-9A-Za-z]{0,24}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const contractor = String(
    document.typed_fields.vendor_name ??
    document.structured_fields.contractor_name ??
    contractorEvidence[0]?.value ??
    contractorEvidence[0]?.text ??
    '',
  ).trim() || null;
  const owner = String(
    document.structured_fields.owner_name ??
    ownerEvidence[0]?.value ??
    ownerEvidence[0]?.text ??
    '',
  ).trim() || null;
  const executedDate = String(
    document.typed_fields.contract_date ??
    document.structured_fields.executed_date ??
    executedDateEvidence?.value ??
    '',
  ).trim() || null;
  const ceiling = parseNumber(
    document.typed_fields.nte_amount ??
    document.typed_fields.notToExceedAmount ??
    document.structured_fields.nte_amount ??
    ceilingEvidence?.value ??
    null,
  );
  const rateFromSignals =
    document.section_signals.rate_section_present === true ||
    document.section_signals.unit_price_structure_present === true;
  const rateRowCountFromTables = pdfTables.reduce(
    (sum, table) => sum + asArray<unknown>(table.rows).length,
    0,
  );
  const rateFromTables = rateRowCountFromTables > 0;
  /** Do not infer rates from text_preview alone — Exhibit A / signals / extracted tables only. */
  const rateSchedulePresent = rateFromSignals || rateFromTables;
  const rateRowCount =
    Number(document.section_signals.rate_items_detected ?? 0) || rateRowCountFromTables;
  const ratePagesArray = asArray<number>(document.section_signals.rate_section_pages);
  const ratePages = ratePagesArray.length > 0 ? `pages ${ratePagesArray.join(', ')}` : null;
  const rateTableEvidenceRefs: string[] = [];
  for (const table of pdfTables) {
    const rows = asArray<{ id?: string }>(table.rows);
    if (rows.length === 0) continue;
    if (typeof table.id === 'string') rateTableEvidenceRefs.push(table.id);
    for (const row of rows.slice(0, 32)) {
      if (typeof row.id === 'string') rateTableEvidenceRefs.push(row.id);
    }
  }
  const ratePageEvidenceRefs =
    ratePagesArray.length > 0
      ? document.evidence
          .filter(
            (ev) => typeof ev.location.page === 'number' && ratePagesArray.includes(ev.location.page),
          )
          .map((ev) => ev.id)
      : [];
  const rateEvidenceRefs = [...new Set([...ratePageEvidenceRefs, ...rateTableEvidenceRefs])];
  const timeAndMaterialsPresent =
    document.section_signals.time_and_materials_present === true ||
    /time\s*(?:and|&)\s*materials|t&m/i.test(document.text_preview);

  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidence.map((evidence) => evidence.id), contractor ? 0.84 : 0.42);
  addFact(document, facts, 'owner_name', 'Owner', owner, ownerEvidence.map((evidence) => evidence.id), owner ? 0.8 : 0.38);
  addFact(document, facts, 'executed_date', 'Executed Date', executedDate, executedDateEvidence?.evidence.map((evidence) => evidence.id) ?? [], executedDate ? 0.78 : 0.36);
  addFact(document, facts, 'contract_ceiling', 'Contract Ceiling', ceiling, ceilingEvidence?.evidence.map((evidence) => evidence.id) ?? [], ceiling != null ? 0.86 : 0.44);
  addFact(
    document,
    facts,
    'rate_schedule_present',
    'Rate Schedule Present',
    rateSchedulePresent,
    rateEvidenceRefs,
    rateSchedulePresent ? 0.8 : 0.55,
  );
  addFact(
    document,
    facts,
    'rate_row_count',
    'Rate Rows',
    rateRowCount,
    rateTableEvidenceRefs.slice(0, 48),
    rateRowCount > 0 ? 0.76 : 0.5,
  );
  addFact(
    document,
    facts,
    'rate_schedule_pages',
    'Rate Schedule Pages',
    ratePages,
    rateEvidenceRefs.slice(0, 48),
    ratePages ? 0.74 : 0.45,
  );
  addFact(document, facts, 'time_and_materials_present', 'T&M Present', timeAndMaterialsPresent, [], timeAndMaterialsPresent ? 0.72 : 0.52);

  return {
    facts,
    extracted: {
      contractorName: contractor ?? undefined,
      ownerName: owner ?? undefined,
      executedDate: executedDate ?? undefined,
      notToExceedAmount: ceiling ?? undefined,
      rateSchedulePresent,
      timeAndMaterialsPresent,
    },
  };
}

function normalizeInvoice(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTables = asArray<Record<string, unknown>>(asRecord(pdf?.tables)?.tables);
  const invoiceEvidence = findEvidenceByLabel(document, ['invoice', 'invoice #', 'invoice number']);
  const amountEvidence = findEvidenceByRegex(document, [
    /(?:current\s+amount\s+due|current\s+payment\s+due|total\s+amount|amount\s+due)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const contractorEvidence = findEvidenceByLabel(document, ['vendor', 'contractor', 'payee']);
  const dateEvidence = findEvidenceByRegex(document, [
    /(?:invoice\s+date|date)[^0-9A-Za-z]{0,24}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const invoiceNumber = String(
    document.typed_fields.invoice_number ??
    invoiceEvidence[0]?.value ??
    invoiceEvidence[0]?.text ??
    '',
  ).trim() || null;
  const billedAmount = parseNumber(
    document.typed_fields.current_amount_due ??
    document.typed_fields.currentPaymentDue ??
    document.typed_fields.total_amount ??
    amountEvidence?.value ??
    null,
  );
  const contractor = String(
    document.typed_fields.vendor_name ??
    document.typed_fields.contractorName ??
    contractorEvidence[0]?.value ??
    contractorEvidence[0]?.text ??
    '',
  ).trim() || null;
  const invoiceDate = String(
    document.typed_fields.invoice_date ??
    dateEvidence?.value ??
    '',
  ).trim() || null;
  const lineItems = asArray<unknown>(document.typed_fields.line_items);
  const tableRows = pdfTables
    .reduce((sum, table) => sum + asArray<unknown>(table.rows).length, 0);
  const lineItemCount = lineItems.length > 0 ? lineItems.length : tableRows;
  const lineItemSupportPresent = lineItemCount > 0;
  const lineItemEvidenceIds = document.evidence
    .filter((item) => item.kind === 'table_row')
    .slice(0, 24)
    .map((item) => item.id);

  addFact(document, facts, 'invoice_number', 'Invoice Number', invoiceNumber, invoiceEvidence.map((evidence) => evidence.id), invoiceNumber ? 0.86 : 0.42);
  addFact(document, facts, 'billed_amount', 'Billed Amount', billedAmount, amountEvidence?.evidence.map((evidence) => evidence.id) ?? [], billedAmount != null ? 0.88 : 0.4);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidence.map((evidence) => evidence.id), contractor ? 0.82 : 0.39);
  addFact(document, facts, 'invoice_date', 'Invoice Date', invoiceDate, dateEvidence?.evidence.map((evidence) => evidence.id) ?? [], invoiceDate ? 0.76 : 0.37);
  addFact(
    document,
    facts,
    'line_item_support_present',
    'Line Item Support Present',
    lineItemSupportPresent,
    lineItemEvidenceIds,
    lineItemSupportPresent ? 0.78 : 0.5,
  );
  addFact(
    document,
    facts,
    'line_item_count',
    'Line Item Count',
    lineItemCount,
    lineItemEvidenceIds.slice(0, 8),
    lineItemCount > 0 ? 0.74 : 0.48,
  );

  return {
    facts,
    extracted: {
      invoiceNumber: invoiceNumber ?? undefined,
      contractorName: contractor ?? undefined,
      currentPaymentDue: billedAmount ?? undefined,
      invoiceDate: invoiceDate ?? undefined,
      lineItemCodes: lineItemCount > 0 ? [`${lineItemCount} supported line items`] : undefined,
    },
  };
}

function normalizePaymentRecommendation(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const amountEvidence = findEvidenceByRegex(document, [
    /(?:amount\s+recommended\s+for\s+payment|approved\s+amount|net\s+recommended)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const invoiceRefEvidence = findEvidenceByLabel(document, ['invoice', 'invoice #', 'invoice reference']);
  const contractorEvidence = findEvidenceByLabel(document, ['contractor', 'applicant', 'vendor']);
  const dateEvidence = findEvidenceByRegex(document, [
    /(?:recommendation\s+date|date\s+of\s+invoice|date)[^0-9A-Za-z]{0,24}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const approvedAmount = parseNumber(
    document.typed_fields.approved_amount ??
    document.typed_fields.amountRecommendedForPayment ??
    document.typed_fields.net_recommended_amount ??
    amountEvidence?.value ??
    null,
  );
  const invoiceReference = String(
    document.typed_fields.invoice_number ??
    document.typed_fields.report_reference ??
    invoiceRefEvidence[0]?.value ??
    invoiceRefEvidence[0]?.text ??
    '',
  ).trim() || null;
  const contractor = String(
    document.typed_fields.contractor ??
    document.typed_fields.vendor_name ??
    contractorEvidence[0]?.value ??
    contractorEvidence[0]?.text ??
    '',
  ).trim() || null;
  const recommendationDate = String(
    document.typed_fields.recommendationDate ??
    document.typed_fields.date_of_invoice ??
    dateEvidence?.value ??
    '',
  ).trim() || null;

  addFact(document, facts, 'approved_amount', 'Approved Amount', approvedAmount, amountEvidence?.evidence.map((evidence) => evidence.id) ?? [], approvedAmount != null ? 0.87 : 0.4);
  addFact(document, facts, 'invoice_reference', 'Invoice Reference', invoiceReference, invoiceRefEvidence.map((evidence) => evidence.id), invoiceReference ? 0.82 : 0.41);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidence.map((evidence) => evidence.id), contractor ? 0.8 : 0.39);
  addFact(document, facts, 'recommendation_date', 'Recommendation Date', recommendationDate, dateEvidence?.evidence.map((evidence) => evidence.id) ?? [], recommendationDate ? 0.76 : 0.38);

  return {
    facts,
    extracted: {
      invoiceNumber: invoiceReference ?? undefined,
      approvedAmount: approvedAmount ?? undefined,
      contractorName: contractor ?? undefined,
      recommendationDate: recommendationDate ?? undefined,
    },
  };
}

function spreadsheetEvidenceRefFallback(document: ExtractedNodeDocument): string[] {
  return document.evidence
    .filter((item) => item.kind === 'sheet' || item.kind === 'sheet_row' || item.kind === 'sheet_cell')
    .map((item) => item.id)
    .slice(0, 64);
}

function collectTicketRowEvidenceRefs(rows: Record<string, unknown>[], cap = 72): string[] {
  const refs = new Set<string>();
  for (const row of rows) {
    if (typeof row.evidence_ref === 'string') refs.add(row.evidence_ref);
    const fieldIds = row.field_evidence_ids;
    if (fieldIds != null && typeof fieldIds === 'object' && !Array.isArray(fieldIds)) {
      for (const value of Object.values(fieldIds as Record<string, unknown>)) {
        if (typeof value === 'string') refs.add(value);
      }
    }
    if (refs.size >= cap) break;
  }
  return [...refs];
}

function firstTicketRowMissing(rows: Record<string, unknown>[], field: 'quantity' | 'rate'): Record<string, unknown> | null {
  return (
    rows.find((row) => {
      const missing = row.missing_fields;
      return Array.isArray(missing) && missing.includes(field);
    }) ?? null
  );
}

function ticketRowFieldRefs(row: Record<string, unknown> | null, field: 'quantity' | 'rate'): string[] {
  if (!row) return [];
  const out: string[] = [];
  const fieldIds = row.field_evidence_ids;
  if (fieldIds != null && typeof fieldIds === 'object' && !Array.isArray(fieldIds)) {
    const cellId = (fieldIds as Record<string, unknown>)[field];
    if (typeof cellId === 'string') out.push(cellId);
  }
  if (typeof row.evidence_ref === 'string') out.push(row.evidence_ref);
  return [...new Set(out)];
}

function normalizeTicket(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const ticketExport = asRecord(spreadsheet?.normalized_ticket_export);
  const summary = asRecord(ticketExport?.summary);
  const rows = asArray<Record<string, unknown>>(ticketExport?.rows);
  const rowCount = Number(summary?.row_count ?? rows.length ?? 0);
  const missingQuantityRows = Number(summary?.missing_quantity_rows ?? 0);
  const missingRateRows = Number(summary?.missing_rate_rows ?? 0);
  const invoiceRefs = [...new Set(rows.map((row) => row.invoice_number).filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];

  const fromRows = collectTicketRowEvidenceRefs(rows);
  const fallbackRefs = spreadsheetEvidenceRefFallback(document);
  const workbookRefs = fromRows.length > 0 ? fromRows : fallbackRefs;
  const qtyRow = firstTicketRowMissing(rows, 'quantity');
  const rateRow = firstTicketRowMissing(rows, 'rate');
  const qtyRefs = ticketRowFieldRefs(qtyRow, 'quantity');
  const rateRefs = ticketRowFieldRefs(rateRow, 'rate');

  addFact(
    document,
    facts,
    'ticket_row_count',
    'Ticket Rows',
    rowCount,
    workbookRefs,
    rowCount > 0 ? 0.86 : 0.42,
  );
  addFact(
    document,
    facts,
    'missing_quantity_rows',
    'Missing Quantity Rows',
    missingQuantityRows,
    qtyRefs.length > 0 ? qtyRefs : workbookRefs.slice(0, 12),
    0.78,
  );
  addFact(
    document,
    facts,
    'missing_rate_rows',
    'Missing Rate Rows',
    missingRateRows,
    rateRefs.length > 0 ? rateRefs : workbookRefs.slice(0, 12),
    0.78,
  );
  addFact(
    document,
    facts,
    'ticket_rows',
    'Ticket Rows Detail',
    rows,
    workbookRefs,
    rowCount > 0 ? 0.82 : 0.38,
  );
  addFact(document, facts, 'invoice_references', 'Invoice References', invoiceRefs, [], invoiceRefs.length > 0 ? 0.74 : 0.4);

  return {
    facts,
    extracted: {
      rowCount,
      missingQuantityRows,
      missingRateRows,
      invoiceReferences: invoiceRefs.length > 0 ? invoiceRefs : undefined,
    },
  };
}

function normalizeSpreadsheet(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const workbook = asRecord(spreadsheet?.workbook);
  const sheets = asArray<Record<string, unknown>>(workbook?.sheets);
  addFact(document, facts, 'sheet_count', 'Sheet Count', workbook?.sheet_count ?? sheets.length, [], 0.74);
  addFact(document, facts, 'sheet_names', 'Sheet Names', sheets.map((sheet) => sheet.name), [], 0.74);
  return {
    facts,
    extracted: {
      sheetCount: workbook?.sheet_count ?? sheets.length,
      sheetNames: sheets.map((sheet) => sheet.name),
    },
  };
}

function normalizeDocument(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  switch (document.family) {
    case 'contract':
      return normalizeContract(document);
    case 'invoice':
      return normalizeInvoice(document);
    case 'payment_recommendation':
      return normalizePaymentRecommendation(document);
    case 'ticket':
      return normalizeTicket(document);
    case 'spreadsheet':
      return normalizeSpreadsheet(document);
    default:
      return { facts: [], extracted: document.extracted_record };
  }
}

function factMap(facts: PipelineFact[]): Record<string, PipelineFact> {
  return Object.fromEntries(facts.map((fact) => [fact.key, fact]));
}

export function normalizeNode(input: ExtractNodeOutput): NormalizeNodeOutput {
  const primaryNormalized = normalizeDocument(input.primaryDocument);
  const primaryDocument = {
    ...input.primaryDocument,
    facts: primaryNormalized.facts,
    fact_map: factMap(primaryNormalized.facts),
  };
  const relatedDocuments = input.relatedDocuments.map((document) => {
    const normalized = normalizeDocument(document);
    return {
      ...document,
      facts: normalized.facts,
      fact_map: factMap(normalized.facts),
    };
  });

  const facts = Object.fromEntries(
    primaryDocument.facts.map((fact) => [fact.key, fact.value]),
  );

  const mergedGaps = [
    ...input.gaps,
    ...factCitationGaps(primaryDocument, primaryDocument.facts),
    ...relatedDocuments.flatMap((doc) => factCitationGaps(doc, doc.facts)),
    ...ticketRowFieldGaps(primaryDocument),
    ...relatedDocuments.flatMap(ticketRowFieldGaps),
  ];

  return {
    primaryDocument,
    relatedDocuments,
    evidence: input.evidence,
    gaps: mergedGaps,
    confidence: input.confidence,
    facts,
    extracted: primaryNormalized.extracted,
  };
}

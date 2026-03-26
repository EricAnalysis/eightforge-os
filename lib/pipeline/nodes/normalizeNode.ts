import {
  findEvidenceByValueMatch,
  hasInspectableValue,
} from '@/lib/extraction/evidenceValueMatch';
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

function denseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stringValues(value: unknown): string[] {
  return asArray<unknown>(value)
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter((entry) => entry.length > 0);
}

function tableCellTexts(row: Record<string, unknown>): string[] {
  return asArray<Record<string, unknown>>(row.cells)
    .map((cell) => String(cell.text ?? '').trim())
    .filter((text) => text.length > 0);
}

const RATE_SCHEDULE_TITLE_PATTERNS = [
  'unitprices',
  'unitprice',
  'scheduleofrates',
  'compensationschedule',
  'pricesheet',
  'timeandmaterialsrates',
  'emergencydebrisremovalunitrates',
] as const;

const RATE_CONTEXT_HINT_PATTERNS = [
  'attachment',
  'exhibit',
  'schedule',
  'rate',
  'rates',
  'price',
  'prices',
  'compensation',
  'timeandmaterials',
] as const;

const RATE_DESCRIPTION_HEADERS = [
  'description',
  'service',
  'rate description',
  'labor class',
  'classification',
  'item',
] as const;

const RATE_PRICE_HEADERS = [
  'rate',
  'price',
  'unit price',
  'unit cost',
  'cost',
] as const;

const RATE_UNIT_HEADERS = [
  'unit',
  'uom',
] as const;

const RATE_SUPPORT_HEADERS = [
  'quantity',
  'qty',
  'extension',
  'total',
] as const;

const RATE_UNIT_TOKENS = new Set([
  'cy',
  'cubic yard',
  'tn',
  'ton',
  'tons',
  'ea',
  'each',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'ls',
  'lump sum',
  'ac',
  'acre',
  'acres',
  'lf',
  'linear foot',
  'linear feet',
  'sy',
  'square yard',
  'square yards',
].map(denseText));

function hasDensePattern(values: string[], patterns: readonly string[]): boolean {
  return values.some((value) => patterns.some((pattern) => value.includes(denseText(pattern))));
}

function bestHeaderIndex(headers: string[], patterns: readonly string[]): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;

  headers.forEach((header, index) => {
    const dense = denseText(header);
    for (const pattern of patterns) {
      const densePattern = denseText(pattern);
      if (!dense.includes(densePattern)) continue;
      const score = densePattern.length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  });

  return bestIndex;
}

function isRateValueText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return (
    /^\$?\s*[\d,]+(?:\.\d+)?$/i.test(trimmed) ||
    /^\$?\s*[\d,]+(?:\.\d+)?\s*(?:per|\/)\s*[A-Za-z][A-Za-z .-]*$/i.test(trimmed)
  );
}

function isUnitTokenText(value: string): boolean {
  return RATE_UNIT_TOKENS.has(denseText(value));
}

function looksDescriptionText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (isRateValueText(trimmed) || isUnitTokenText(trimmed)) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const digits = (trimmed.match(/\d/g) ?? []).length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return letters >= 4 && (words >= 2 || letters > digits + 4);
}

function consistentRowShape(rows: string[][]): boolean {
  if (rows.length === 0) return false;
  const widths = rows.map((row) => row.length).filter((width) => width > 0);
  if (widths.length === 0) return false;
  return Math.max(...widths) - Math.min(...widths) <= 1;
}

function columnValues(rows: string[][], index: number): string[] {
  return rows
    .map((row) => row[index] ?? null)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function findColumnIndex(
  rows: string[][],
  predicate: (value: string) => boolean,
  preferredIndex: number | null,
): number | null {
  const rowCount = rows.length;
  const minimumMatches = Math.max(2, Math.min(rowCount, Math.ceil(rowCount * 0.5)));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  if (preferredIndex != null) {
    const preferredValues = columnValues(rows, preferredIndex);
    const preferredMatches = preferredValues.filter(predicate).length;
    if (preferredMatches >= minimumMatches) return preferredIndex;
  }

  let bestIndex: number | null = null;
  let bestMatches = 0;
  for (let index = 0; index < columnCount; index += 1) {
    const values = columnValues(rows, index);
    const matches = values.filter(predicate).length;
    if (matches >= minimumMatches && matches > bestMatches) {
      bestIndex = index;
      bestMatches = matches;
    }
  }
  return bestIndex;
}

function hasDescriptionSupport(rows: string[][], preferredIndex: number | null): number | null {
  return findColumnIndex(rows, looksDescriptionText, preferredIndex);
}

function isRateScheduleTable(table: Record<string, unknown>): boolean {
  const headers = stringValues(table.headers);
  const headerContext = stringValues(table.header_context);
  const denseHeaders = [...headers, ...headerContext].map(denseText);
  const rows = asArray<Record<string, unknown>>(table.rows)
    .map(tableCellTexts)
    .filter((row) => row.length > 0);
  if (rows.length < 2) return false;

  const strongTitleHit = hasDensePattern(denseHeaders, RATE_SCHEDULE_TITLE_PATTERNS);
  const contextHintHit = hasDensePattern(denseHeaders, RATE_CONTEXT_HINT_PATTERNS);
  const descriptionHeaderIndex = bestHeaderIndex(headers, RATE_DESCRIPTION_HEADERS);
  const priceHeaderIndex = bestHeaderIndex(headers, RATE_PRICE_HEADERS);
  const unitHeaderIndex = bestHeaderIndex(headers, RATE_UNIT_HEADERS);
  const supportHeaderHit = bestHeaderIndex(headers, RATE_SUPPORT_HEADERS) != null;
  const priceColumn = findColumnIndex(rows, isRateValueText, priceHeaderIndex);
  const unitColumn = findColumnIndex(rows, isUnitTokenText, unitHeaderIndex);
  const descriptionColumn = hasDescriptionSupport(rows, descriptionHeaderIndex);
  let score = 0;

  if (strongTitleHit) score += 3;
  else if (contextHintHit) score += 1;

  if (descriptionHeaderIndex != null) score += 2;
  if (priceHeaderIndex != null) score += 2;
  if (unitHeaderIndex != null) score += 2;
  if (supportHeaderHit) score += 1;
  if (priceColumn != null) score += 2;
  if (unitColumn != null) score += 2;
  if (descriptionColumn != null) score += 1;
  if (consistentRowShape(rows)) score += 1;
  if (rows.length >= 3) score += 1;

  return (
    score >= 6 &&
    priceColumn != null &&
    (unitColumn != null || strongTitleHit) &&
    (descriptionColumn != null || descriptionHeaderIndex != null || strongTitleHit)
  );
}

function formatPageList(pages: number[]): string | null {
  if (pages.length === 0) return null;
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`;
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

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
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
  'term_start_date',
  'term_end_date',
  'expiration_date',
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

function missingAnchorReason(document: ExtractedNodeDocument, value: unknown): string {
  if (document.evidence.length === 0) {
    return 'No evidence objects were produced for this document (empty parser output).';
  }
  if (!hasInspectableValue(value)) {
    return 'This field has no inspectable value to match against evidence spans.';
  }
  return 'No evidence span matched field labels, regex patterns, or literal field value in the extracted evidence set.';
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
  let refs = [...new Set(evidenceRefs)];
  let resolution: NonNullable<PipelineFact['evidence_resolution']> =
    refs.length > 0 ? 'primary' : 'none';

  if (refs.length === 0 && hasInspectableValue(value)) {
    const fallback = findEvidenceByValueMatch(document.evidence, value);
    refs = fallback.map((evidence) => evidence.id);
    if (refs.length > 0) resolution = 'value_fallback';
  }

  const missingSourceContext = refs.length > 0 ? [] : [missingAnchorReason(document, value)];

  facts.push({
    id: `${document.document_id}:${key}`,
    key,
    label,
    value,
    display_value: toDisplayValue(value),
    confidence,
    evidence_refs: refs,
    gap_refs: [],
    missing_source_context: missingSourceContext,
    source_document_id: document.document_id,
    document_family: document.family,
    evidence_resolution: resolution,
  });
}

function normalizeContract(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTables = asArray<Record<string, unknown>>(asRecord(pdf?.tables)?.tables);
  const contractorEvidence = findEvidenceByLabel(document, ['contractor', 'vendor', 'company']);
  const ownerEvidence = findEvidenceByLabel(document, ['owner', 'county', 'client']);
  const explicitCeilingEvidence = findEvidenceByRegex(document, [
    /(?:\bnot\s+to\s+exceed\b|\bnte\b|\bmaximum\s+amount\b|\bmaximum\s+contract\s+amount\b|\bcontractual\s+limit\b|\bceiling\s+amount\b|\baggregate\s+cap\b)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const labeledCeilingEvidence = findEvidenceByRegex(document, [
    /(?:\bcontract\s+ceiling\b|\bcontract\s+limit\b|\bcontract\s+cap\b|\bceiling\s+for\s+this\s+contract\b|\bmaximum\s+payable\b)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const totalBidEvidence = findEvidenceByRegex(document, [
    /(?:total\s+amount\s+of\s+bid(?:\s+for\s+entire\s+project)?)[^$0-9]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const executedDateEvidence = findEvidenceByRegex(document, [
    /(?:contract\s+execution|executed|effective)[^0-9A-Za-z]{0,24}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);
  const termStartDateEvidence = findEvidenceByRegex(document, [
    /(?:date\s+of\s+availability(?:\s+for\s+this\s+contract)?\s+is)[^0-9A-Za-z]{0,8}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);
  const termEndDateEvidence = findEvidenceByRegex(document, [
    /(?:completion\s+date(?:\s+for\s+this\s+contract)?\s+is)[^0-9A-Za-z]{0,8}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const contractorExplicit =
    document.structured_fields.contractor_name_source === 'explicit_definition';
  const contractorFromStructured = typeof document.structured_fields.contractor_name === 'string'
    && document.structured_fields.contractor_name.trim().length > 0;
  const contractor = firstNonEmptyString(
    document.structured_fields.contractor_name,
    document.typed_fields.vendor_name,
    contractorEvidence[0]?.value,
    contractorEvidence[0]?.text,
  );
  const owner = firstNonEmptyString(
    document.structured_fields.owner_name,
    ownerEvidence[0]?.value,
    ownerEvidence[0]?.text,
  );
  const executedDate = firstNonEmptyString(
    document.structured_fields.executed_date,
    executedDateEvidence?.value,
    document.typed_fields.effective_date,
    document.typed_fields.contract_date,
  );
  const termStartDate = firstNonEmptyString(
    termStartDateEvidence?.value,
    document.structured_fields.term_start_date,
  );
  const termEndDate = firstNonEmptyString(
    termEndDateEvidence?.value,
    document.structured_fields.term_end_date,
  );
  const expirationDate = firstNonEmptyString(
    termEndDate,
    document.structured_fields.expiration_date,
  );
  const selectedCeilingEvidence =
    explicitCeilingEvidence ??
    labeledCeilingEvidence ??
    totalBidEvidence;
  const ceiling = parseNumber(
    selectedCeilingEvidence?.value ??
    document.typed_fields.nte_amount ??
    document.typed_fields.notToExceedAmount ??
    document.structured_fields.nte_amount ??
    null,
  );
  const rateTables = pdfTables.filter(isRateScheduleTable);
  const rateFromSignals =
    document.section_signals.rate_section_present === true ||
    document.section_signals.unit_price_structure_present === true;
  const fallbackTableRowCount = pdfTables.reduce(
    (sum, table) => sum + asArray<unknown>(table.rows).length,
    0,
  );
  const rateRowCountFromTables = rateTables.reduce(
    (sum, table) => sum + asArray<unknown>(table.rows).length,
    0,
  );
  /** Do not infer rates from text_preview alone — Exhibit A / signals / extracted tables only. */
  const rateSchedulePresent = rateTables.length > 0 ? true : rateFromSignals || fallbackTableRowCount > 0;
  const rateRowCount = rateTables.length > 0
    ? rateRowCountFromTables
    : Number(document.section_signals.rate_items_detected ?? 0) || fallbackTableRowCount;
  const ratePagesArray = rateTables.length > 0
    ? [...new Set(
        rateTables
          .map((table) => typeof table.page_number === 'number' ? table.page_number : null)
          .filter((page): page is number => page != null)
          .sort((left, right) => left - right),
      )]
    : asArray<number>(document.section_signals.rate_section_pages);
  const ratePages = formatPageList(ratePagesArray);
  const rateTableEvidenceRefs: string[] = [];
  const tablesForEvidence = rateTables.length > 0 ? rateTables : pdfTables;
  for (const table of tablesForEvidence) {
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

  // When contractor comes from structured extraction, prefer value-based grounding so we anchor to
  // the exact legal name rather than a generic "contractor" mention later in the document.
  const contractorEvidenceRefs = contractorExplicit || contractorFromStructured
    ? []
    : contractorEvidence.map((evidence) => evidence.id);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidenceRefs, contractor ? 0.84 : 0.42);
  addFact(document, facts, 'owner_name', 'Owner', owner, ownerEvidence.map((evidence) => evidence.id), owner ? 0.8 : 0.38);
  addFact(document, facts, 'executed_date', 'Executed Date', executedDate, executedDateEvidence?.evidence.map((evidence) => evidence.id) ?? [], executedDate ? 0.78 : 0.36);
  addFact(document, facts, 'term_start_date', 'Term Start', termStartDate, termStartDateEvidence?.evidence.map((evidence) => evidence.id) ?? [], termStartDate ? 0.76 : 0.42);
  addFact(document, facts, 'term_end_date', 'Term End', termEndDate, termEndDateEvidence?.evidence.map((evidence) => evidence.id) ?? [], termEndDate ? 0.76 : 0.42);
  addFact(document, facts, 'expiration_date', 'Expiration Date', expirationDate, [], expirationDate ? 0.78 : 0.44);
  addFact(document, facts, 'contract_ceiling', 'Contract Ceiling', ceiling, selectedCeilingEvidence?.evidence.map((evidence) => evidence.id) ?? [], ceiling != null ? 0.86 : 0.44);
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
    (rateTableEvidenceRefs.length > 0 ? rateTableEvidenceRefs : rateEvidenceRefs).slice(0, 48),
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

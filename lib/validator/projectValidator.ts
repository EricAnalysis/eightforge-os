import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  inferGoverningDocumentFamily,
  type GoverningDocumentFamily,
} from '@/lib/documentPrecedence';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  buildValidationSummary,
  blockingReasons,
  collectRowIdentityKeys,
  findFactRecords,
  findFirstFactRecord,
  normalizeCode,
  readRowNumber,
  readRowString,
  sortFindings,
  structuredRowEvidenceInput,
  toNumber,
  type InvoiceLineRow,
  type InvoiceRow,
  type LoadTicketRow,
  type MobileTicketRow,
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type StructuredRow,
  type ValidatorDocumentIdsByFamily,
  type ValidatorDocumentRow,
  type ValidatorEvidenceResult,
  type ValidatorExtractionFactRow,
  type ValidatorFactLookups,
  type ValidatorFactRecord,
  type ValidatorFindingResult,
  type ValidatorLegacyExtractionRow,
  type ValidatorProjectRow,
} from '@/lib/validator/shared';
import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import { runIdentityConsistencyRules } from '@/lib/validator/rulePacks/identityConsistency';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import { runTicketIntegrityRules } from '@/lib/validator/rulePacks/ticketIntegrity';
import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import type { ValidationRuleState, ValidationStatus, ValidatorResult } from '@/types/validator';

const PACK_REQUIRED_SOURCES = 'required_sources';
const PACK_IDENTITY_CONSISTENCY = 'identity_consistency';
const PACK_FINANCIAL_INTEGRITY = 'financial_integrity';
const PACK_TICKET_INTEGRITY = 'ticket_integrity';

const PROJECT_SELECT =
  'id, organization_id, name, code, validation_status, validation_summary_json';
const DOCUMENT_SELECT =
  'id, project_id, organization_id, title, name, document_type, created_at, processing_status, processed_at';
const EXTRACTION_FACT_SELECT =
  'document_id, field_key, field_type, field_value_text, field_value_number, field_value_date, field_value_boolean, source, confidence';
const LEGACY_EXTRACTION_SELECT = 'document_id, created_at, data';

const PROJECT_CODE_FACT_KEYS = ['project_code', 'project_number'] as const;
const CONTRACTOR_NAME_FACT_KEYS = ['contractor_name', 'vendor_name'] as const;
const RATE_SCHEDULE_FACT_KEYS = [
  'rate_table',
  'hauling_rates',
  'tipping_fees',
  'rate_schedule_present',
  'rate_section_present',
  'rate_section_pages',
  'rate_items_detected',
  'unit_price_structure_present',
  'rate_units_detected',
  'rate_schedule_pages',
];
const NTE_FACT_KEYS = ['nte_amount', 'contract_ceiling'] as const;

const LOAD_PARENT_KEYS = [
  'mobile_ticket_id',
  'mobile_ticket_number',
  'linked_mobile_ticket_id',
  'parent_ticket_id',
  'parent_ticket_number',
] as const;
const INVOICE_TOTAL_KEYS = ['total_amount', 'invoice_total', 'billed_amount'] as const;
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
] as const;
const INVOICE_LINE_RATE_CODE_KEYS = [
  'rate_code',
  'contract_rate_code',
  'item_code',
  'service_code',
] as const;

type StructuredTable =
  | 'mobile_tickets'
  | 'load_tickets'
  | 'invoices'
  | 'invoice_lines';

type BlobExtractionData = Record<string, unknown> & {
  fields?: {
    typed_fields?: Record<string, unknown> | null;
  };
  extraction?: {
    evidence_v1?: {
      structured_fields?: Record<string, unknown> | null;
      section_signals?: Record<string, unknown> | null;
    };
  };
};

function isMissingTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;

  return error.code === 'PGRST205'
    || error.code === '42P01'
    || (error.message ?? '').toLowerCase().includes('schema cache');
}

function isMissingColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
  columnName: string,
): boolean {
  if (!error) return false;

  const message = (error.message ?? '').toLowerCase();
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    message.includes(`'${columnName.toLowerCase()}'`) ||
    message.includes(columnName.toLowerCase())
  );
}

function emptyFamilyIds(): ValidatorDocumentIdsByFamily {
  return {
    contract: [],
    rate_sheet: [],
    permit: [],
    invoice: [],
    ticket_support: [],
  };
}

function addFamilyDocument(
  idsByFamily: ValidatorDocumentIdsByFamily,
  family: GoverningDocumentFamily | null,
  documentId: string | null,
) {
  if (!family || !documentId) return;

  const existing = idsByFamily[family];
  if (!existing.includes(documentId)) {
    existing.push(documentId);
  }
}

function extractionRowValue(row: ValidatorExtractionFactRow): unknown {
  if (row.field_value_number != null) return row.field_value_number;
  if (row.field_value_boolean != null) return row.field_value_boolean;
  if (row.field_value_date != null) return row.field_value_date;
  if (row.field_value_text != null) return row.field_value_text;
  return null;
}

function makeFactEvidence(
  documentId: string,
  key: string,
  value: unknown,
  note: string,
): ValidatorEvidenceResult {
  return {
    id: `fact:${documentId}:${key}`,
    finding_id: `fact:${documentId}:${key}`,
    evidence_type: 'fact',
    source_document_id: documentId,
    source_page: null,
    fact_id: `${documentId}:${key}`,
    record_id: `${documentId}:${key}`,
    field_name: key,
    field_value:
      typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? null,
    note,
    created_at: '1970-01-01T00:00:00.000Z',
  };
}

function factRecord(params: {
  documentId: string;
  key: string;
  value: unknown;
  source: ValidatorFactRecord['source'];
  fieldType: string | null;
  note: string;
}): ValidatorFactRecord {
  return {
    id: `${params.documentId}:${params.source}:${params.key}`,
    document_id: params.documentId,
    key: params.key,
    value: params.value,
    source: params.source,
    field_type: params.fieldType,
    evidence: [
      makeFactEvidence(
        params.documentId,
        params.key,
        params.value,
        params.note,
      ),
    ],
  };
}

function legacyObject(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

async function loadProject(projectId: string): Promise<ValidatorProjectRow> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('projects')
    .select(PROJECT_SELECT)
    .eq('id', projectId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Project ${projectId} was not found.`);

  return data as ValidatorProjectRow;
}

async function loadProjectDocuments(
  project: ValidatorProjectRow,
): Promise<ValidatorDocumentRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('documents')
    .select(DOCUMENT_SELECT)
    .eq('organization_id', project.organization_id)
    .eq('project_id', project.id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ValidatorDocumentRow[];
}

async function loadExtractionFactRows(
  documentIds: readonly string[],
): Promise<ValidatorExtractionFactRow[]> {
  if (documentIds.length === 0) return [];

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('document_extractions')
    .select(EXTRACTION_FACT_SELECT)
    .in('document_id', [...documentIds])
    .eq('status', 'active')
    .not('field_key', 'is', null);

  if (error) throw new Error(error.message);
  return (data ?? []) as ValidatorExtractionFactRow[];
}

async function loadLegacyExtractionRows(
  documentIds: readonly string[],
): Promise<Map<string, ValidatorLegacyExtractionRow>> {
  const rowsByDocumentId = new Map<string, ValidatorLegacyExtractionRow>();
  if (documentIds.length === 0) return rowsByDocumentId;

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('document_extractions')
    .select(LEGACY_EXTRACTION_SELECT)
    .in('document_id', [...documentIds])
    .is('field_key', null)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  const grouped = new Map<string, ValidatorLegacyExtractionRow[]>();
  for (const row of (data ?? []) as ValidatorLegacyExtractionRow[]) {
    const existing = grouped.get(row.document_id) ?? [];
    existing.push(row);
    grouped.set(row.document_id, existing);
  }

  for (const [documentId, rows] of grouped.entries()) {
    const preferred = pickPreferredExtractionBlob(rows);
    if (preferred) {
      rowsByDocumentId.set(documentId, preferred);
    }
  }

  return rowsByDocumentId;
}

async function loadRuleState(
  projectId: string,
): Promise<Map<string, ValidationRuleState>> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('project_validation_rule_state')
    .select('*')
    .eq('project_id', projectId);

  if (error && isMissingTableError(error)) {
    return new Map<string, ValidationRuleState>();
  }
  if (error) throw new Error(error.message);

  return new Map(
    ((data ?? []) as ValidationRuleState[]).map((row) => [row.rule_id, row]),
  );
}

async function loadStructuredRows(
  table: StructuredTable,
  projectId: string,
): Promise<StructuredRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from(table)
    .select('*')
    .eq('project_id', projectId);

  if (error && isMissingTableError(error)) {
    return [];
  }
  if (error) throw new Error(error.message);

  return (data ?? []) as StructuredRow[];
}

async function loadInvoiceLines(
  projectId: string,
  invoices: readonly InvoiceRow[],
): Promise<InvoiceLineRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const projectQuery = await admin
    .from('invoice_lines')
    .select('*')
    .eq('project_id', projectId);

  if (!projectQuery.error) {
    return (projectQuery.data ?? []) as InvoiceLineRow[];
  }

  if (isMissingTableError(projectQuery.error)) {
    return [];
  }

  if (
    isMissingColumnError(projectQuery.error, 'project_id') &&
    invoices.length > 0
  ) {
    const invoiceIds = invoices
      .map((row) => readRowString(row, ['id', 'invoice_id']))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (invoiceIds.length === 0) return [];

    const invoiceQuery = await admin
      .from('invoice_lines')
      .select('*')
      .in('invoice_id', invoiceIds);

    if (invoiceQuery.error && isMissingTableError(invoiceQuery.error)) {
      return [];
    }
    if (invoiceQuery.error) throw new Error(invoiceQuery.error.message);
    return (invoiceQuery.data ?? []) as InvoiceLineRow[];
  }

  throw new Error(projectQuery.error.message);
}

function buildDocumentIdsByFamily(
  documents: readonly ValidatorDocumentRow[],
  precedenceFamilies: readonly ResolvedDocumentPrecedenceFamily[],
): {
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
} {
  const familyDocumentIds = emptyFamilyIds();
  const governingDocumentIds = emptyFamilyIds();

  for (const family of precedenceFamilies) {
    for (const document of family.documents) {
      addFamilyDocument(familyDocumentIds, family.family, document.id);
    }
    addFamilyDocument(
      governingDocumentIds,
      family.family,
      family.governing_document_id,
    );
  }

  for (const document of documents) {
    const family = inferGoverningDocumentFamily(document);
    addFamilyDocument(familyDocumentIds, family, document.id);
    if (family && governingDocumentIds[family].length === 0) {
      governingDocumentIds[family].push(document.id);
    }
  }

  return { familyDocumentIds, governingDocumentIds };
}

function buildFactsByDocumentId(params: {
  documents: readonly ValidatorDocumentRow[];
  factRows: readonly ValidatorExtractionFactRow[];
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
}): {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  allFacts: ValidatorFactRecord[];
} {
  const factsByDocumentId = new Map<string, ValidatorFactRecord[]>();
  const normalizedByDocumentId = new Map<string, ValidatorExtractionFactRow[]>();

  for (const row of params.factRows) {
    const existing = normalizedByDocumentId.get(row.document_id) ?? [];
    existing.push(row);
    normalizedByDocumentId.set(row.document_id, existing);
  }

  for (const document of params.documents) {
    const facts: ValidatorFactRecord[] = [];
    const normalizedRows = normalizedByDocumentId.get(document.id) ?? [];
    const normalizedKeys = new Set<string>();

    for (const row of normalizedRows) {
      normalizedKeys.add(row.field_key);
      facts.push(
        factRecord({
          documentId: document.id,
          key: row.field_key,
          value: extractionRowValue(row),
          source: 'normalized_row',
          fieldType: row.field_type,
          note: 'Normalized extracted fact row.',
        }),
      );
    }

    const legacyRow = params.legacyRowsByDocumentId.get(document.id);
    const legacyData = legacyObject(legacyRow?.data) as BlobExtractionData;
    const typedFields = legacyObject(legacyData.fields?.typed_fields);
    const structuredFields = legacyObject(
      legacyData.extraction?.evidence_v1?.structured_fields,
    );
    const sectionSignals = legacyObject(
      legacyData.extraction?.evidence_v1?.section_signals,
    );

    for (const [key, value] of Object.entries(structuredFields)) {
      if (normalizedKeys.has(key)) continue;
      facts.push(
        factRecord({
          documentId: document.id,
          key,
          value,
          source: 'legacy_structured_field',
          fieldType: null,
          note: 'Legacy structured extraction field.',
        }),
      );
    }

    for (const [key, value] of Object.entries(typedFields)) {
      if (normalizedKeys.has(key)) continue;
      facts.push(
        factRecord({
          documentId: document.id,
          key,
          value,
          source: 'legacy_typed_field',
          fieldType: null,
          note: 'Legacy typed extraction field.',
        }),
      );
    }

    for (const [key, value] of Object.entries(sectionSignals)) {
      if (normalizedKeys.has(key)) continue;
      facts.push(
        factRecord({
          documentId: document.id,
          key,
          value,
          source: 'legacy_section_signal',
          fieldType: null,
          note: 'Legacy section signal extracted from the document.',
        }),
      );
    }

    factsByDocumentId.set(document.id, facts);
  }

  return {
    factsByDocumentId,
    allFacts: [...factsByDocumentId.values()].flat(),
  };
}

function normalizeRateScheduleItem(
  value: unknown,
  sourceDocumentId: string,
  recordId: string,
): RateScheduleItem | null {
  if (value == null) return null;

  if (typeof value === 'string') {
    return {
      source_document_id: sourceDocumentId,
      record_id: recordId,
      rate_code: null,
      unit_type: null,
      rate_amount: toNumber(value),
      material_type: null,
      description: value,
      raw_value: value,
    };
  }

  if (typeof value === 'number') {
    return {
      source_document_id: sourceDocumentId,
      record_id: recordId,
      rate_code: null,
      unit_type: null,
      rate_amount: value,
      material_type: null,
      description: String(value),
      raw_value: value,
    };
  }

  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  const rateCode = normalizeCode(
    readRowString(row, ['rate_code', 'code', 'item_code', 'service_code']),
  );
  const unitType = readRowString(row, ['unit_type', 'unit', 'uom']);
  const rateAmount = toNumber(
    readRowString(row, ['rate_amount', 'rate_raw'])
      ?? row.rate_amount
      ?? row.rate
      ?? row.amount
      ?? row.price
      ?? row.unit_rate
      ?? null,
  );
  const materialType = readRowString(row, ['material_type', 'material', 'debris_type']);
  const description =
    readRowString(row, ['description', 'name', 'item', 'rate_raw'])
    ?? null;

  if (
    rateCode == null &&
    unitType == null &&
    rateAmount == null &&
    materialType == null &&
    description == null
  ) {
    return null;
  }

  return {
    source_document_id: sourceDocumentId,
    record_id: recordId,
    rate_code: rateCode,
    unit_type: unitType,
    rate_amount: rateAmount,
    material_type: materialType,
    description,
    raw_value: value,
  };
}

function buildRateScheduleItems(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  rateDocumentIds: readonly string[],
): RateScheduleItem[] {
  const items: RateScheduleItem[] = [];
  const scheduleFacts = findFactRecords(
    factsByDocumentId,
    rateDocumentIds,
    ['rate_table', 'hauling_rates', 'tipping_fees'],
  );

  for (const fact of scheduleFacts) {
    const rawValue = fact.value;
    if (Array.isArray(rawValue)) {
      rawValue.forEach((entry, index) => {
        const item = normalizeRateScheduleItem(
          entry,
          fact.document_id,
          `${fact.id}:item:${index + 1}`,
        );
        if (item) items.push(item);
      });
      continue;
    }

    const item = normalizeRateScheduleItem(rawValue, fact.document_id, fact.id);
    if (item) items.push(item);
  }

  return items;
}

function uniqueDocumentIds(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function buildFactLookups(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
}): ValidatorFactLookups {
  const contractFactDocumentIds = uniqueDocumentIds([
    ...params.governingDocumentIds.contract,
    ...params.familyDocumentIds.contract,
  ]);
  const invoiceFactDocumentIds = uniqueDocumentIds([
    ...params.governingDocumentIds.invoice,
    ...params.familyDocumentIds.invoice,
  ]);
  const rateFactDocumentIds = uniqueDocumentIds([
    ...params.governingDocumentIds.contract,
    ...params.governingDocumentIds.rate_sheet,
    ...params.familyDocumentIds.contract,
    ...params.familyDocumentIds.rate_sheet,
  ]);

  const contractProjectCodeFacts = findFactRecords(
    params.factsByDocumentId,
    contractFactDocumentIds,
    PROJECT_CODE_FACT_KEYS,
  );
  const invoiceProjectCodeFacts = findFactRecords(
    params.factsByDocumentId,
    invoiceFactDocumentIds,
    PROJECT_CODE_FACT_KEYS,
  );
  const contractPartyNameFacts = findFactRecords(
    params.factsByDocumentId,
    contractFactDocumentIds,
    CONTRACTOR_NAME_FACT_KEYS,
  );
  const nteFact = findFirstFactRecord(
    params.factsByDocumentId,
    contractFactDocumentIds,
    NTE_FACT_KEYS,
  );
  const rateScheduleFacts = findFactRecords(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_SCHEDULE_FACT_KEYS,
  );
  const rateScheduleItems = buildRateScheduleItems(
    params.factsByDocumentId,
    rateFactDocumentIds,
  );

  const hasRateScheduleFacts = rateScheduleFacts.some((fact) => {
    if (Array.isArray(fact.value)) return fact.value.length > 0;
    if (typeof fact.value === 'boolean') return fact.value;
    const numeric = toNumber(fact.value);
    if (numeric != null) return numeric > 0;
    return fact.value != null;
  });

  return {
    contractProjectCodeFacts,
    invoiceProjectCodeFacts,
    contractPartyNameFacts,
    nteFact,
    rateScheduleFacts,
    rateScheduleItems,
    hasRateScheduleFacts,
  };
}

function buildMobileToLoadsMap(
  loads: readonly LoadTicketRow[],
): Map<string, LoadTicketRow[]> {
  const map = new Map<string, LoadTicketRow[]>();

  for (const load of loads) {
    for (const key of collectRowIdentityKeys(load, LOAD_PARENT_KEYS, {
      includeRowId: false,
    })) {
      const existing = map.get(key) ?? [];
      existing.push(load);
      map.set(key, existing);
    }
  }

  return map;
}

function buildInvoiceLineToRateMap(
  invoiceLines: readonly InvoiceLineRow[],
  rateScheduleItems: readonly RateScheduleItem[],
): Map<string, RateScheduleItem | null> {
  const map = new Map<string, RateScheduleItem | null>();
  const scheduleByCode = new Map<string, RateScheduleItem>();

  for (const item of rateScheduleItems) {
    if (!item.rate_code) continue;
    scheduleByCode.set(item.rate_code, item);
  }

  for (const line of invoiceLines) {
    const lineId = readRowString(line, ['id', 'invoice_line_id', 'line_id'])
      ?? `invoice_line:${map.size + 1}`;
    const rateCode = normalizeCode(
      readRowString(line, INVOICE_LINE_RATE_CODE_KEYS),
    );

    map.set(lineId, rateCode ? scheduleByCode.get(rateCode) ?? null : null);
  }

  return map;
}

function buildProjectTotals(params: {
  invoiceLines: readonly InvoiceLineRow[];
  invoices: readonly InvoiceRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  invoiceDocumentIds: readonly string[];
  mobileTickets: readonly MobileTicketRow[];
  loadTickets: readonly LoadTicketRow[];
}): ProjectTotals {
  const lineTotals = params.invoiceLines
    .map((row) => readRowNumber(row, INVOICE_LINE_TOTAL_KEYS))
    .filter((value): value is number => value != null);

  let billedTotal: number | null = null;
  if (lineTotals.length > 0) {
    billedTotal = lineTotals.reduce((sum, value) => sum + value, 0);
  } else {
    const invoiceTotals = params.invoices
      .map((row) => readRowNumber(row, INVOICE_TOTAL_KEYS))
      .filter((value): value is number => value != null);

    if (invoiceTotals.length > 0) {
      billedTotal = invoiceTotals.reduce((sum, value) => sum + value, 0);
    } else {
      const factTotals = params.invoiceDocumentIds
        .map((documentId) =>
          findFactRecords(params.factsByDocumentId, [documentId], [
            'billed_amount',
            'invoice_total',
            'total_amount',
          ]),
        )
        .map((facts) =>
          facts
            .map((fact) => toNumber(fact.value))
            .find((value): value is number => value != null)
            ?? null,
        )
        .filter((value): value is number => value != null);

      if (factTotals.length > 0) {
        billedTotal = factTotals.reduce((sum, value) => sum + value, 0);
      }
    }
  }

  return {
    billed_total: billedTotal,
    invoice_count:
      params.invoices.length > 0
        ? params.invoices.length
        : params.invoiceDocumentIds.length,
    invoice_line_count: params.invoiceLines.length,
    mobile_ticket_count: params.mobileTickets.length,
    load_ticket_count: params.loadTickets.length,
  };
}

async function loadValidatorInput(projectId: string): Promise<ProjectValidatorInput> {
  const project = await loadProject(projectId);
  const documents = await loadProjectDocuments(project);
  const documentIds = documents.map((document) => document.id);
  const [factRows, legacyRowsByDocumentId, ruleStateByRuleId, mobileTickets, loadTickets, invoices] =
    await Promise.all([
      loadExtractionFactRows(documentIds),
      loadLegacyExtractionRows(documentIds),
      loadRuleState(projectId),
      loadStructuredRows('mobile_tickets', projectId),
      loadStructuredRows('load_tickets', projectId),
      loadStructuredRows('invoices', projectId),
    ]);

  const invoiceLines = await loadInvoiceLines(projectId, invoices as InvoiceRow[]);

  let precedenceFamilies: ResolvedDocumentPrecedenceFamily[] = [];
  let documentRelationships: DocumentRelationshipRecord[] = [];
  try {
    const precedenceSnapshot = await loadProjectDocumentPrecedenceSnapshot(
      getSupabaseAdmin()!,
      {
        organizationId: project.organization_id,
        projectId,
      },
    );
    precedenceFamilies = precedenceSnapshot.families;
    documentRelationships = precedenceSnapshot.relationships;
  } catch {
    precedenceFamilies = [];
    documentRelationships = [];
  }

  const { familyDocumentIds, governingDocumentIds } = buildDocumentIdsByFamily(
    documents,
    precedenceFamilies,
  );
  const { factsByDocumentId, allFacts } = buildFactsByDocumentId({
    documents,
    factRows,
    legacyRowsByDocumentId,
  });
  const factLookups = buildFactLookups({
    factsByDocumentId,
    familyDocumentIds,
    governingDocumentIds,
  });
  const mobileToLoadsMap = buildMobileToLoadsMap(loadTickets as LoadTicketRow[]);
  const invoiceLineToRateMap = buildInvoiceLineToRateMap(
    invoiceLines as InvoiceLineRow[],
    factLookups.rateScheduleItems,
  );
  const projectTotals = buildProjectTotals({
    invoiceLines: invoiceLines as InvoiceLineRow[],
    invoices: invoices as InvoiceRow[],
    factsByDocumentId,
    invoiceDocumentIds: familyDocumentIds.invoice,
    mobileTickets: mobileTickets as MobileTicketRow[],
    loadTickets: loadTickets as LoadTicketRow[],
  });

  return {
    project,
    documents,
    documentRelationships,
    precedenceFamilies,
    familyDocumentIds,
    governingDocumentIds,
    ruleStateByRuleId,
    factsByDocumentId,
    allFacts,
    mobileTickets: mobileTickets as MobileTicketRow[],
    loadTickets: loadTickets as LoadTicketRow[],
    invoices: invoices as InvoiceRow[],
    invoiceLines: invoiceLines as InvoiceLineRow[],
    mobileToLoadsMap,
    invoiceLineToRateMap,
    projectTotals,
    factLookups,
  };
}

function finalizeResult(
  findings: readonly ValidatorFindingResult[],
  rulesApplied: readonly string[],
): ValidatorResult {
  const orderedFindings = sortFindings(findings);
  const blockedReasons = blockingReasons(orderedFindings);
  const openFindings = orderedFindings.filter((finding) => finding.status === 'open');

  const status: ValidationStatus =
    blockedReasons.length > 0
      ? 'BLOCKED'
      : openFindings.length === 0
        ? 'VALIDATED'
        : 'FINDINGS_OPEN';

  return {
    status,
    blocked_reasons: blockedReasons,
    findings: orderedFindings,
    summary: buildValidationSummary(orderedFindings, status),
    rulesApplied: [...rulesApplied],
  };
}

export async function validateProject(projectId: string): Promise<ValidatorResult> {
  const input = await loadValidatorInput(projectId);
  const findings: ValidatorFindingResult[] = [];
  const rulesApplied: string[] = [];

  try {
    const requiredSourceFindings = runRequiredSourcesRules(input);
    findings.push(...requiredSourceFindings);
    rulesApplied.push(PACK_REQUIRED_SOURCES);

    const requiredSourcesBlocked = blockingReasons(requiredSourceFindings).length > 0;
    if (requiredSourcesBlocked) {
      // Required source gaps gate the heavier downstream packs, so stop here
      // and return the blocked result without running financial or ticket checks.
      return finalizeResult(findings, rulesApplied);
    }
  } catch {
    rulesApplied.push(`${PACK_REQUIRED_SOURCES}:failed`);
  }

  const packRunners: Array<{
    id: string;
    run: (input: ProjectValidatorInput) => ValidatorFindingResult[];
  }> = [
    {
      id: PACK_IDENTITY_CONSISTENCY,
      run: runIdentityConsistencyRules,
    },
    {
      id: PACK_FINANCIAL_INTEGRITY,
      run: runFinancialIntegrityRules,
    },
    {
      id: PACK_TICKET_INTEGRITY,
      run: runTicketIntegrityRules,
    },
  ];

  for (const pack of packRunners) {
    try {
      findings.push(...pack.run(input));
      rulesApplied.push(pack.id);
    } catch {
      rulesApplied.push(`${pack.id}:failed`);
    }
  }

  return finalizeResult(findings, rulesApplied);
}

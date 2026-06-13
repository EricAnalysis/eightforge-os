import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { analyzeContractIntelligence } from '@/lib/contracts/analyzeContractIntelligence';
import {
  inferGoverningDocumentFamily,
  type GoverningDocumentFamily,
} from '@/lib/documentPrecedence';
import { buildCanonicalInvoiceRowsFromTypedFields } from '@/lib/invoices/invoiceParser';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getTransactionDataForProject } from '@/lib/server/transactionDataPersistence';
import {
  buildProjectReconciliationSummary,
  buildValidatorReconciliationContext,
  buildValidatorTransactionRollups,
  emptyValidatorTransactionRollups,
} from '@/lib/validator/reconciliation';
import { evaluateProjectExposure } from '@/lib/validator/exposure';
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
  stringifyValue,
  toBoolean,
  toNumber,
  type InvoiceLineRow,
  type InvoiceRow,
  type LoadTicketRow,
  type MobileTicketRow,
  type ProjectTotals,
  type ValidatorContractAnalysisContext,
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
import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForRateScheduleItem,
  indexRateScheduleItemsByCanonicalKeys,
  matchRateScheduleItemForInvoiceLine,
  readServiceItemFromScheduleRow,
} from '@/lib/validator/billingKeys';
import { evaluateContractInvoiceReconciliation } from '@/lib/validator/rulePacks/contractInvoiceReconciliation';
import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import { evaluateInvoiceTransactionReconciliation } from '@/lib/validator/rulePacks/invoiceTransactionReconciliation';
import { runIdentityConsistencyRules } from '@/lib/validator/rulePacks/identityConsistency';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import { runTicketIntegrityRules } from '@/lib/validator/rulePacks/ticketIntegrity';
import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { PipelineFact, NormalizedNodeDocument } from '@/lib/pipeline/types';
import type {
  ContractInvoiceReconciliationSummary,
  InvoiceTransactionReconciliationSummary,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationRuleState,
  ValidationStatus,
  ValidatorResult,
} from '@/types/validator';

const PACK_REQUIRED_SOURCES = 'required_sources';
const PACK_IDENTITY_CONSISTENCY = 'identity_consistency';
const PACK_CONTRACT_INVOICE_RECONCILIATION = 'contract_invoice_reconciliation';
const PACK_INVOICE_TRANSACTION_RECONCILIATION = 'invoice_transaction_reconciliation';
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
  'rate_row_count',
  'rate_section_present',
  'rate_section_pages',
  'rate_items_detected',
  'unit_price_structure_present',
  'rate_units_detected',
  'rate_schedule_pages',
];
const NTE_FACT_KEYS = ['nte_amount', 'contract_ceiling'] as const;
const CONTRACT_CEILING_TYPE_FACT_KEYS = ['contract_ceiling_type'] as const;
const RATE_SCHEDULE_PRESENT_FACT_KEYS = [
  'rate_schedule_present',
  'rate_section_present',
  'unit_price_structure_present',
] as const;
const RATE_ROW_COUNT_FACT_KEYS = ['rate_row_count', 'rate_items_detected'] as const;
const RATE_SCHEDULE_PAGES_FACT_KEYS = ['rate_schedule_pages', 'rate_section_pages'] as const;
const RATE_UNITS_DETECTED_FACT_KEYS = ['rate_units_detected'] as const;
const TIME_AND_MATERIALS_FACT_KEYS = ['time_and_materials_present'] as const;

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
  'line_code',
  'service_item_code',
] as const;
const INVOICE_LINE_DESCRIPTION_KEYS = [
  'description',
  'rate_description',
  'item_description',
  'line_description',
  'service_item',
  'service_description',
  'name',
  'item',
  'rate_raw',
] as const;
const INVOICE_LINE_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'] as const;
const INVOICE_LINE_SERVICE_ITEM_KEYS = [
  'service_item',
  'service_item_code',
  'line_service_item',
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
    text_preview?: string | null;
    evidence_v1?: {
      structured_fields?: Record<string, unknown> | null;
      section_signals?: Record<string, unknown> | null;
      page_text?: Array<{
        page_number?: number | null;
        text?: string | null;
      }> | null;
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

function factValueAsStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => factValueAsStringArray(entry));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }

  return [];
}

function syntheticEvidenceFromLegacyExtraction(
  documentId: string,
  legacyData: BlobExtractionData,
): EvidenceObject[] {
  const pageText = legacyData.extraction?.evidence_v1?.page_text ?? [];
  const pageEvidence = pageText.flatMap((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
    if (!text) return [];

    return [{
      id: `${documentId}:page_text:${entry.page_number ?? index + 1}`,
      kind: 'text' as const,
      source_type: 'pdf' as const,
      description: 'Legacy page text evidence',
      text,
      location: {
        page:
          typeof entry.page_number === 'number' && Number.isFinite(entry.page_number)
            ? entry.page_number
            : undefined,
        nearby_text: text.slice(0, 240),
      },
      confidence: 0.7,
      weak: false,
      source_document_id: documentId,
      metadata: {
        source_extraction_path: 'legacy_page_text',
      },
    }];
  });

  if (pageEvidence.length > 0) return pageEvidence;

  const preview = legacyData.extraction?.text_preview?.trim() ?? '';
  if (!preview) return [];

  return [{
    id: `${documentId}:text_preview`,
    kind: 'text',
    source_type: 'pdf',
    description: 'Legacy extraction text preview',
    text: preview,
    location: {
      nearby_text: preview.slice(0, 240),
    },
    confidence: 0.55,
    weak: true,
    source_document_id: documentId,
    metadata: {
      source_extraction_path: 'legacy_text_preview',
    },
  }];
}

function pipelineFactFromValidatorFact(params: {
  fact: ValidatorFactRecord;
  documentFamily: NormalizedNodeDocument['family'];
  machineClassification?: string | null;
}): PipelineFact {
  return {
    id: params.fact.id,
    key: params.fact.key,
    label: params.fact.key,
    value: params.fact.value,
    display_value: stringifyValue(params.fact.value) ?? '',
    confidence: 1,
    evidence_refs: [],
    gap_refs: [],
    missing_source_context: [],
    source_document_id: params.fact.document_id,
    document_family: params.documentFamily,
    ...(params.machineClassification != null
      ? { machine_classification: params.machineClassification }
      : {}),
  };
}

function buildSyntheticContractDocument(params: {
  document: ValidatorDocumentRow;
  facts: ValidatorFactRecord[];
  legacyRow: ValidatorLegacyExtractionRow | null;
}): NormalizedNodeDocument | null {
  const legacyData = legacyObject(params.legacyRow?.data) as BlobExtractionData;
  const typedFields = legacyObject(legacyData.fields?.typed_fields);
  const structuredFields = legacyObject(
    legacyData.extraction?.evidence_v1?.structured_fields,
  );
  const sectionSignals = legacyObject(
    legacyData.extraction?.evidence_v1?.section_signals,
  );
  const textPreview =
    legacyData.extraction?.text_preview
    ?? syntheticEvidenceFromLegacyExtraction(params.document.id, legacyData)
      .map((evidence) => evidence.text ?? '')
      .join(' ')
      .trim();
  if (!textPreview && params.facts.length === 0) {
    return null;
  }

  const contractCeilingType = params.facts.find((fact) => fact.key === 'contract_ceiling_type') ?? null;
  const pipelineFacts = params.facts.map((fact) =>
    pipelineFactFromValidatorFact({
      fact,
      documentFamily: 'contract',
      machineClassification:
        fact.key === 'contract_ceiling'
        && fact.value == null
        && contractCeilingType?.value === 'rate_based'
          ? 'rate_price_no_ceiling'
          : null,
    }),
  );

  const factMap = Object.fromEntries(
    pipelineFacts.map((fact) => [fact.key, fact] as const),
  );
  const evidence = syntheticEvidenceFromLegacyExtraction(params.document.id, legacyData);

  return {
    document_id: params.document.id,
    document_type: params.document.document_type ?? 'contract',
    document_name: params.document.name,
    document_title: params.document.title,
    family: 'contract',
    is_primary: true,
    extraction_data: legacyData,
    typed_fields: typedFields,
    structured_fields: structuredFields,
    section_signals: sectionSignals,
    text_preview: textPreview ?? '',
    evidence,
    gaps: [],
    confidence: 1,
    content_layers: null,
    extracted_record: {},
    facts: pipelineFacts,
    fact_map: factMap,
  };
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
    const description = value;
    const keys = deriveBillingKeysForRateScheduleItem({
      rate_code: null,
      description,
      material_type: null,
      unit_type: null,
    });
    return {
      source_document_id: sourceDocumentId,
      record_id: recordId,
      rate_code: null,
      unit_type: null,
      rate_amount: toNumber(value),
      material_type: null,
      description,
      raw_value: value,
      ...keys,
    };
  }

  if (typeof value === 'number') {
    const description = String(value);
    const keys = deriveBillingKeysForRateScheduleItem({
      rate_code: null,
      description,
      material_type: null,
      unit_type: null,
    });
    return {
      source_document_id: sourceDocumentId,
      record_id: recordId,
      rate_code: null,
      unit_type: null,
      rate_amount: value,
      material_type: null,
      description,
      raw_value: value,
      ...keys,
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
  const serviceItem = readServiceItemFromScheduleRow(row);
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: rateCode,
    description,
    material_type: materialType,
    unit_type: unitType,
    service_item: serviceItem,
  });

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
    service_item: serviceItem,
    raw_value: value,
    ...keys,
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

function findExistingInvoiceRow(
  invoices: readonly InvoiceRow[],
  candidate: InvoiceRow,
): InvoiceRow | null {
  const candidateDocumentId = readRowString(candidate, ['source_document_id', 'document_id']);
  const candidateInvoiceNumber = normalizeCode(
    readRowString(candidate, ['invoice_number', 'invoice_no', 'number']),
  );

  return invoices.find((row) => {
    const rowDocumentId = readRowString(row, ['source_document_id', 'document_id']);
    if (candidateDocumentId && rowDocumentId === candidateDocumentId) {
      return true;
    }

    const rowInvoiceNumber = normalizeCode(
      readRowString(row, ['invoice_number', 'invoice_no', 'number']),
    );
    return candidateInvoiceNumber != null
      && rowInvoiceNumber != null
      && candidateInvoiceNumber === rowInvoiceNumber;
  }) ?? null;
}

function synthesizeInvoicesFromLegacyExtractions(params: {
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
  invoiceDocumentIds: readonly string[];
  existingInvoices: readonly InvoiceRow[];
  existingInvoiceLines: readonly InvoiceLineRow[];
}): {
  invoices: InvoiceRow[];
  invoiceLines: InvoiceLineRow[];
} {
  const invoices: InvoiceRow[] = [];
  const invoiceLines: InvoiceLineRow[] = [];
  const existingInvoiceDocumentIds = new Set(
    params.existingInvoices
      .map((row) => readRowString(row, ['source_document_id', 'document_id']))
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  const existingInvoiceLineDocumentIds = new Set(
    params.existingInvoiceLines
      .map((row) => readRowString(row, ['source_document_id', 'document_id']))
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );

  for (const documentId of params.invoiceDocumentIds) {
    const legacyRow = params.legacyRowsByDocumentId.get(documentId) ?? null;
    const legacyData = legacyObject(legacyRow?.data) as BlobExtractionData;
    const typedFields = legacyObject(legacyData.fields?.typed_fields);
    if (Object.keys(typedFields).length === 0) continue;

    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId,
      typedFields,
    });
    const syntheticInvoiceRow = canonical.invoiceRow as InvoiceRow | null;
    const matchedInvoiceRow = syntheticInvoiceRow
      ? findExistingInvoiceRow(params.existingInvoices, syntheticInvoiceRow)
      : null;
    const resolvedInvoiceId =
      readRowString(matchedInvoiceRow ?? {}, ['id', 'invoice_id'])
      ?? readRowString(syntheticInvoiceRow ?? {}, ['id', 'invoice_id'])
      ?? `typed:${documentId}:invoice`;

    if (
      syntheticInvoiceRow
      && !matchedInvoiceRow
      && !existingInvoiceDocumentIds.has(documentId)
    ) {
      invoices.push(syntheticInvoiceRow);
      existingInvoiceDocumentIds.add(documentId);
    }

    if (canonical.invoiceLines.length > 0 && !existingInvoiceLineDocumentIds.has(documentId)) {
      canonical.invoiceLines.forEach((line) => {
        invoiceLines.push({
          ...line,
          invoice_id: resolvedInvoiceId,
        });
      });
      existingInvoiceLineDocumentIds.add(documentId);
    }
  }

  return { invoices, invoiceLines };
}

function firstBooleanFactValue(fact: ValidatorFactRecord | null): boolean | null {
  return fact ? toBoolean(fact.value) : null;
}

function firstStringArrayFactValue(fact: ValidatorFactRecord | null): string[] {
  return fact ? factValueAsStringArray(fact.value) : [];
}

function buildContractValidationContext(params: {
  documents: readonly ValidatorDocumentRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
}): ValidatorContractAnalysisContext | null {
  const contractDocumentId = uniqueDocumentIds([
    ...params.governingDocumentIds.contract,
    ...params.familyDocumentIds.contract,
  ])[0] ?? null;
  if (!contractDocumentId) return null;

  const document = params.documents.find((candidate) => candidate.id === contractDocumentId) ?? null;
  if (!document) return null;

  const syntheticDocument = buildSyntheticContractDocument({
    document,
    facts: params.factsByDocumentId.get(contractDocumentId) ?? [],
    legacyRow: params.legacyRowsByDocumentId.get(contractDocumentId) ?? null,
  });
  if (!syntheticDocument) return null;

  const analysis = analyzeContractIntelligence({
    primaryDocument: syntheticDocument,
    relatedDocuments: [],
  });
  if (!analysis) return null;

  return {
    document_id: contractDocumentId,
    analysis,
    evidence_by_id: new Map(
      syntheticDocument.evidence.map((evidence) => [evidence.id, evidence] as const),
    ),
  };
}

function buildFactLookups(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  contractValidationContext: ValidatorContractAnalysisContext | null;
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
  const contractCeilingTypeFact = findFirstFactRecord(
    params.factsByDocumentId,
    contractFactDocumentIds,
    CONTRACT_CEILING_TYPE_FACT_KEYS,
  );
  const rateSchedulePresentFact = findFirstFactRecord(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_SCHEDULE_PRESENT_FACT_KEYS,
  );
  const rateRowCountFact = findFirstFactRecord(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_ROW_COUNT_FACT_KEYS,
  );
  const rateSchedulePagesFact = findFirstFactRecord(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_SCHEDULE_PAGES_FACT_KEYS,
  );
  const rateUnitsDetectedFact = findFirstFactRecord(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_UNITS_DETECTED_FACT_KEYS,
  );
  const timeAndMaterialsPresentFact = findFirstFactRecord(
    params.factsByDocumentId,
    rateFactDocumentIds,
    TIME_AND_MATERIALS_FACT_KEYS,
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
    contractDocumentId: params.contractValidationContext?.document_id ?? contractFactDocumentIds[0] ?? null,
    contractCeilingTypeFact,
    contractCeilingType:
      typeof contractCeilingTypeFact?.value === 'string'
        ? contractCeilingTypeFact.value
        : typeof params.contractValidationContext?.analysis.pricing_model.contract_ceiling_type?.value === 'string'
          ? params.contractValidationContext.analysis.pricing_model.contract_ceiling_type.value
          : null,
    rateSchedulePresentFact,
    rateSchedulePresent: firstBooleanFactValue(rateSchedulePresentFact),
    rateRowCountFact,
    rateRowCount: toNumber(rateRowCountFact?.value ?? null),
    rateSchedulePagesFact,
    rateSchedulePagesDisplay: stringifyValue(rateSchedulePagesFact?.value ?? null),
    rateUnitsDetectedFact,
    rateUnitsDetected: firstStringArrayFactValue(rateUnitsDetectedFact),
    timeAndMaterialsPresentFact,
    timeAndMaterialsPresent: firstBooleanFactValue(timeAndMaterialsPresentFact) === true,
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
  const scheduleIndex = indexRateScheduleItemsByCanonicalKeys(rateScheduleItems);

  for (const line of invoiceLines) {
    const lineId = readRowString(line, ['id', 'invoice_line_id', 'line_id'])
      ?? `invoice_line:${map.size + 1}`;
    const rateCode = readRowString(line, INVOICE_LINE_RATE_CODE_KEYS);
    const description = readRowString(line, INVOICE_LINE_DESCRIPTION_KEYS);
    const serviceItem = readRowString(line, INVOICE_LINE_SERVICE_ITEM_KEYS);
    const material = readRowString(line, INVOICE_LINE_MATERIAL_KEYS);
    const canonicalKeys = deriveBillingKeysForInvoiceLine({
      rate_code: rateCode,
      description,
      service_item: serviceItem,
      material,
    });

    map.set(
      lineId,
      matchRateScheduleItemForInvoiceLine(
        {
          rate_code: rateCode,
          description,
          service_item: serviceItem,
          material,
          billing_rate_key: canonicalKeys.billing_rate_key,
          description_match_key: canonicalKeys.description_match_key,
          unit_price: readRowNumber(line, [
            'billed_rate',
            'unit_rate',
            'rate',
            'price',
            'contract_rate',
            'unit_price',
            'bill_rate',
            'rate_amount',
            'amount_per_unit',
            'unit_cost',
            'uom_rate',
            'rate_raw',
          ]),
        },
        scheduleIndex,
      ).match,
    );
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

function deriveWorkspaceOverviewFinancials(
  input: ProjectValidatorInput,
  exposure: ProjectExposureSummary | null,
): { nte_amount: number | null; total_billed: number | null } {
  const nte_amount = toNumber(input.factLookups.nteFact?.value);
  const total_billed =
    exposure != null && Number.isFinite(exposure.total_billed_amount)
      ? exposure.total_billed_amount
      : input.projectTotals.billed_total;
  return { nte_amount, total_billed };
}

async function loadValidatorInput(projectId: string): Promise<ProjectValidatorInput> {
  const project = await loadProject(projectId);
  const documents = await loadProjectDocuments(project);
  const documentIds = documents.map((document) => document.id);
  const [
    factRows,
    legacyRowsByDocumentId,
    ruleStateByRuleId,
    mobileTickets,
    loadTickets,
    invoices,
    transactionData,
  ] =
    await Promise.all([
      loadExtractionFactRows(documentIds),
      loadLegacyExtractionRows(documentIds),
      loadRuleState(projectId),
      loadStructuredRows('mobile_tickets', projectId),
      loadStructuredRows('load_tickets', projectId),
      loadStructuredRows('invoices', projectId),
      getTransactionDataForProject(projectId),
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
  const syntheticInvoices = synthesizeInvoicesFromLegacyExtractions({
    legacyRowsByDocumentId,
    invoiceDocumentIds: uniqueDocumentIds([
      ...governingDocumentIds.invoice,
      ...familyDocumentIds.invoice,
    ]),
    existingInvoices: invoices as InvoiceRow[],
    existingInvoiceLines: invoiceLines as InvoiceLineRow[],
  });
  const effectiveInvoices = [
    ...(invoices as InvoiceRow[]),
    ...syntheticInvoices.invoices,
  ];
  const effectiveInvoiceLines = [
    ...(invoiceLines as InvoiceLineRow[]),
    ...syntheticInvoices.invoiceLines,
  ];
  const { factsByDocumentId, allFacts } = buildFactsByDocumentId({
    documents,
    factRows,
    legacyRowsByDocumentId,
  });
  const contractValidationContext = buildContractValidationContext({
    documents,
    factsByDocumentId,
    legacyRowsByDocumentId,
    familyDocumentIds,
    governingDocumentIds,
  });
  const factLookups = buildFactLookups({
    factsByDocumentId,
    contractValidationContext,
    familyDocumentIds,
    governingDocumentIds,
  });
  const mobileToLoadsMap = buildMobileToLoadsMap(loadTickets as LoadTicketRow[]);
  const invoiceLineToRateMap = buildInvoiceLineToRateMap(
    effectiveInvoiceLines,
    factLookups.rateScheduleItems,
  );
  const validatorTransactionData = transactionData
    ? {
      ...transactionData,
      rollups: buildValidatorTransactionRollups(transactionData),
    }
    : {
      datasets: [],
      rows: [],
      rollups: emptyValidatorTransactionRollups(),
    };
  const projectTotals = buildProjectTotals({
    invoiceLines: effectiveInvoiceLines,
    invoices: effectiveInvoices,
    factsByDocumentId,
    invoiceDocumentIds: familyDocumentIds.invoice,
    mobileTickets: mobileTickets as MobileTicketRow[],
    loadTickets: loadTickets as LoadTicketRow[],
  });
  const baseInput = {
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
    invoices: effectiveInvoices,
    invoiceLines: effectiveInvoiceLines,
    mobileToLoadsMap,
    invoiceLineToRateMap,
    projectTotals,
    factLookups,
    contractValidationContext,
    transactionData: validatorTransactionData,
  } satisfies ProjectValidatorInput;
  const reconciliationContext = buildValidatorReconciliationContext(baseInput);

  return {
    ...baseInput,
    reconciliationContext,
  };
}

function finalizeResult(
  findings: readonly ValidatorFindingResult[],
  rulesApplied: readonly string[],
  options: {
    contractInvoiceReconciliation?: ContractInvoiceReconciliationSummary | null;
    invoiceTransactionReconciliation?: InvoiceTransactionReconciliationSummary | null;
    reconciliation?: ProjectReconciliationSummary | null;
    exposure?: ProjectExposureSummary | null;
    overviewFinancials?: { nte_amount: number | null; total_billed: number | null };
  } = {},
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
  const summary = buildValidationSummary(orderedFindings, status, {
    contractInvoiceReconciliation: options.contractInvoiceReconciliation ?? null,
    invoiceTransactionReconciliation: options.invoiceTransactionReconciliation ?? null,
    reconciliation: options.reconciliation ?? null,
    exposure: options.exposure ?? null,
    nte_amount: options.overviewFinancials?.nte_amount ?? null,
    total_billed: options.overviewFinancials?.total_billed ?? null,
  });

  return {
    status,
    blocked_reasons: blockedReasons,
    findings: orderedFindings,
    summary,
    rulesApplied: [...rulesApplied],
    validator_status: summary.validator_status,
    validator_open_items: summary.validator_open_items,
    validator_blockers: summary.validator_blockers,
    contract_invoice_reconciliation: summary.contract_invoice_reconciliation ?? null,
    invoice_transaction_reconciliation: summary.invoice_transaction_reconciliation ?? null,
    reconciliation: summary.reconciliation ?? null,
    exposure: summary.exposure ?? null,
  };
}

export async function validateProject(projectId: string): Promise<ValidatorResult> {
  const input = await loadValidatorInput(projectId);
  const findings: ValidatorFindingResult[] = [];
  const rulesApplied: string[] = [];
  let contractInvoiceReconciliation: ContractInvoiceReconciliationSummary | null = null;
  let invoiceTransactionReconciliation: InvoiceTransactionReconciliationSummary | null = null;
  let reconciliation: ProjectReconciliationSummary | null = buildProjectReconciliationSummary({
    reconciliationContext: input.reconciliationContext ?? null,
    contractInvoiceReconciliation,
    invoiceTransactionReconciliation,
  });
  let exposure: ProjectExposureSummary | null = null;

  try {
    const requiredSourceFindings = runRequiredSourcesRules(input);
    findings.push(...requiredSourceFindings);
    rulesApplied.push(PACK_REQUIRED_SOURCES);

    const requiredSourcesBlocked = blockingReasons(requiredSourceFindings).length > 0;
    if (requiredSourcesBlocked) {
      const exposureResult = evaluateProjectExposure(input, findings);
      findings.push(...exposureResult.findings);
      exposure = exposureResult.summary;
      // Required source gaps gate the heavier downstream packs, so stop here
      // and return the blocked result without running financial or ticket checks.
      return finalizeResult(findings, rulesApplied, {
        contractInvoiceReconciliation,
        invoiceTransactionReconciliation,
        reconciliation,
        exposure,
        overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
      });
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
      id: PACK_CONTRACT_INVOICE_RECONCILIATION,
      run: (packInput) => {
        const result = evaluateContractInvoiceReconciliation(packInput);
        contractInvoiceReconciliation = result.summary;
        reconciliation = buildProjectReconciliationSummary({
          reconciliationContext: packInput.reconciliationContext ?? null,
          contractInvoiceReconciliation,
          invoiceTransactionReconciliation,
        });
        return result.findings;
      },
    },
    {
      id: PACK_INVOICE_TRANSACTION_RECONCILIATION,
      run: (packInput) => {
        const result = evaluateInvoiceTransactionReconciliation(packInput);
        invoiceTransactionReconciliation = result.summary;
        reconciliation = buildProjectReconciliationSummary({
          reconciliationContext: packInput.reconciliationContext ?? null,
          contractInvoiceReconciliation,
          invoiceTransactionReconciliation,
        });
        return result.findings;
      },
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

  const exposureResult = evaluateProjectExposure(input, findings);
  findings.push(...exposureResult.findings);
  exposure = exposureResult.summary;

  return finalizeResult(findings, rulesApplied, {
    contractInvoiceReconciliation,
    invoiceTransactionReconciliation,
    reconciliation,
    exposure,
    overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
  });
}

import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { analyzeContractIntelligence } from '@/lib/contracts/analyzeContractIntelligence';
import { loadContractUploadGuidanceForDocument } from '@/lib/contracts/contractUploadGuidance';
import {
  assembleContractPricingRows,
  canonicalTaxonomyKeyForAllowedCategory,
} from '@/lib/contracts/contractPricingAssembly';
import {
  inferGoverningDocumentFamily,
  resolveDocumentTruthCategoryIds,
  type GoverningDocumentFamily,
} from '@/lib/documentPrecedence';
import { buildCanonicalInvoiceRowsFromTypedFields } from '@/lib/invoices/invoiceParser';
import { collapseEffectiveFactRecords } from '@/lib/effectiveFacts';
import type { ContractAnalysisResult, ContractRateScheduleRow } from '@/lib/contracts/types';
import {
  isDocumentFactOverridesTableUnavailableError,
  type DocumentFactOverrideRow,
} from '@/lib/documentFactOverrides';
import {
  isDocumentFactReviewsTableUnavailableError,
  type DocumentFactReviewRow,
} from '@/lib/documentFactReviews';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { getCanonicalInvoicesForProject } from '@/lib/server/invoicePersistence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getCanonicalTransactionDataForProject } from '@/lib/server/transactionDataPersistence';
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
  rowIdentifier,
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
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';
import { evaluateContractInvoiceReconciliation } from '@/lib/validator/rulePacks/contractInvoiceReconciliation';
import { evaluateCrossDocumentRateVerification } from '@/lib/validator/rulePacks/crossDocumentRateVerification';
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
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';
import type {
  ContractInvoiceReconciliationSummary,
  InvoiceTransactionReconciliationSummary,
  CrossDocumentRateVerificationSummary,
  ProjectValidationPhase,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationRuleState,
  ValidationStatus,
  ValidatorResult,
} from '@/types/validator';
import { isBlockingFinding } from '@/lib/validator/findingSemantics';

const PACK_REQUIRED_SOURCES = 'required_sources';
const PACK_IDENTITY_CONSISTENCY = 'identity_consistency';
const PACK_CONTRACT_INVOICE_RECONCILIATION = 'contract_invoice_reconciliation';
const PACK_INVOICE_TRANSACTION_RECONCILIATION = 'invoice_transaction_reconciliation';
const PACK_CROSS_DOCUMENT_RATE_VERIFICATION = 'cross_document_rate_verification';
const PACK_FINANCIAL_INTEGRITY = 'financial_integrity';
const PACK_TICKET_INTEGRITY = 'ticket_integrity';

const PROJECT_SELECT =
  'id, organization_id, name, code, validation_status, validation_summary_json, validation_phase';
const LEGACY_PROJECT_SELECT =
  'id, organization_id, name, code, validation_status, validation_summary_json';
export const VALIDATOR_DOCUMENT_SELECT =
  'id, project_id, organization_id, title, name, document_type, created_at, processing_status, operational_status, processed_at, intelligence_trace';
const EXTRACTION_FACT_SELECT =
  'document_id, field_key, field_type, field_value_text, field_value_number, field_value_date, field_value_boolean, source, confidence';
const LEGACY_EXTRACTION_SELECT = 'document_id, created_at, data';

const PROJECT_CODE_FACT_KEYS = ['project_code', 'project_number'] as const;
const CONTRACTOR_NAME_FACT_KEYS = ['contractor_name', 'vendor_name'] as const;
const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
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
const INVOICE_LINE_QUANTITY_KEYS = [
  'quantity',
  'qty',
  'units',
  'volume',
  'cubic_yards',
  'tons',
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

type PersistedDocumentExecutionTrace = Partial<DocumentExecutionTrace> & Record<string, unknown>;

export type InvoiceLineRateLinkRow = {
  id: string;
  organization_id: string;
  project_id: string;
  invoice_document_id: string;
  invoice_line_subject_id: string;
  contract_document_id: string;
  contract_rate_row_id: string;
  rate_row_description: string | null;
  rate_row_unit_type: string | null;
  rate_row_rate_amount: number | string | null;
  reason: string | null;
  created_at: string | null;
  is_active: boolean;
  superseded_by: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

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

function isInvoiceLineRateLinksTableUnavailableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205') return true;
  if (code === '42P01' && msg.includes('invoice_line_rate_links')) return true;
  if (!msg.includes('invoice_line_rate_links')) return false;

  return (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
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

function readPersistedProjectTotalBilled(validationSummary: unknown): number | null {
  const summary = asRecord(validationSummary);
  const exposure = asRecord(summary?.exposure);

  return (
    toNumber(summary?.total_billed ?? summary?.totalBilled ?? null)
    ?? toNumber(exposure?.total_billed_amount ?? exposure?.totalBilledAmount ?? null)
  );
}

function persistedDocumentTrace(
  document: Pick<ValidatorDocumentRow, 'intelligence_trace'>,
): PersistedDocumentExecutionTrace | null {
  const trace = asRecord(document.intelligence_trace);
  return trace ? (trace as PersistedDocumentExecutionTrace) : null;
}

function isCanonicalContractDocument(
  document: Pick<ValidatorDocumentRow, 'document_type' | 'intelligence_trace'>,
  trace: PersistedDocumentExecutionTrace | null = persistedDocumentTrace(document),
): boolean {
  if (document.document_type?.trim().toLowerCase() === 'contract') {
    return true;
  }

  const classification = asRecord(trace?.classification);
  return classification?.family === 'contract';
}

function isCanonicalRateAuthorityDocument(
  document: Pick<ValidatorDocumentRow, 'document_type' | 'intelligence_trace'>,
  trace: PersistedDocumentExecutionTrace | null = persistedDocumentTrace(document),
): boolean {
  if (isCanonicalContractDocument(document, trace)) return true;

  const classification = asRecord(trace?.classification);
  if (classification?.family === 'rate_sheet' || classification?.family === 'pricing') {
    return true;
  }

  const documentType = document.document_type?.trim().toLowerCase().replace(/[_-]+/g, ' ') ?? '';
  return /(?:rate|price|pricing).*(?:sheet|schedule)|(?:sheet|schedule).*(?:rate|price|pricing)/.test(documentType);
}

function isPricingAuthorityDocument(
  document: Pick<ValidatorDocumentRow, 'title' | 'name' | 'document_type' | 'intelligence_trace'> | null,
): boolean {
  if (!document) return false;
  if (isCanonicalRateAuthorityDocument(document)) return true;

  const label = [
    document.title,
    document.name,
    document.document_type,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  return /\b(?:price|pricing|rate)\s+(?:sheet|schedule)\b|\b(?:sheet|schedule)\s+(?:price|pricing|rate)\b/.test(label);
}

export function extractCanonicalContractFacts(
  document: Pick<ValidatorDocumentRow, 'id' | 'document_type' | 'intelligence_trace'>,
): Array<{ key: string; value: unknown }> {
  const trace = persistedDocumentTrace(document);
  if (!trace || !isCanonicalRateAuthorityDocument(document, trace)) {
    return [];
  }

  const facts = asRecord(trace.facts);
  if (!facts) {
    return [];
  }

  return Object.entries(facts)
    .filter(([key, value]) => key.trim().length > 0 && value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value }));
}

function traceEvidenceEntries(trace: PersistedDocumentExecutionTrace): EvidenceObject[] {
  if (!Array.isArray(trace.evidence)) {
    return [];
  }

  return trace.evidence.filter((entry): entry is EvidenceObject => {
    const record = asRecord(entry);
    return record != null && typeof record.id === 'string';
  });
}

function rateRowEvidenceText(row: ContractRateScheduleRow): string | null {
  const textParts = [
    row.raw_text,
    ...(Array.isArray(row.raw_cells) ? row.raw_cells : []),
    row.rate_raw,
  ].flatMap((part) => {
    if (typeof part !== 'string') return [];
    const trimmed = part.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });

  return textParts.length > 0 ? textParts.join(' | ') : null;
}

function rateRowEvidenceConfidence(row: ContractRateScheduleRow): number {
  if (row.confidence === 'high') return 0.9;
  if (row.confidence === 'medium') return 0.75;
  if (row.confidence === 'needs_review') return 0.45;
  return 0.7;
}

function evidenceKindForRateRow(row: ContractRateScheduleRow): EvidenceObject['kind'] {
  return row.source_kind === 'exhibit_a_text_recovery' ? 'text' : 'table_row';
}

function buildRateRowEvidenceById(
  documentId: string,
  rows: readonly ContractRateScheduleRow[] | null | undefined,
): Map<string, EvidenceObject> {
  const evidenceById = new Map<string, EvidenceObject>();
  if (!Array.isArray(rows)) return evidenceById;

  for (const row of rows) {
    const anchorIds = Array.isArray(row.source_anchor_ids) ? row.source_anchor_ids : [];
    const text = rateRowEvidenceText(row);
    const confidence = rateRowEvidenceConfidence(row);

    for (const anchorId of anchorIds) {
      const id = typeof anchorId === 'string' ? anchorId.trim() : '';
      if (!id || evidenceById.has(id)) continue;

      evidenceById.set(id, {
        id,
        kind: evidenceKindForRateRow(row),
        source_type: 'pdf',
        description: 'Persisted contract rate row evidence',
        text: text ?? undefined,
        value: row.rate_amount ?? row.rate ?? null,
        location: {
          page: row.page ?? undefined,
          nearby_text: text?.slice(0, 240),
        },
        confidence,
        weak: row.confidence === 'needs_review',
        source_document_id: documentId,
        metadata: {
          row_id: row.row_id,
          source_anchor_id: id,
          source_kind: row.source_kind ?? null,
        },
      });
    }
  }

  return evidenceById;
}

export function buildPersistedContractValidationContextFromTrace(
  document: Pick<ValidatorDocumentRow, 'id' | 'document_type' | 'intelligence_trace'>,
): ValidatorContractAnalysisContext | null {
  const trace = persistedDocumentTrace(document);
  if (!trace || !isCanonicalContractDocument(document, trace)) {
    return null;
  }

  const analysis = asRecord(trace.contract_analysis);
  if (!analysis) {
    return null;
  }

  const evidence = traceEvidenceEntries(trace);
  return {
    document_id: document.id,
    analysis: analysis as unknown as ContractAnalysisResult,
    evidence_by_id: new Map(
      evidence.map((entry) => [entry.id, entry] as const),
    ),
  };
}

function isInactiveAuthorityStatus(status: string | null | undefined): boolean {
  return status === 'superseded' || status === 'archived';
}

const VALIDATION_EXCLUDED_RELATIONSHIP_TYPES = new Set([
  'supersedes',
  'replaces',
  'voided',
]);

export function buildExcludedValidationDocumentIds(params: {
  precedenceFamilies: readonly ResolvedDocumentPrecedenceFamily[];
  documentRelationships: readonly DocumentRelationshipRecord[];
}): Set<string> {
  const excluded = new Set<string>();

  for (const family of params.precedenceFamilies) {
    if (family.family !== 'invoice') continue;
    for (const document of family.documents) {
      if (isInactiveAuthorityStatus(document.authority_status ?? null)) {
        excluded.add(document.id);
      }
    }
  }

  for (const relationship of params.documentRelationships) {
    const relationshipType = relationship.relationship_type?.trim().toLowerCase() ?? '';
    if (!VALIDATION_EXCLUDED_RELATIONSHIP_TYPES.has(relationshipType)) continue;
    const targetDocumentId = relationship.target_document_id?.trim();
    if (targetDocumentId) excluded.add(targetDocumentId);
  }

  return excluded;
}

export function resolveValidationInvoiceScope<TInvoice extends StructuredRow, TLine extends StructuredRow>(params: {
  invoices: readonly TInvoice[];
  invoiceLines: readonly TLine[];
  excludedDocumentIds: ReadonlySet<string>;
}): { invoices: TInvoice[]; invoiceLines: TLine[] } {
  const shouldKeep = (row: StructuredRow) => {
    const documentId = readRowString(row, ['source_document_id', 'document_id']);
    return documentId == null || !params.excludedDocumentIds.has(documentId);
  };

  return {
    invoices: params.invoices.filter(shouldKeep),
    invoiceLines: params.invoiceLines.filter(shouldKeep),
  };
}

function activeInvoiceDocumentIds(
  documents: readonly ValidatorDocumentRow[],
  excludedDocumentIds: ReadonlySet<string>,
): string[] {
  return uniqueDocumentIds(
    documents
      .filter((document) => document.document_type === 'invoice')
      .map((document) => document.id)
      .filter((documentId) => !excludedDocumentIds.has(documentId)),
  );
}

function resolveProjectValidationPhase(value: unknown): ProjectValidationPhase {
  return value === 'execution'
    || value === 'billing_review'
    || value === 'closeout'
    || value === 'contract_setup'
    ? value
    : 'contract_setup';
}

export function buildPersistedContractValidationContextFromProjectSummary(
  validationSummary: unknown,
): ValidatorContractAnalysisContext | null {
  const summary = asRecord(validationSummary);
  const rawContext =
    asRecord(summary?.contract_validation_context)
    ?? asRecord(summary?.contractValidationContext);
  const documentId =
    typeof rawContext?.document_id === 'string' && rawContext.document_id.trim().length > 0
      ? rawContext.document_id.trim()
      : typeof rawContext?.documentId === 'string' && rawContext.documentId.trim().length > 0
        ? rawContext.documentId.trim()
        : null;
  const analysis = asRecord(rawContext?.analysis);
  const relationshipContext = asRecord(rawContext?.relationship_context);

  if (!documentId || !analysis) {
    return null;
  }

  const analysisResult = analysis as unknown as ContractAnalysisResult;
  return {
    document_id: documentId,
    analysis: analysisResult,
    evidence_by_id: buildRateRowEvidenceById(documentId, analysisResult.rate_schedule_rows),
    relationship_context: relationshipContext
      ? {
          pricing_document_ids: factValueAsStringArray(relationshipContext.pricing_document_ids),
          compliance_document_ids: factValueAsStringArray(relationshipContext.compliance_document_ids),
          amendment_document_ids: factValueAsStringArray(relationshipContext.amendment_document_ids),
        }
      : undefined,
  };
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

  if (error && isMissingColumnError(error, 'validation_phase')) {
    const legacy = await admin
      .from('projects')
      .select(LEGACY_PROJECT_SELECT)
      .eq('id', projectId)
      .maybeSingle();

    if (legacy.error) throw new Error(legacy.error.message);
    if (!legacy.data) throw new Error(`Project ${projectId} was not found.`);
    return {
      ...(legacy.data as ValidatorProjectRow),
      validation_phase: 'contract_setup',
    };
  }

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
    .select(VALIDATOR_DOCUMENT_SELECT)
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

async function loadDocumentFactOverrides(
  documentIds: readonly string[],
): Promise<DocumentFactOverrideRow[]> {
  if (documentIds.length === 0) return [];

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('document_fact_overrides')
    .select(
      'id, organization_id, document_id, field_key, value_json, raw_value, action_type, reason, created_by, created_at, is_active, supersedes_override_id',
    )
    .in('document_id', [...documentIds])
    .order('created_at', { ascending: false });

  if (error && isDocumentFactOverridesTableUnavailableError(error)) {
    return [];
  }
  if (error) throw new Error(error.message);

  return (data ?? []) as DocumentFactOverrideRow[];
}

export function buildManualRateLinkOverrides(params: {
  rows: readonly InvoiceLineRateLinkRow[];
  rateScheduleItems: readonly RateScheduleItem[];
}): Map<string, RateScheduleItem> {
  const overrides = new Map<string, RateScheduleItem>();
  const rowsByLineKey = new Map<string, InvoiceLineRateLinkRow[]>();
  const rateItemsByRecordId = new Map(
    params.rateScheduleItems.map((item) => [item.record_id, item] as const),
  );

  for (const row of params.rows) {
    const lineKey = [
      row.organization_id,
      row.project_id,
      row.invoice_line_subject_id,
    ].join('|');
    const existing = rowsByLineKey.get(lineKey) ?? [];
    existing.push(row);
    rowsByLineKey.set(lineKey, existing);
  }

  for (const [lineKey, rows] of rowsByLineKey.entries()) {
    if (rows.length > 1) {
      console.error('[projectValidator] multiple active invoice_line_rate_links rows for invoice line', {
        lineKey,
        linkIds: rows.map((row) => row.id),
      });
      continue;
    }

    const row = rows[0];
    if (!row) continue;

    const matchedRateItem = rateItemsByRecordId.get(row.contract_rate_row_id) ?? null;
    if (matchedRateItem) {
      overrides.set(row.invoice_line_subject_id, {
        ...matchedRateItem,
        match_source_kind: 'manual_link',
        manual_link_resolution: 'record_id_match',
        manual_rate_link_id: row.id,
        manual_rate_link_invoice_line_subject_id: row.invoice_line_subject_id,
        manual_rate_link_contract_rate_row_id: row.contract_rate_row_id,
        manual_rate_link_reason: row.reason,
        manual_rate_link_created_at: row.created_at,
      });
      continue;
    }

    const suppliedRateAmount = toNumber(row.rate_row_rate_amount);
    const description = typeof row.rate_row_description === 'string' && row.rate_row_description.trim().length > 0
      ? row.rate_row_description.trim()
      : null;
    const unitType = typeof row.rate_row_unit_type === 'string' && row.rate_row_unit_type.trim().length > 0
      ? row.rate_row_unit_type.trim()
      : null;
    const missingFields = [
      description == null ? 'rate_row_description' : null,
      unitType == null ? 'rate_row_unit_type' : null,
      suppliedRateAmount == null ? 'rate_row_rate_amount' : null,
    ].filter((field): field is string => field != null);

    if (missingFields.length > 0) {
      console.error('[projectValidator] active invoice_line_rate_links row has insufficient operator-supplied rate data', {
        linkId: row.id,
        invoiceLineSubjectId: row.invoice_line_subject_id,
        contractRateRowId: row.contract_rate_row_id,
        missingFields,
      });
      continue;
    }

    const keys = deriveBillingKeysForRateScheduleItem({
      rate_code: null,
      description,
      material_type: null,
      unit_type: unitType,
    });
    overrides.set(row.invoice_line_subject_id, {
      source_document_id: row.contract_document_id,
      record_id: row.contract_rate_row_id,
      rate_code: null,
      unit_type: unitType,
      rate_amount: suppliedRateAmount,
      material_type: null,
      description,
      raw_value: {
        source: 'invoice_line_rate_links',
        link_id: row.id,
        row_id: row.contract_rate_row_id,
        description,
        unit_type: unitType,
        rate_amount: suppliedRateAmount,
      },
      ...keys,
      match_source_kind: 'manual_link',
      manual_link_resolution: 'operator_supplied',
      manual_rate_link_id: row.id,
      manual_rate_link_invoice_line_subject_id: row.invoice_line_subject_id,
      manual_rate_link_contract_rate_row_id: row.contract_rate_row_id,
      manual_rate_link_reason: row.reason,
      manual_rate_link_created_at: row.created_at,
    });
  }

  return overrides;
}

export async function loadManualRateLinkOverrides(params: {
  project: Pick<ValidatorProjectRow, 'id' | 'organization_id'>;
  rateScheduleItems: readonly RateScheduleItem[];
}): Promise<Map<string, RateScheduleItem>> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('invoice_line_rate_links')
    .select(
      'id, organization_id, project_id, invoice_document_id, invoice_line_subject_id, contract_document_id, contract_rate_row_id, rate_row_description, rate_row_unit_type, rate_row_rate_amount, reason, created_at, is_active, superseded_by',
    )
    .eq('organization_id', params.project.organization_id)
    .eq('project_id', params.project.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error && isInvoiceLineRateLinksTableUnavailableError(error)) {
    return new Map<string, RateScheduleItem>();
  }
  if (error) throw new Error(error.message);

  return buildManualRateLinkOverrides({
    rows: (data ?? []) as InvoiceLineRateLinkRow[],
    rateScheduleItems: params.rateScheduleItems,
  });
}

export async function loadDocumentFactReviews(
  documentIds: readonly string[],
): Promise<DocumentFactReviewRow[]> {
  if (documentIds.length === 0) return [];

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('document_fact_reviews')
    .select(
      'id, organization_id, document_id, field_key, review_status, reviewed_value_json, reviewed_by, reviewed_at, notes',
    )
    .in('document_id', [...documentIds])
    .order('reviewed_at', { ascending: false });

  if (error && isDocumentFactReviewsTableUnavailableError(error)) {
    return [];
  }
  if (error) throw new Error(error.message);

  return (data ?? []) as DocumentFactReviewRow[];
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

export function buildDocumentIdsByFamily(
  documents: readonly ValidatorDocumentRow[],
  precedenceFamilies: readonly ResolvedDocumentPrecedenceFamily[],
  documentRelationships: readonly DocumentRelationshipRecord[] = [],
): {
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
} {
  const familyDocumentIds = emptyFamilyIds();
  const governingDocumentIds = emptyFamilyIds();
  const precedenceDocumentIds = new Set<string>();
  const documentById = new Map(documents.map((document) => [document.id, document] as const));

  for (const family of precedenceFamilies) {
    for (const document of family.documents) {
      precedenceDocumentIds.add(document.id);
    }
    const preferredDocuments = family.documents.filter(
      (document) => !isInactiveAuthorityStatus(document.authority_status ?? null),
    );
    const selectedDocuments = preferredDocuments.length > 0
      ? preferredDocuments
      : family.documents;

    for (const document of selectedDocuments) {
      addFamilyDocument(familyDocumentIds, family.family, document.id);
    }
    addFamilyDocument(
      governingDocumentIds,
      family.family,
      family.governing_document_id,
    );
  }

  for (const document of documents) {
    if (precedenceDocumentIds.has(document.id)) continue;
    const family = inferGoverningDocumentFamily(document);
    addFamilyDocument(familyDocumentIds, family, document.id);
    if (family && governingDocumentIds[family].length === 0) {
      governingDocumentIds[family].push(document.id);
    }
  }

  const resolvedTruthCategoryDocumentIds = resolveDocumentTruthCategoryIds({
    families: precedenceFamilies,
    relationships: documentRelationships,
  });
  const attachedPricingDocumentIds = uniqueDocumentIds(
    documentRelationships.flatMap((relationship) => {
      const relationshipType = relationship.relationship_type?.trim().toLowerCase() ?? '';
      if (relationshipType !== 'attached_to') return [];
      const sourceDocument = documentById.get(relationship.source_document_id) ?? null;
      return isPricingAuthorityDocument(sourceDocument) ? [relationship.source_document_id] : [];
    }),
  );
  const attachedPricingDocumentIdSet = new Set(attachedPricingDocumentIds);
  const contractIdentityDocumentIds = resolvedTruthCategoryDocumentIds.contract_identity.filter(
    (documentId) => !attachedPricingDocumentIdSet.has(documentId),
  );

  return {
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds: {
      ...resolvedTruthCategoryDocumentIds,
      contract_identity: contractIdentityDocumentIds.length > 0
        ? contractIdentityDocumentIds
        : resolvedTruthCategoryDocumentIds.contract_identity,
      pricing: uniqueDocumentIds([
        ...attachedPricingDocumentIds,
        ...resolvedTruthCategoryDocumentIds.pricing,
      ]),
    },
  };
}

function buildFactsByDocumentId(params: {
  documents: readonly ValidatorDocumentRow[];
  factRows: readonly ValidatorExtractionFactRow[];
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
  overrideRows: readonly DocumentFactOverrideRow[];
  reviewRows: readonly DocumentFactReviewRow[];
}): {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  allFacts: ValidatorFactRecord[];
} {
  const factsByDocumentId = new Map<string, ValidatorFactRecord[]>();
  const normalizedByDocumentId = new Map<string, ValidatorExtractionFactRow[]>();
  const overridesByDocumentId = new Map<string, DocumentFactOverrideRow[]>();
  const reviewsByDocumentId = new Map<string, DocumentFactReviewRow[]>();

  for (const row of params.factRows) {
    const existing = normalizedByDocumentId.get(row.document_id) ?? [];
    existing.push(row);
    normalizedByDocumentId.set(row.document_id, existing);
  }

  for (const row of params.overrideRows) {
    const existing = overridesByDocumentId.get(row.document_id) ?? [];
    existing.push(row);
    overridesByDocumentId.set(row.document_id, existing);
  }

  for (const row of params.reviewRows) {
    const existing = reviewsByDocumentId.get(row.document_id) ?? [];
    existing.push(row);
    reviewsByDocumentId.set(row.document_id, existing);
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

    for (const canonicalFact of extractCanonicalContractFacts(document)) {
      facts.push(
        factRecord({
          documentId: document.id,
          key: canonicalFact.key,
          value: canonicalFact.value,
          source: 'canonical_contract_intelligence',
          fieldType: null,
          note: 'Canonical persisted contract intelligence fact.',
        }),
      );
    }

    const reviewsByField = new Map<string, DocumentFactReviewRow[]>();
    for (const row of reviewsByDocumentId.get(document.id) ?? []) {
      const existing = reviewsByField.get(row.field_key) ?? [];
      existing.push(row);
      reviewsByField.set(row.field_key, existing);
    }

    for (const [fieldKey, reviews] of reviewsByField.entries()) {
      const latest = reviews[0] ?? null;
      if (
        latest == null
        || (latest.review_status !== 'corrected' && latest.review_status !== 'confirmed')
        || latest.reviewed_value_json == null
      ) {
        continue;
      }

      const note = latest.notes && latest.notes.trim().length > 0
        ? `Human-reviewed fact: ${latest.notes.trim()}`
        : latest.review_status === 'corrected'
          ? 'Human-reviewed fact correction.'
          : 'Human-confirmed fact value.';
      facts.push(
        factRecord({
          documentId: document.id,
          key: fieldKey,
          value: latest.reviewed_value_json,
          source: 'human_review',
          fieldType: null,
          note,
        }),
      );
    }

    const overridesByField = new Map<string, DocumentFactOverrideRow[]>();
    for (const row of overridesByDocumentId.get(document.id) ?? []) {
      const existing = overridesByField.get(row.field_key) ?? [];
      existing.push(row);
      overridesByField.set(row.field_key, existing);
    }

    for (const [fieldKey, overrides] of overridesByField.entries()) {
      const activeOverride = overrides.find((override) => override.is_active) ?? null;
      if (!activeOverride) continue;

      const note = activeOverride.reason && activeOverride.reason.trim().length > 0
        ? `Human fact override: ${activeOverride.reason.trim()}`
        : 'Human fact override.';
      facts.push(
        factRecord({
          documentId: document.id,
          key: fieldKey,
          value: activeOverride.value_json,
          source: 'human_override',
          fieldType: null,
          note,
        }),
      );
    }

    factsByDocumentId.set(document.id, collapseEffectiveFactRecords(facts));
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
  const sourceCategory = readRowString(row, ['source_category', 'category', 'material_type', 'material', 'debris_type']);
  const description =
    readRowString(row, ['description', 'name', 'item', 'rate_raw'])
    ?? null;
  const serviceItem = readServiceItemFromScheduleRow(row);
  const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(
    readRowString(row, ['category']),
  );
  const categoryResolution = resolveCanonicalRateCategory({
    sourceCategory,
    sourceDescriptors: [description, serviceItem, readRowString(row, ['rate_raw', 'raw_text'])],
    existingCanonicalCategory:
      assemblerCategoryKey ?? readRowString(row, ['canonical_category']),
    existingConfidence: assemblerCategoryKey ? 1 : toNumber(row.category_confidence),
  });
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
    source_category: sourceCategory,
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    source_kind: readRowString(row, ['source_kind']),
    source_quality: readRowString(row, ['source_quality']),
    confidence: readRowString(row, ['confidence', 'state']),
    raw_value: value,
    ...keys,
  };
}

export function buildRateScheduleItems(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  rateDocumentIds: readonly string[];
  contractValidationContext: ValidatorContractAnalysisContext | null;
}): RateScheduleItem[] {
  const items: RateScheduleItem[] = [];
  const seen = new Set<string>();

  const pushItem = (item: RateScheduleItem | null) => {
    if (!item) return;

    const key = [
      item.source_document_id,
      item.billing_rate_key ?? '',
      item.description_match_key ?? '',
      item.site_material_key ?? '',
      item.rate_amount != null ? String(item.rate_amount) : '',
      item.record_id,
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  const persistedRateRows = params.contractValidationContext?.analysis.rate_schedule_rows ?? [];
  const assembledRateRows = assembleContractPricingRows(persistedRateRows).map((row) => ({
    row_id: row.id,
    source_kind: row.sourceKind,
    category: row.category,
    source_category: row.category,
    material_type: row.category,
    description: row.description,
    unit: row.unit,
    unit_type: row.unit,
    rate: row.rate,
    rate_amount: row.rate,
    page: row.page,
    source_anchor_ids: row.sourceAnchor ? [row.sourceAnchor] : [],
    confidence: row.confidence,
    source_quality: row.sourceQuality,
    rate_raw: row.rawText,
    raw_text: row.rawText,
  }));
  const validatorRateRows = assembledRateRows.length > 0 ? assembledRateRows : persistedRateRows;
  for (const [index, row] of validatorRateRows.entries()) {
    pushItem(
      normalizeRateScheduleItem(
        row,
        params.contractValidationContext?.document_id ?? 'contract_summary',
        row.row_id ?? `contract_rate_row:${index + 1}`,
      ),
    );
  }

  const scheduleFacts = findFactRecords(
    params.factsByDocumentId,
    params.rateDocumentIds,
    ['rate_table', 'hauling_rates', 'tipping_fees'],
  );

  for (const fact of scheduleFacts) {
    const rawValue = fact.value;
    if (Array.isArray(rawValue)) {
      rawValue.forEach((entry, index) => {
        pushItem(
          normalizeRateScheduleItem(
            entry,
            fact.document_id,
            `${fact.id}:item:${index + 1}`,
          ),
        );
      });
      continue;
    }

    pushItem(normalizeRateScheduleItem(rawValue, fact.document_id, fact.id));
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

export function synthesizeInvoicesFromLegacyExtractions(params: {
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

function buildContractRelationshipContext(
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'],
): NonNullable<ValidatorContractAnalysisContext['relationship_context']> {
  const contractIdentitySet = new Set(truthCategoryDocumentIds.contract_identity);
  const excludeIdentityDocuments = (documentIds: readonly string[]): string[] =>
    uniqueDocumentIds(
      documentIds.filter((documentId) => !contractIdentitySet.has(documentId)),
    );

  return {
    pricing_document_ids: excludeIdentityDocuments(truthCategoryDocumentIds.pricing),
    compliance_document_ids: excludeIdentityDocuments(truthCategoryDocumentIds.compliance),
    amendment_document_ids: excludeIdentityDocuments(truthCategoryDocumentIds.amendments),
  };
}

export function buildContractValidationContext(params: {
  projectValidationSummary?: unknown;
  documents: readonly ValidatorDocumentRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
}): ValidatorContractAnalysisContext | null {
  const isConfirmedByOperator = (
    facts: ValidatorFactRecord[],
    ...keys: string[]
  ): boolean =>
    keys.some((key) =>
      facts.some(
        (fact) =>
          fact.key === key
          && (fact.source === 'human_override' || fact.source === 'human_review'),
      ),
    );

  const relationshipContext = buildContractRelationshipContext(
    params.truthCategoryDocumentIds,
  );
  const contractDocumentId = params.truthCategoryDocumentIds.contract_identity[0] ?? null;
  if (contractDocumentId) {
    const document = params.documents.find((candidate) => candidate.id === contractDocumentId) ?? null;
    if (document) {
      const contractFacts = params.factsByDocumentId.get(contractDocumentId) ?? [];
      const hasHumanOverrides = contractFacts.some(
        (fact) => fact.source === 'human_override' || fact.source === 'human_review',
      );

      if (!hasHumanOverrides) {
        const persistedContext = buildPersistedContractValidationContextFromTrace(document);
        if (persistedContext) {
          return {
            ...persistedContext,
            relationship_context: relationshipContext,
          };
        }
      }

      const confirmedGoverningScheduleResolved: boolean =
        isConfirmedByOperator(
          contractFacts,
          'rate_schedule_present',
        )
        && isConfirmedByOperator(
          contractFacts,
          'rate_schedule_kind',
          'canonical_contract_rate_schedule_assembly_schedule_kind',
        );
      const confirmedDisposalTreatmentResolved: boolean = isConfirmedByOperator(
        contractFacts,
        'disposal_fee_treatment',
      );
      const syntheticDocument = buildSyntheticContractDocument({
        document,
        facts: contractFacts,
        legacyRow: params.legacyRowsByDocumentId.get(contractDocumentId) ?? null,
      });
      if (syntheticDocument) {
        const analysis = analyzeContractIntelligence({
          primaryDocument: syntheticDocument,
          relatedDocuments: [],
          confirmedGoverningScheduleResolved,
          confirmedDisposalTreatmentResolved,
        });
        if (analysis) {
          return {
            document_id: contractDocumentId,
            analysis,
            evidence_by_id: new Map(
              syntheticDocument.evidence.map((evidence) => [evidence.id, evidence] as const),
            ),
            relationship_context: relationshipContext,
          };
        }
      }
    }
  }

  const persistedProjectContext = buildPersistedContractValidationContextFromProjectSummary(
    params.projectValidationSummary,
  );
  if (persistedProjectContext) {
    return {
      ...persistedProjectContext,
      relationship_context: relationshipContext,
    };
  }

  return null;
}

function buildFactLookups(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  contractValidationContext: ValidatorContractAnalysisContext | null;
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
}): ValidatorFactLookups {
  const contractIdentityDocumentIds = uniqueDocumentIds([
    ...params.truthCategoryDocumentIds.contract_identity,
  ]);
  const amendedContractDocumentIds = uniqueDocumentIds([
    ...params.truthCategoryDocumentIds.amendments,
    ...contractIdentityDocumentIds,
  ]);
  const invoiceFactDocumentIds = uniqueDocumentIds([
    ...params.governingDocumentIds.invoice,
    ...params.familyDocumentIds.invoice,
  ]);
  const rateFactDocumentIds = uniqueDocumentIds([
    ...contractIdentityDocumentIds,
    ...params.truthCategoryDocumentIds.pricing,
  ]);

  const contractProjectCodeFacts = findFactRecords(
    params.factsByDocumentId,
    contractIdentityDocumentIds,
    PROJECT_CODE_FACT_KEYS,
  );
  const invoiceProjectCodeFacts = findFactRecords(
    params.factsByDocumentId,
    invoiceFactDocumentIds,
    PROJECT_CODE_FACT_KEYS,
  );
  const contractPartyNameFacts = findFactRecords(
    params.factsByDocumentId,
    contractIdentityDocumentIds,
    CONTRACTOR_NAME_FACT_KEYS,
  );
  const nteFact = findFirstFactRecord(
    params.factsByDocumentId,
    amendedContractDocumentIds,
    NTE_FACT_KEYS,
  );
  const rateScheduleFacts = findFactRecords(
    params.factsByDocumentId,
    rateFactDocumentIds,
    RATE_SCHEDULE_FACT_KEYS,
  );
  const contractCeilingTypeFact = findFirstFactRecord(
    params.factsByDocumentId,
    amendedContractDocumentIds,
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
  const rateScheduleItems = buildRateScheduleItems({
    factsByDocumentId: params.factsByDocumentId,
    rateDocumentIds: rateFactDocumentIds,
    contractValidationContext: params.contractValidationContext,
  });
  const contractAnalysisRateSchedulePresent =
    params.contractValidationContext?.analysis.pricing_model?.rate_schedule_present?.value === true;
  const derivedRateRowCount =
    toNumber(rateRowCountFact?.value ?? null) ?? rateScheduleItems.length;

  const hasRateScheduleFacts = rateScheduleFacts.some((fact) => {
    if (Array.isArray(fact.value)) return fact.value.length > 0;
    if (typeof fact.value === 'boolean') return fact.value;
    const numeric = toNumber(fact.value);
    if (numeric != null) return numeric > 0;
    return fact.value != null;
  }) || contractAnalysisRateSchedulePresent || rateScheduleItems.length > 0;

  return {
    contractProjectCodeFacts,
    invoiceProjectCodeFacts,
    contractPartyNameFacts,
    contractIdentityDocumentIds,
    pricingContextDocumentIds: uniqueDocumentIds(
      params.truthCategoryDocumentIds.pricing.filter((documentId) =>
        !contractIdentityDocumentIds.includes(documentId),
      ),
    ),
    complianceContextDocumentIds: uniqueDocumentIds(
      params.truthCategoryDocumentIds.compliance.filter((documentId) =>
        !contractIdentityDocumentIds.includes(documentId),
      ),
    ),
    amendmentContextDocumentIds: uniqueDocumentIds(
      params.truthCategoryDocumentIds.amendments.filter((documentId) =>
        !contractIdentityDocumentIds.includes(documentId),
      ),
    ),
    nteFact,
    contractDocumentId: params.contractValidationContext?.document_id ?? contractIdentityDocumentIds[0] ?? null,
    contractCeilingTypeFact,
    contractCeilingType:
      typeof contractCeilingTypeFact?.value === 'string'
        ? contractCeilingTypeFact.value
        : typeof params.contractValidationContext?.analysis.pricing_model.contract_ceiling_type?.value === 'string'
          ? params.contractValidationContext.analysis.pricing_model.contract_ceiling_type.value
          : null,
    rateSchedulePresentFact,
    rateSchedulePresent:
      firstBooleanFactValue(rateSchedulePresentFact)
      ?? (contractAnalysisRateSchedulePresent || rateScheduleItems.length > 0 ? true : null),
    rateRowCountFact,
    rateRowCount: derivedRateRowCount,
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

export function buildInvoiceLineToRateMap(
  invoiceLines: readonly InvoiceLineRow[],
  rateScheduleItems: readonly RateScheduleItem[],
  manualRateLinkOverrides: ReadonlyMap<string, RateScheduleItem> = new Map(),
): Map<string, RateScheduleItem | null> {
  const map = new Map<string, RateScheduleItem | null>();
  const scheduleIndex = indexRateScheduleItemsByCanonicalKeys(rateScheduleItems);

  for (const line of invoiceLines) {
    const lineId = rowIdentifier(line, INVOICE_LINE_ID_KEYS, 'invoice_line');
    const manualRateLink = resolveManualRateLinkOverride(lineId, manualRateLinkOverrides);
    if (manualRateLink) {
      map.set(lineId, manualRateLink);
      continue;
    }

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
          unit_price: readSemanticInvoiceUnitPrice(line),
        },
        scheduleIndex,
      ).match,
    );
  }

  return map;
}

function resolveManualRateLinkOverride(
  lineId: string,
  manualRateLinkOverrides: ReadonlyMap<string, RateScheduleItem>,
): RateScheduleItem | null {
  const exact = manualRateLinkOverrides.get(lineId);
  if (exact) return exact;

  const synthesizedLegacyMatch = /^typed:(.+):invoice:line:(\d+)$/u.exec(lineId);
  if (!synthesizedLegacyMatch) return null;

  return manualRateLinkOverrides.get(`fact:${synthesizedLegacyMatch[1]}:line:${synthesizedLegacyMatch[2]}`) ?? null;
}

function readSemanticInvoiceUnitPrice(line: InvoiceLineRow): number | null {
  const rateKeys = [
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
  ] as const;
  let candidate: number | null = null;
  let sourceKey: string | null = null;
  for (const key of rateKeys) {
    candidate = readRowNumber(line, [key]);
    if (candidate != null) {
      sourceKey = key;
      break;
    }
  }
  if (candidate == null) return null;

  const quantity = readRowNumber(line, INVOICE_LINE_QUANTITY_KEYS);
  const lineTotal = readRowNumber(line, INVOICE_LINE_TOTAL_KEYS);
  const explicitRateField = sourceKey != null && [
    'billed_rate',
    'unit_rate',
    'rate',
    'price',
    'contract_rate',
    'unit_price',
    'bill_rate',
    'amount_per_unit',
    'unit_cost',
    'uom_rate',
  ].includes(sourceKey);
  if (!explicitRateField && lineTotal != null && Math.abs(candidate - lineTotal) <= 0.01) return null;
  if (!explicitRateField && quantity != null && Math.abs(candidate - quantity) <= 0.01) {
    const derivedRate =
      quantity > 0 && lineTotal != null
        ? lineTotal / quantity
        : null;
    if (derivedRate == null || Math.abs(derivedRate - candidate) > 0.01) {
      return null;
    }
  }

  return candidate;
}

function buildProjectTotals(params: {
  invoiceLines: readonly InvoiceLineRow[];
  invoices: readonly InvoiceRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  invoiceDocumentIds: readonly string[];
  mobileTickets: readonly MobileTicketRow[];
  loadTickets: readonly LoadTicketRow[];
  fallbackTotalBilled?: number | null;
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
      } else if (params.fallbackTotalBilled != null) {
        billedTotal = params.fallbackTotalBilled;
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

function firstFactValue(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  documentId: string,
  keys: readonly string[],
): unknown {
  return findFactRecords(factsByDocumentId, [documentId], keys)[0]?.value ?? null;
}

function applyInvoiceScalarFact(
  row: InvoiceRow,
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
): InvoiceRow {
  const documentId = readRowString(row, ['source_document_id', 'document_id']);
  if (!documentId) return row;

  const invoiceNumber = firstFactValue(factsByDocumentId, documentId, ['invoice_number']);
  const vendorName = firstFactValue(factsByDocumentId, documentId, ['contractor_name', 'vendor_name']);
  const clientName = firstFactValue(factsByDocumentId, documentId, ['client_name', 'owner_name', 'bill_to_name']);
  const periodStart = firstFactValue(factsByDocumentId, documentId, ['period_start', 'service_period_start']);
  const periodEnd = firstFactValue(factsByDocumentId, documentId, ['period_end', 'service_period_end']);
  const billedAmount = firstFactValue(factsByDocumentId, documentId, ['billed_amount', 'total_amount', 'invoice_total']);

  return {
    ...row,
    ...(typeof invoiceNumber === 'string' && invoiceNumber.trim().length > 0
      ? { invoice_number: invoiceNumber.trim() }
      : {}),
    ...(typeof vendorName === 'string' && vendorName.trim().length > 0
      ? { contractor_name: vendorName.trim(), vendor_name: vendorName.trim() }
      : {}),
    ...(typeof clientName === 'string' && clientName.trim().length > 0
      ? { client_name: clientName.trim(), owner_name: clientName.trim() }
      : {}),
    ...(typeof periodStart === 'string' && periodStart.trim().length > 0
      ? { period_start: periodStart.trim(), service_period_start: periodStart.trim() }
      : {}),
    ...(typeof periodEnd === 'string' && periodEnd.trim().length > 0
      ? { period_end: periodEnd.trim(), service_period_end: periodEnd.trim() }
      : {}),
    ...(toNumber(billedAmount) != null
      ? { total_amount: toNumber(billedAmount), billed_amount: toNumber(billedAmount) }
      : {}),
  };
}

function applyEffectiveInvoiceFacts(params: {
  invoices: readonly InvoiceRow[];
  invoiceLines: readonly InvoiceLineRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  invoiceDocumentIds: readonly string[];
}): { invoices: InvoiceRow[]; invoiceLines: InvoiceLineRow[] } {
  const invoices = params.invoices.map((row) =>
    applyInvoiceScalarFact(row, params.factsByDocumentId),
  );
  const replacementLinesByDocumentId = new Map<string, InvoiceLineRow[]>();

  for (const documentId of params.invoiceDocumentIds) {
    const fact = findFactRecords(
      params.factsByDocumentId,
      [documentId],
      ['invoice_line_items', 'line_items'],
    )[0] ?? null;
    if (!fact || !Array.isArray(fact.value)) continue;

    const invoice = invoices.find((row) =>
      readRowString(row, ['source_document_id', 'document_id']) === documentId,
    ) ?? null;
    const invoiceId = readRowString(invoice ?? {}, ['id', 'invoice_id']) ?? `fact:${documentId}:invoice`;
    const invoiceNumber = readRowString(invoice ?? {}, ['invoice_number', 'invoice_no', 'number']);

    replacementLinesByDocumentId.set(
      documentId,
      fact.value
        .filter((entry): entry is Record<string, unknown> =>
          entry != null && typeof entry === 'object' && !Array.isArray(entry),
        )
        .map((entry, index) => ({
          ...entry,
          id: readRowString(entry, ['id', 'invoice_line_id', 'line_id']) ?? `fact:${documentId}:line:${index + 1}`,
          invoice_id: readRowString(entry, ['invoice_id', 'source_invoice_id']) ?? invoiceId,
          invoice_number: readRowString(entry, ['invoice_number', 'invoice_no']) ?? invoiceNumber,
          source_document_id: readRowString(entry, ['source_document_id', 'document_id']) ?? documentId,
        })),
    );
  }

  if (replacementLinesByDocumentId.size === 0) {
    return { invoices, invoiceLines: [...params.invoiceLines] };
  }

  const replacedDocumentIds = new Set(replacementLinesByDocumentId.keys());
  const retainedLines = params.invoiceLines.filter((row) => {
    const documentId = readRowString(row, ['source_document_id', 'document_id']);
    return !documentId || !replacedDocumentIds.has(documentId);
  });

  return {
    invoices,
    invoiceLines: [
      ...retainedLines,
      ...[...replacementLinesByDocumentId.values()].flat(),
    ],
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

export async function loadProjectValidatorInput(
  projectId: string,
): Promise<ProjectValidatorInput> {
  return loadValidatorInput(projectId);
}

async function loadValidatorInput(projectId: string): Promise<ProjectValidatorInput> {
  const project = await loadProject(projectId);
  const documents = await loadProjectDocuments(project);
  const documentIds = documents.map((document) => document.id);
  const [
    factRows,
    legacyRowsByDocumentId,
    overrideRows,
    reviewRows,
    ruleStateByRuleId,
    mobileTickets,
    loadTickets,
    canonicalInvoices,
    transactionData,
  ] =
    await Promise.all([
      loadExtractionFactRows(documentIds),
      loadLegacyExtractionRows(documentIds),
      loadDocumentFactOverrides(documentIds),
      loadDocumentFactReviews(documentIds),
      loadRuleState(projectId),
      loadStructuredRows('mobile_tickets', projectId),
      loadStructuredRows('load_tickets', projectId),
      getCanonicalInvoicesForProject({
        projectId,
        documentIds,
      }),
      getCanonicalTransactionDataForProject({
        projectId,
        documentIds,
      }),
    ]);
  const invoices = canonicalInvoices.invoices as InvoiceRow[];
  const invoiceLines = canonicalInvoices.invoiceLines as InvoiceLineRow[];

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

  const validationPhase = resolveProjectValidationPhase(project.validation_phase);
  const { familyDocumentIds, governingDocumentIds, truthCategoryDocumentIds } = buildDocumentIdsByFamily(
    documents,
    precedenceFamilies,
    documentRelationships,
  );
  const excludedValidationDocumentIds = buildExcludedValidationDocumentIds({
    precedenceFamilies,
    documentRelationships,
  });
  const validationInvoiceDocumentIds = uniqueDocumentIds([
    ...governingDocumentIds.invoice,
    ...familyDocumentIds.invoice,
    ...activeInvoiceDocumentIds(documents, excludedValidationDocumentIds),
  ]);
  const syntheticInvoices = synthesizeInvoicesFromLegacyExtractions({
    legacyRowsByDocumentId,
    invoiceDocumentIds: validationInvoiceDocumentIds,
    existingInvoices: invoices as InvoiceRow[],
    existingInvoiceLines: invoiceLines as InvoiceLineRow[],
  });
  const baseInvoices = [
    ...(invoices as InvoiceRow[]),
    ...syntheticInvoices.invoices,
  ];
  const baseInvoiceLines = [
    ...(invoiceLines as InvoiceLineRow[]),
    ...syntheticInvoices.invoiceLines,
  ];
  const { factsByDocumentId, allFacts } = buildFactsByDocumentId({
    documents,
    factRows,
    legacyRowsByDocumentId,
    overrideRows,
    reviewRows,
  });
  const scopedInvoiceTruth = resolveValidationInvoiceScope({
    invoices: baseInvoices,
    invoiceLines: baseInvoiceLines,
    excludedDocumentIds: excludedValidationDocumentIds,
  });
  const effectiveInvoiceTruth = applyEffectiveInvoiceFacts({
    invoices: scopedInvoiceTruth.invoices,
    invoiceLines: scopedInvoiceTruth.invoiceLines,
    factsByDocumentId,
    invoiceDocumentIds: validationInvoiceDocumentIds,
  });
  const effectiveInvoices = effectiveInvoiceTruth.invoices;
  const effectiveInvoiceLines = effectiveInvoiceTruth.invoiceLines;
  const contractValidationContext = buildContractValidationContext({
    projectValidationSummary: project.validation_summary_json,
    documents,
    factsByDocumentId,
    legacyRowsByDocumentId,
    truthCategoryDocumentIds,
  });
  const baseFactLookups = buildFactLookups({
    factsByDocumentId,
    contractValidationContext,
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds,
  });
  const contractDocumentIdForGuidance =
    contractValidationContext?.document_id ?? truthCategoryDocumentIds.contract_identity[0] ?? null;
  const contractUploadGuidance = contractDocumentIdForGuidance
    ? await loadContractUploadGuidanceForDocument(getSupabaseAdmin()!, contractDocumentIdForGuidance).catch(
        () => null,
      )
    : null;
  const factLookups = {
    ...baseFactLookups,
    contractUploadGuidanceRateScheduleIncluded: contractUploadGuidance?.rate_schedule_included ?? null,
  };
  const manualRateLinkOverrides = await loadManualRateLinkOverrides({
    project,
    rateScheduleItems: factLookups.rateScheduleItems,
  });
  const mobileToLoadsMap = buildMobileToLoadsMap(loadTickets as LoadTicketRow[]);
  const invoiceLineToRateMap = buildInvoiceLineToRateMap(
    effectiveInvoiceLines,
    factLookups.rateScheduleItems,
    manualRateLinkOverrides,
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
    fallbackTotalBilled: readPersistedProjectTotalBilled(project.validation_summary_json),
  });
  const baseInput = {
    project,
    validationPhase,
    documents,
    documentRelationships,
    precedenceFamilies,
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds,
    ruleStateByRuleId,
    factsByDocumentId,
    allFacts,
    mobileTickets: mobileTickets as MobileTicketRow[],
    loadTickets: loadTickets as LoadTicketRow[],
    invoices: effectiveInvoices,
    invoiceLines: effectiveInvoiceLines,
    mobileToLoadsMap,
    invoiceLineToRateMap,
    manualRateLinkOverrides,
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
    crossDocumentRateVerification?: CrossDocumentRateVerificationSummary | null;
    reconciliation?: ProjectReconciliationSummary | null;
    exposure?: ProjectExposureSummary | null;
    overviewFinancials?: { nte_amount: number | null; total_billed: number | null };
    contractDocumentId?: string | null;
    contractValidationContext?: ValidatorContractAnalysisContext | null;
    validationPhase?: ProjectValidationPhase;
  } = {},
): ValidatorResult {
  const orderedFindings = sortFindings(findings);
  const blockedReasons = blockingReasons(orderedFindings);
  const openFindings = orderedFindings.filter((finding) => finding.status === 'open');
  const hasOpenBlockers = openFindings.some((finding) => isBlockingFinding(finding));

  const status: ValidationStatus =
    hasOpenBlockers
      ? 'BLOCKED'
      : openFindings.length === 0
      ? 'VALIDATED'
      : 'FINDINGS_OPEN';
  const summary = buildValidationSummary(orderedFindings, status, {
    contractInvoiceReconciliation: options.contractInvoiceReconciliation ?? null,
    invoiceTransactionReconciliation: options.invoiceTransactionReconciliation ?? null,
    crossDocumentRateVerification: options.crossDocumentRateVerification ?? null,
    reconciliation: options.reconciliation ?? null,
    exposure: options.exposure ?? null,
    nte_amount: options.overviewFinancials?.nte_amount ?? null,
    total_billed: options.overviewFinancials?.total_billed ?? null,
    contractDocumentId: options.contractDocumentId ?? null,
    contractValidationContext: options.contractValidationContext ?? null,
    validationPhase: options.validationPhase ?? 'contract_setup',
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
    cross_document_rate_verification: summary.cross_document_rate_verification ?? null,
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
  let crossDocumentRateVerification: CrossDocumentRateVerificationSummary | null = null;
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
        crossDocumentRateVerification,
        reconciliation,
        exposure,
        overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
        contractDocumentId: input.factLookups.contractDocumentId,
        contractValidationContext: input.contractValidationContext,
        validationPhase: input.validationPhase,
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
      id: PACK_CROSS_DOCUMENT_RATE_VERIFICATION,
      run: (packInput) => {
        const result = evaluateCrossDocumentRateVerification(packInput);
        crossDocumentRateVerification = result.summary;
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
    crossDocumentRateVerification,
    reconciliation,
    exposure,
    overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
    contractDocumentId: input.factLookups.contractDocumentId,
    contractValidationContext: input.contractValidationContext,
    validationPhase: input.validationPhase,
  });
}

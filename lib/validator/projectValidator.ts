import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  analyzeContractIntelligence,
  buildContractPricingSelectedCategoryOverrides,
  buildContractIntelligenceRateScheduleRows,
  type AnalyzeContractIntelligenceInput,
} from '@/lib/contracts/analyzeContractIntelligence';
import {
  loadContractUploadGuidanceForDocument,
  type ContractUploadGuidanceRateScheduleIncluded,
} from '@/lib/contracts/contractUploadGuidance';
import {
  assembleContractPricingRowsWithCandidates,
  canonicalTaxonomyKeyForAllowedCategory,
  type ContractPricingAssemblyResult,
  type ContractPricingAssemblyRow,
  type ContractPricingAssemblySourceOptions,
  type ContractPricingAssemblySourceScope,
  type ContractPricingSourceRowIdentity,
} from '@/lib/contracts/contractPricingAssembly';
import { authoredRateRowQuarantine } from '@/lib/contracts/authoredRowQuarantine';
import {
  resolveContractPricingLogicalSources,
  type ContractPricingAuthorityDiscriminator,
  type ContractPricingDuplicateAuthorityFinding,
} from '@/lib/contracts/contractPricingDuplicateAuthority';
import {
  canonicalizeRelationshipType,
  inferGoverningDocumentFamily,
  resolveDuplicateDocumentIdsForAuthority,
  resolveDuplicateResolutionEligibleIds,
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
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { sanitizeSourceIdentityReadFailure, type SourceIdentityReadFailure } from '@/lib/sourceIdentityReadFailure';
import {
  getCanonicalTransactionDataForProject,
  type ProjectTransactionData,
} from '@/lib/server/transactionDataPersistence';
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
  type ValidatorSourceArtifactSnapshotEntry,
  type ValidatorSourceArtifactSnapshotResult,
  type ValidatorSourceIdentityStoreState,
  type ValidatorTruthCategoryDocumentIds,
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
import {
  PACK_AUTHORED_RATE_ROW_QUARANTINE,
  runAuthoredRateRowQuarantineRules,
} from '@/lib/validator/rulePacks/authoredRateRowQuarantine';
import {
  PACK_TRANSACTION_GRAIN_CONFLICT,
  runTransactionGrainConflictRules,
} from '@/lib/validator/rulePacks/transactionGrainConflict';
import {
  PACK_CANONICAL_TRUTH_INTEGRITY,
  runCanonicalTruthIntegrityRules,
} from '@/lib/validator/rulePacks/canonicalTruthIntegrity';
import { resolveProjectTruthAuthority } from '@/lib/canonical/authority/resolveProjectTruthAuthority';
import { projectCanonicalTransactionRows } from '@/lib/canonical/authority/canonicalValidatorProjection';
import {
  isCanonicalAuthorityEstablished,
  isCanonicalAuthorityUnavailable,
} from '@/lib/canonical/authority/canonicalExecutionContext';
import {
  PROJECT_TRUTH_AUTHORITY_ENV_VAR,
  type ProjectTruthAuthorityMode,
} from '@/lib/canonical/authority/projectTruthAuthorityMode';
import { hashCanonicalJson } from '@/lib/canonical/publication/projectTruthPublicationIdentity';
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
import { completeEffectiveInvoiceLineCanonicalFields } from '@/lib/validator/effectiveInvoiceLineCompletion';

const PACK_REQUIRED_SOURCES = 'required_sources';
const PACK_IDENTITY_CONSISTENCY = 'identity_consistency';
const PACK_CONTRACT_INVOICE_RECONCILIATION = 'contract_invoice_reconciliation';
const PACK_INVOICE_TRANSACTION_RECONCILIATION = 'invoice_transaction_reconciliation';
const PACK_CROSS_DOCUMENT_RATE_VERIFICATION = 'cross_document_rate_verification';
const PACK_FINANCIAL_INTEGRITY = 'financial_integrity';
const PACK_TICKET_INTEGRITY = 'ticket_integrity';

const PROJECT_SELECT =
  'id, organization_id, name, code, validation_status, validation_summary_json, validation_phase';
export const VALIDATOR_DOCUMENT_SELECT =
  'id, project_id, organization_id, title, name, document_type, document_role, storage_path, created_at, processing_status, operational_status, processed_at, intelligence_trace';
const SOURCE_ARTIFACT_SELECT =
  'id, source_document_id, source_sha256, storage_object_version, storage_bucket, storage_path, identity_origin, media_type_sniffed, byte_length, created_at';
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
  | 'load_tickets';

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

/**
 * Anchored rate rows for one eligible pricing-source document.
 *
 * Deliberately the SAME trace reader the contract document already goes
 * through, with only the eligibility gate widened from
 * `isCanonicalContractDocument` to `isCanonicalRateAuthorityDocument`. Attached
 * price sheets publish `contract_analysis.rate_schedule_rows` in exactly the
 * shape the assembler consumes — fully anchored — so no converter is introduced
 * and no PDF is reparsed. Routing these rows through `typedRowsToRateRows`
 * would strip the anchors this path exists to preserve.
 */
export function buildPersistedPricingSourceRateScheduleRows(
  document: Pick<ValidatorDocumentRow, 'id' | 'document_type' | 'intelligence_trace'>,
): readonly ContractRateScheduleRow[] | null {
  const trace = persistedDocumentTrace(document);
  if (!trace || !isCanonicalRateAuthorityDocument(document, trace)) {
    return null;
  }

  const analysis = asRecord(trace.contract_analysis);
  if (!analysis) return null;

  const rows = (analysis as unknown as ContractAnalysisResult).rate_schedule_rows;
  return Array.isArray(rows) ? rows : null;
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

  for (const duplicateDocumentId of resolveDuplicateDocumentIdsForAuthority(
    params.documentRelationships,
    resolveDuplicateResolutionEligibleIds(
      params.precedenceFamilies.flatMap((family) => family.documents),
    ),
  )) {
    excluded.add(duplicateDocumentId);
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

export async function loadProject(projectId: string): Promise<ValidatorProjectRow> {
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
    .select(VALIDATOR_DOCUMENT_SELECT)
    .eq('organization_id', project.organization_id)
    .eq('project_id', project.id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ValidatorDocumentRow[];
}

type ValidatorSourceArtifactRow = {
  id: string;
  source_document_id: string;
  source_sha256: string | null;
  storage_object_version: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  identity_origin?: string | null;
  media_type_sniffed: string | null;
  byte_length: number | null;
  created_at: string;
};

function exactSourceIdentity(artifact: ValidatorSourceArtifactRow | null): string | null {
  if (
    !artifact?.id
    || !artifact.source_sha256
    || !artifact.storage_object_version
  ) {
    return null;
  }

  return [artifact.id, artifact.source_sha256, artifact.storage_object_version].join(':');
}

export function buildSourceArtifactSnapshot(params: {
  documents: readonly ValidatorDocumentRow[];
  sourceArtifacts: readonly ValidatorSourceArtifactRow[];
}): readonly ValidatorSourceArtifactSnapshotEntry[] {
  const artifactsByDocumentId = new Map<string, ValidatorSourceArtifactRow[]>();
  for (const artifact of params.sourceArtifacts) {
    const existing = artifactsByDocumentId.get(artifact.source_document_id) ?? [];
    existing.push({ ...artifact });
    artifactsByDocumentId.set(artifact.source_document_id, existing);
  }

  return Object.freeze(params.documents.map((document) => {
    const artifact = (artifactsByDocumentId.get(document.id) ?? [])
      .sort((left, right) => (
        right.created_at.localeCompare(left.created_at)
        || right.id.localeCompare(left.id)
      ))[0] ?? null;

    return Object.freeze({
      documentId: document.id,
      documentType: document.document_type,
      documentRole: document.document_role ?? null,
      storagePath: document.storage_path ?? null,
      sourceArtifactId: artifact?.id ?? null,
      sourceSha256: artifact?.source_sha256 ?? null,
      logicalSourceIdentity: artifact?.source_sha256
        ? `source_sha256:${artifact.source_sha256}`
        : null,
      storageObjectVersion: artifact?.storage_object_version ?? null,
      storageBucket: artifact?.storage_bucket ?? null,
      storageObjectPath: artifact?.storage_path ?? null,
      identityOrigin: artifact?.identity_origin ?? null,
      mediaTypeSniffed: artifact?.media_type_sniffed ?? null,
      byteLength: artifact?.byte_length ?? null,
      artifactCreatedAt: artifact?.created_at ?? null,
      exactSourceIdentity: exactSourceIdentity(artifact),
    });
  }));
}

/**
 * Deterministic digest of the exact frozen sources backing one execution.
 *
 * Identifies which source artifacts the run observed, so a persisted result can
 * be tied to the precise bytes it was derived from. Sorted by document id so
 * load order can never change the digest.
 */
export function buildSourceArtifactSnapshotDigest(
  snapshot: readonly ValidatorSourceArtifactSnapshotEntry[],
): string | null {
  if (snapshot.length === 0) return null;
  return hashCanonicalJson(
    [...snapshot]
      .map((entry) => ({
        documentId: entry.documentId,
        exactSourceIdentity: entry.exactSourceIdentity,
        sourceSha256: entry.sourceSha256,
        storageObjectVersion: entry.storageObjectVersion,
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId, 'en-US')),
  );
}

/**
 * Source-artifact identity per document, read from the frozen snapshot.
 *
 * Canonical invoice identity is scoped by source artifact, so this map is the
 * artifact half of that scope. It is READ from the snapshot the execution
 * already loaded; no artifact is looked up or re-read.
 */
export function buildSourceArtifactIdByDocumentId(
  snapshot: readonly ValidatorSourceArtifactSnapshotEntry[],
): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const entry of snapshot) {
    // `exactSourceIdentity` is the strongest artifact identity when present;
    // the artifact id is the fallback. Neither is invented when both are absent.
    map.set(entry.documentId, entry.exactSourceIdentity ?? entry.sourceArtifactId ?? null);
  }
  return map;
}

/**
 * Document-family label per document, projected from the precedence snapshot.
 *
 * The family label is carried verbatim; canonical code does not reinterpret it.
 * A document appearing in more than one family keeps the first family in stable
 * key order rather than an arbitrary one.
 */
export function buildDocumentFamilyByDocumentId(
  familyDocumentIds: ValidatorDocumentIdsByFamily,
): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  for (const family of Object.keys(familyDocumentIds).sort((l, r) => l.localeCompare(r, 'en-US'))) {
    for (const documentId of familyDocumentIds[family as keyof ValidatorDocumentIdsByFamily] ?? []) {
      if (!map.has(documentId)) map.set(documentId, family);
    }
  }
  return map;
}

export function retainAssembledContractPricingRows(
  rows: readonly ContractPricingAssemblyRow[],
): readonly ContractPricingAssemblyRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

/**
 * Reads the immutable source-identity store for this execution's documents.
 *
 * A successful read that returns no rows is an honest empty state: those
 * documents have no recorded source identity. A failed read is NOT that — it is
 * reported as `unreadable` and carries the store error, so a caller can tell
 * "this document has no recorded identity" from "the identity store could not
 * be consulted". Collapsing the error into an empty artifact list (the previous
 * behavior) made every document look identity-less project-wide and would turn
 * "unproven, therefore block" into an unexplained block.
 *
 * The read failure is not thrown: `extraction_source_artifacts` is not deployed
 * everywhere, and ordinary non-duplicate assembly does not require it. The
 * state is carried instead, and only becomes load-bearing where identity
 * actually decides something.
 */
export async function loadSourceArtifactSnapshot(params: {
  project: ValidatorProjectRow;
  documents: readonly ValidatorDocumentRow[];
}): Promise<ValidatorSourceArtifactSnapshotResult> {
  if (params.documents.length === 0) {
    return Object.freeze({
      storeState: 'read' as const,
      readError: null,
      entries: Object.freeze([]),
    });
  }

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('extraction_source_artifacts')
    .select(SOURCE_ARTIFACT_SELECT)
    .eq('organization_id', params.project.organization_id)
    .in('source_document_id', params.documents.map((document) => document.id));

  if (error) {
    return Object.freeze({
      storeState: 'unreadable' as const,
      readError: sanitizeSourceIdentityReadFailure(error),
      // Entries are still shaped per document so downstream consumers keep the
      // same projection; every identity is null because none was READ, which is
      // exactly what `storeState` qualifies.
      entries: buildSourceArtifactSnapshot({
        documents: params.documents,
        sourceArtifacts: [],
      }),
    });
  }

  return Object.freeze({
    storeState: 'read' as const,
    readError: null,
    entries: buildSourceArtifactSnapshot({
      documents: params.documents,
      sourceArtifacts: (data ?? []) as ValidatorSourceArtifactRow[],
    }),
  });
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

/**
 * Loads the raw active manual rate-link rows for a project.
 *
 * Split out from {@link loadManualRateLinkOverrides} because the query is
 * authority-independent while `buildManualRateLinkOverrides` is not: it resolves
 * links against whichever authority produced the rate-schedule items. Loading
 * the rows once and applying the pure builder per authority is what lets the
 * shadow comparator run two authorities over one frozen source snapshot without
 * a second database read.
 */
export async function loadInvoiceLineRateLinkRows(
  project: Pick<ValidatorProjectRow, 'id' | 'organization_id'>,
): Promise<InvoiceLineRateLinkRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');

  const { data, error } = await admin
    .from('invoice_line_rate_links')
    .select(
      'id, organization_id, project_id, invoice_document_id, invoice_line_subject_id, contract_document_id, contract_rate_row_id, rate_row_description, rate_row_unit_type, rate_row_rate_amount, reason, created_at, is_active, superseded_by',
    )
    .eq('organization_id', project.organization_id)
    .eq('project_id', project.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error && isInvoiceLineRateLinksTableUnavailableError(error)) {
    return [];
  }
  if (error) throw new Error(error.message);

  return (data ?? []) as InvoiceLineRateLinkRow[];
}

export async function loadManualRateLinkOverrides(params: {
  project: Pick<ValidatorProjectRow, 'id' | 'organization_id'>;
  rateScheduleItems: readonly RateScheduleItem[];
}): Promise<Map<string, RateScheduleItem>> {
  return buildManualRateLinkOverrides({
    rows: await loadInvoiceLineRateLinkRows(params.project),
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
  // Relationship meaning is resolved by the shared canonicalizer, not by raw
  // string equality: `governs` and `applies_to` are the same attachment as
  // `attached_to`, and matching only the literal silently dropped price sheets
  // linked under the aliases. Exclusion state (`voided`, `supersedes`,
  // `replaces`) is a different question and stays in
  // VALIDATION_EXCLUDED_RELATIONSHIP_TYPES — `voided` is not relationship
  // vocabulary, so canonicalizing it would return null and neutralize the
  // exclusion.
  const attachedPricingDocumentIds = uniqueDocumentIds(
    documentRelationships.flatMap((relationship) => {
      if (canonicalizeRelationshipType(relationship.relationship_type) !== 'attached_to') return [];
      const sourceDocument = documentById.get(relationship.source_document_id) ?? null;
      return isPricingAuthorityDocument(sourceDocument) ? [relationship.source_document_id] : [];
    }),
  );
  const attachedPricingDocumentIdSet = new Set(attachedPricingDocumentIds);
  const contractIdentityDocumentIds = resolvedTruthCategoryDocumentIds.contract_identity.filter(
    (documentId) => !attachedPricingDocumentIdSet.has(documentId),
  );

  // The attachment union above re-adds price sheets by relationship alone, which
  // would resurrect a disposed duplicate that resolveDocumentTruthCategoryIds had
  // already removed — a duplicate is normally attached to the same contract as
  // its original. The exclusion has to be the last word here, or every consumer
  // of truthCategoryDocumentIds sees the duplicate again.
  const duplicateDocumentIds = new Set(
    resolveDuplicateDocumentIdsForAuthority(
      documentRelationships,
      resolveDuplicateResolutionEligibleIds(
        precedenceFamilies.flatMap((family) => family.documents),
      ),
    ),
  );
  const withoutDuplicates = (documentIds: readonly string[]): string[] =>
    documentIds.filter((documentId) => !duplicateDocumentIds.has(documentId));

  return {
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds: {
      ...resolvedTruthCategoryDocumentIds,
      contract_identity: contractIdentityDocumentIds.length > 0
        ? contractIdentityDocumentIds
        : resolvedTruthCategoryDocumentIds.contract_identity,
      pricing: withoutDuplicates(uniqueDocumentIds([
        ...attachedPricingDocumentIds,
        ...resolvedTruthCategoryDocumentIds.pricing,
      ])),
    },
  };
}

export function buildFactsByDocumentId(params: {
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
  // The channel exists only on rows mapped from assembled pricing rows, which
  // are the only rows whose `description` may have been replaced by a display
  // sentinel. Fact-sourced rows never went through display cleanup, so their
  // own description IS source truth.
  //
  // Presence of the KEY is what matters, not whether it holds a value: an
  // assembled row with a null source description genuinely had none, and must
  // stay semantically unidentified rather than falling back to the sentinel.
  const hasSourceDescriptionChannel = Object.hasOwn(row, 'source_description');
  const sourceDescription = readRowString(row, ['source_description']) ?? null;
  // Semantic identity is derived from source truth. Keying on `description`
  // meant every row whose text assembly had replaced with the
  // `Raw row needs review` sentinel produced the same
  // `desc:raw row needs review`, collapsing distinct contract line items onto
  // one key.
  const semanticDescription = hasSourceDescriptionChannel ? sourceDescription : description;
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: rateCode,
    description: semanticDescription,
    material_type: materialType,
    unit_type: unitType,
    service_item: serviceItem,
  });
  const authoredValueCorrection = row.authoredValueCorrection === true;
  const authoredQuarantine = authoredRateRowQuarantine({
    ...row,
    row_id: readRowString(row, ['row_id', 'id']) ?? recordId,
    authoredValueCorrection,
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
    source_description: semanticDescription,
    service_item: serviceItem,
    source_category: sourceCategory,
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    source_kind: readRowString(row, ['source_kind']),
    source_quality: readRowString(row, ['source_quality']),
    confidence: readRowString(row, ['confidence', 'state']),
    authoredValueCorrection,
    authored_unverified: authoredQuarantine?.authoredUnverified ?? false,
    authored_quarantine: authoredQuarantine,
    raw_value: value,
    ...keys,
  };
}

export function buildRateScheduleItems(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  rateDocumentIds: readonly string[];
  contractValidationContext: ValidatorContractAnalysisContext | null;
  assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
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

  const assembledRateRows = params.assembledContractPricingRows.map((row) => ({
    row_id: row.id,
    source_document_id: row.sourceDocumentId,
    // Always present on assembled rows (even when null) so the key-derivation
    // below can tell "source published no description" from "this row never
    // went through display cleanup".
    source_description: row.sourceDescription,
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
    authoredValueCorrection: row.authoredValueCorrection,
    rate_raw: row.rawText,
    raw_text: row.rawText,
  }));
  const categorylessPersistedCompatibilityRows = assembledRateRows.length > 0
    ? []
    : (params.contractValidationContext?.analysis.rate_schedule_rows ?? [])
      .filter((row) => {
        const record = row as unknown as Record<string, unknown>;
        return [
          record.category,
          record.source_category,
          record.material_type,
          record.canonical_category,
        ].every((value) => (
          value == null
          || (typeof value === 'string' && value.trim().length === 0)
        ));
      });
  const validatorRateRows = [
    ...assembledRateRows,
    // Pre-A11 validation normalized categoryless legacy trace rows even when
    // operator assembly dropped them. Retain that narrow compatibility path;
    // persisted rows carrying a non-allowed category must not bypass selection.
    ...categorylessPersistedCompatibilityRows,
  ];
  /**
   * Source documents whose pricing already entered through assembly.
   *
   * Consumed by the `facts.rate_table` pass below to keep one document's
   * extraction from being counted twice. Membership is by document identity
   * only.
   */
  const assembledSourceDocumentIds = new Set<string>();
  for (const [index, row] of validatorRateRows.entries()) {
    // `row.source_document_id` is present only on rows mapped from
    // `assembledContractPricingRows` (C3 per-document lineage); the persisted
    // trace fallback rows below belong to the single contract document by
    // construction. Without this, every row assembled from an attached
    // pricing source is stamped with the CONTRACT's document id regardless of
    // which document it actually came from — which silently collapses two
    // distinct documents' identical-content rows into one `RateScheduleItem`
    // via the dedupe key below, exactly the duplicate legacy count C3 exists
    // to keep visible.
    const sourceDocumentId =
      (row as { source_document_id?: string | null }).source_document_id
      ?? params.contractValidationContext?.document_id
      ?? 'contract_summary';
    const item = normalizeRateScheduleItem(
      row,
      sourceDocumentId,
      row.row_id ?? `contract_rate_row:${index + 1}`,
    );
    // A document counts as covered only once it has actually contributed an
    // item. Deriving coverage from the raw input instead would let a document
    // whose rows all normalized away suppress its own fact rows and lose the
    // pricing entirely — silence rather than double-counting, but still a loss.
    if (item != null) assembledSourceDocumentIds.add(sourceDocumentId);
    pushItem(item);
  }

  const scheduleFacts = findFactRecords(
    params.factsByDocumentId,
    params.rateDocumentIds,
    ['rate_table', 'hauling_rates', 'tipping_fees'],
  );

  for (const fact of scheduleFacts) {
    // Document-scoped grain guard. `facts.rate_table` and the assembled pricing
    // rows are two PROJECTIONS OF THE SAME EXTRACTION for a given document (C3
    // design §5.4), so emitting both counts every physical rate twice.
    //
    // Before C3, assembly was scoped to the single contract document, so for a
    // project whose rates live on attached price sheets the assembled list was
    // empty and only this facts path ran. C3 widens assembly to every eligible
    // pricing source, which activates both projections at once — measured on
    // Goodlettsville as legacy 10 → 20.
    //
    // The suppression is per source document, never global: a document covered
    // by assembly uses its assembled representation (which carries anchors,
    // geometry, and merge diagnostics the fact projection lacks), while a
    // document with no assembled rows keeps its fact rows. Coverage is decided
    // purely by source-document identity — never by description, rate, or any
    // other row-content similarity.
    if (assembledSourceDocumentIds.has(fact.document_id)) continue;

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
      extractionData: legacyData,
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

/** One eligible pricing-source document, assembled under its own scope. */
type PreparedContractPricingSource = {
  readonly sourceScope: ContractPricingAssemblySourceScope;
  readonly sourceSha256: string | null;
  readonly authoredDuplicateTargetDocumentId: string | null;
  readonly rateScheduleRows: readonly ContractRateScheduleRow[];
  readonly relationshipBasis: string | null;
};

/** Schedule governance, read from the precedence family and never re-derived. */
type ResolvedPricingScheduleGovernance = {
  readonly documentId: string;
  readonly family: string | null;
  readonly reason: string | null;
  readonly reasonDetail: string | null;
  readonly consideredDocumentIds: readonly string[];
};

type PreparedContractValidationContext = {
  readonly sourceScope: ContractPricingAssemblySourceScope;
  readonly sourceSha256: string | null;
  readonly authoredDuplicateTargetDocumentId: string | null;
  readonly authoritativeRateScheduleRows: readonly ContractRateScheduleRow[];
  readonly candidateOnlyRateScheduleRows: readonly ContractRateScheduleRow[];
  readonly selectedCategoryBySourceRow?: ReadonlyMap<ContractPricingSourceRowIdentity, string>;
  /**
   * Eligible pricing documents OTHER than the contract scope above. Each is
   * assembled under its own scope so per-document source identity and evidence
   * lineage survive; concatenating their rows into one call would stamp the
   * contract's artifact identity onto price-sheet rows.
   */
  readonly additionalPricingSources: readonly PreparedContractPricingSource[];
  readonly scheduleGovernance: ResolvedPricingScheduleGovernance | null;
  readonly duplicateAuthorityDiscriminators: ReadonlyMap<
    string,
    ContractPricingAuthorityDiscriminator
  >;
  readonly sourceIdentityStoreState: ValidatorSourceIdentityStoreState;
  readonly sourceIdentityReadError: SourceIdentityReadFailure | null;
  readonly finalize: (
    assembly: ContractPricingAssemblyResult,
  ) => ValidatorContractAnalysisContext | null;
};

type ContractValidationContextParams = {
  projectValidationSummary?: unknown;
  documents: readonly ValidatorDocumentRow[];
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  legacyRowsByDocumentId: Map<string, ValidatorLegacyExtractionRow>;
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
  sourceArtifactSnapshot?: readonly ValidatorSourceArtifactSnapshotEntry[];
  precedenceFamilies?: readonly ResolvedDocumentPrecedenceFamily[];
  documentRelationships?: readonly DocumentRelationshipRecord[];
  /**
   * Already computed before assembly for invoice scoping. Pricing must consult
   * it too: a replaced or voided price sheet must not enter row loading,
   * governance, duplicate evaluation, or assembly.
   */
  excludedValidationDocumentIds?: ReadonlySet<string>;
  sourceIdentityStoreState?: ValidatorSourceIdentityStoreState;
  sourceIdentityReadError?: SourceIdentityReadFailure | null;
};

/**
 * Eligible pricing-source documents, in deterministic order.
 *
 * `(contract_identity ∪ pricing) − excluded − inactive authority`, then gated by
 * the same rate-authority predicate legacy already uses. No new relationship
 * walk and no new classification rule: every input is already resolved upstream.
 */
function resolveEligiblePricingSourceDocumentIds(params: {
  readonly truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
  readonly documentById: ReadonlyMap<string, ValidatorDocumentRow>;
  readonly excludedDocumentIds: ReadonlySet<string>;
  readonly inactiveDocumentIds: ReadonlySet<string>;
}): readonly string[] {
  // Duplicates are already gone: `truthCategoryDocumentIds` comes from
  // resolveDocumentTruthCategoryIds, which strips them against the shared
  // eligibility set. Re-resolving here against the narrower candidate list
  // would only introduce a fourth, stricter definition of eligibility.
  return uniqueDocumentIds([
    ...params.truthCategoryDocumentIds.contract_identity,
    ...params.truthCategoryDocumentIds.pricing,
  ]).filter((documentId) => {
    if (params.excludedDocumentIds.has(documentId)) return false;
    if (params.inactiveDocumentIds.has(documentId)) return false;
    const document = params.documentById.get(documentId) ?? null;
    return document != null && isCanonicalRateAuthorityDocument(document);
  });
}

/**
 * Schedule governance, carried verbatim from the precedence family that
 * governs one of the eligible pricing sources.
 *
 * Precedence is NOT re-derived here. When no family governs an eligible source
 * and more than one source is in play, governance stays unresolved rather than
 * being guessed from row agreement or document order.
 */
function resolvePricingScheduleGovernance(params: {
  readonly precedenceFamilies: readonly ResolvedDocumentPrecedenceFamily[];
  readonly eligibleDocumentIds: readonly string[];
}): ResolvedPricingScheduleGovernance | null {
  const eligible = new Set(params.eligibleDocumentIds);

  for (const family of params.precedenceFamilies) {
    const governingDocumentId = family.governing_document_id;
    if (!governingDocumentId || !eligible.has(governingDocumentId)) continue;
    return {
      documentId: governingDocumentId,
      family: family.family,
      reason: family.governing_reason,
      reasonDetail: family.governing_reason_detail,
      consideredDocumentIds: Object.freeze([...family.considered_document_ids]),
    };
  }

  // Exactly one eligible source is not an ambiguity to resolve; it is the only
  // source there is. Two or more with no family selection stays unresolved.
  if (params.eligibleDocumentIds.length === 1) {
    return {
      documentId: params.eligibleDocumentIds[0]!,
      family: null,
      reason: null,
      reasonDetail: 'Single eligible pricing source',
      consideredDocumentIds: Object.freeze([...params.eligibleDocumentIds]),
    };
  }

  return null;
}

/**
 * Precedence facts per document that could resolve a duplicate pair.
 *
 * Read from the precedence snapshot and the relationship graph only. Upload or
 * processing recency is deliberately absent: it is not an authority signal.
 */
function buildDuplicateAuthorityDiscriminators(params: {
  readonly precedenceFamilies: readonly ResolvedDocumentPrecedenceFamily[];
  readonly documentRelationships: readonly DocumentRelationshipRecord[];
}): ReadonlyMap<string, ContractPricingAuthorityDiscriminator> {
  const supersededBy = new Map<string, Set<string>>();
  for (const relationship of params.documentRelationships) {
    const canonicalType = canonicalizeRelationshipType(relationship.relationship_type);
    if (canonicalType !== 'supersedes' && canonicalType !== 'amends') continue;
    const target = relationship.target_document_id;
    const source = relationship.source_document_id;
    if (!target || !source) continue;
    const existing = supersededBy.get(target) ?? new Set<string>();
    existing.add(source);
    supersededBy.set(target, existing);
  }

  const discriminators = new Map<string, ContractPricingAuthorityDiscriminator>();
  for (const family of params.precedenceFamilies) {
    for (const document of family.documents) {
      discriminators.set(document.id, {
        authorityStatus: document.authority_status ?? null,
        effectiveDate: document.effective_date ?? null,
        supersededByDocumentIds: Object.freeze([
          ...(supersededBy.get(document.id) ?? []),
        ].sort((left, right) => left.localeCompare(right, 'en-US'))),
        isGoverningDocument: family.governing_document_id === document.id,
        // Carried so duplicate-authority detection can tell an approved
        // precedence signal from `upload_recency_fallback`, which the design
        // forbids as an authority discriminator.
        governingReason: family.governing_reason,
      });
    }
  }

  for (const [documentId, sources] of supersededBy) {
    if (discriminators.has(documentId)) continue;
    discriminators.set(documentId, {
      authorityStatus: null,
      effectiveDate: null,
      supersededByDocumentIds: Object.freeze(
        [...sources].sort((left, right) => left.localeCompare(right, 'en-US')),
      ),
      isGoverningDocument: false,
    });
  }

  return discriminators;
}

function prepareContractValidationContext(
  params: ContractValidationContextParams,
): PreparedContractValidationContext {
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
  const sourceSnapshot = params.sourceArtifactSnapshot?.find(
    (entry) => entry.documentId === contractDocumentId,
  ) ?? null;
  const sourceScope: ContractPricingAssemblySourceScope = {
    documentId: contractDocumentId ?? 'contract-summary',
    sourceVersionIdentity: sourceSnapshot?.exactSourceIdentity ?? null,
  };
  const sourceSha256 = sourceSnapshot?.sourceSha256 ?? null;

  // ── Pricing source scope, resolved once for every return path below ───────
  const precedenceFamilies = params.precedenceFamilies ?? [];
  const documentRelationships = params.documentRelationships ?? [];
  const excludedDocumentIds = params.excludedValidationDocumentIds ?? new Set<string>();
  const documentById = new Map(params.documents.map((document) => [document.id, document] as const));
  const inactiveDocumentIds = new Set(
    precedenceFamilies.flatMap((family) =>
      family.documents
        .filter((document) => isInactiveAuthorityStatus(document.authority_status ?? null))
        .map((document) => document.id),
    ),
  );
  const ordinarilyEligiblePricingDocumentIds = resolveEligiblePricingSourceDocumentIds({
    truthCategoryDocumentIds: params.truthCategoryDocumentIds,
    documentById,
    excludedDocumentIds,
    inactiveDocumentIds,
  });
  const sourceSnapshotByDocumentId = new Map(
    (params.sourceArtifactSnapshot ?? []).map((entry) => [entry.documentId, entry] as const),
  );
  const authoredDuplicateTargetByDocumentId = new Map<string, string>();
  for (const relationship of documentRelationships) {
    if (canonicalizeRelationshipType(relationship.relationship_type) !== 'duplicate_of') continue;
    if (!authoredDuplicateTargetByDocumentId.has(relationship.source_document_id)) {
      authoredDuplicateTargetByDocumentId.set(
        relationship.source_document_id,
        relationship.target_document_id,
      );
    }
  }
  // P1 normally removes the duplicate source before pricing assembly. When both
  // sides have immutable identity, restore it solely so the machine evidence can
  // validate the authored assertion before authority relies on that exclusion.
  const identityComparableDuplicateIds = [...authoredDuplicateTargetByDocumentId.entries()]
    .filter(([sourceId, targetId]) =>
      (params.sourceIdentityStoreState === 'unreadable'
        || (
          sourceSnapshotByDocumentId.get(sourceId)?.sourceSha256 != null
          && sourceSnapshotByDocumentId.get(targetId)?.sourceSha256 != null
        ))
      && !inactiveDocumentIds.has(sourceId))
    .map(([sourceId]) => sourceId);
  const eligiblePricingDocumentIds = [...new Set([
    ...ordinarilyEligiblePricingDocumentIds,
    ...identityComparableDuplicateIds,
  ])].sort((left, right) => left.localeCompare(right, 'en-US'));
  const attachedPricingBasisByDocumentId = new Map<string, string>();
  for (const relationship of documentRelationships) {
    const canonicalType = canonicalizeRelationshipType(relationship.relationship_type);
    if (canonicalType !== 'attached_to') continue;
    if (!attachedPricingBasisByDocumentId.has(relationship.source_document_id)) {
      attachedPricingBasisByDocumentId.set(relationship.source_document_id, canonicalType);
    }
  }
  const additionalPricingSources: readonly PreparedContractPricingSource[] = Object.freeze(
    eligiblePricingDocumentIds
      .filter((documentId) => documentId !== contractDocumentId)
      .flatMap((documentId) => {
        const document = documentById.get(documentId);
        if (!document) return [];
        const rows = buildPersistedPricingSourceRateScheduleRows(document);
        if (rows == null || rows.length === 0) return [];
        const entry = params.sourceArtifactSnapshot?.find(
          (candidate) => candidate.documentId === documentId,
        ) ?? null;
        return [Object.freeze({
          sourceScope: {
            documentId,
            sourceVersionIdentity: entry?.exactSourceIdentity ?? null,
          },
          sourceSha256: entry?.sourceSha256 ?? null,
          authoredDuplicateTargetDocumentId:
            authoredDuplicateTargetByDocumentId.get(documentId) ?? null,
          rateScheduleRows: rows,
          relationshipBasis: attachedPricingBasisByDocumentId.get(documentId) ?? null,
        })];
      }),
  );
  const pricingScope = {
    sourceSha256,
    authoredDuplicateTargetDocumentId:
      authoredDuplicateTargetByDocumentId.get(sourceScope.documentId) ?? null,
    additionalPricingSources,
    scheduleGovernance: resolvePricingScheduleGovernance({
      precedenceFamilies,
      eligibleDocumentIds: eligiblePricingDocumentIds,
    }),
    duplicateAuthorityDiscriminators: buildDuplicateAuthorityDiscriminators({
      precedenceFamilies,
      documentRelationships,
    }),
    sourceIdentityStoreState: params.sourceIdentityStoreState ?? 'read',
    sourceIdentityReadError: params.sourceIdentityReadError ?? null,
  } as const;
  if (contractDocumentId) {
    const document = params.documents.find((candidate) => candidate.id === contractDocumentId) ?? null;
    if (document) {
      const contractFacts = params.factsByDocumentId.get(contractDocumentId) ?? [];
      const hasHumanOverrides = contractFacts.some(
        (fact) => fact.source === 'human_override' || fact.source === 'human_review',
      );
      // Computed regardless of hasHumanOverrides: fact overrides confirm scalar
      // pricing-model fields (e.g. disposal_fee_treatment, rate_schedule_kind),
      // never individual rate_schedule_rows entries. The synthetic re-derivation
      // path below rebuilds rate_schedule_rows from a low-fidelity page-text
      // fallback, so we still prefer the richer persisted-trace extraction for
      // that one field when it has more rows than the synthetic result.
      const persistedContext = buildPersistedContractValidationContextFromTrace(document);

      if (!hasHumanOverrides) {
        if (persistedContext) {
          return {
            sourceScope,
            ...pricingScope,
            authoritativeRateScheduleRows: persistedContext.analysis.rate_schedule_rows ?? [],
            candidateOnlyRateScheduleRows: [],
            finalize: () => ({
              ...persistedContext,
              relationship_context: relationshipContext,
            }),
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
        const analysisInput: AnalyzeContractIntelligenceInput = {
          primaryDocument: syntheticDocument,
          relatedDocuments: [],
          confirmedGoverningScheduleResolved,
          confirmedDisposalTreatmentResolved,
        };
        const structuralRateScheduleRows = buildContractIntelligenceRateScheduleRows(
          analysisInput,
        );
        const persistedRateScheduleRows = persistedContext?.analysis.rate_schedule_rows;
        const preferPersistedRateSchedule =
          persistedRateScheduleRows != null
          && persistedRateScheduleRows.length > structuralRateScheduleRows.length;
        const authoritativeRateScheduleRows = preferPersistedRateSchedule
          ? persistedRateScheduleRows
          : structuralRateScheduleRows;
        const candidateInputRole = preferPersistedRateSchedule
          ? 'structural_candidate' as const
          : 'authoritative_rate_schedule' as const;

        return {
          sourceScope,
          ...pricingScope,
          authoritativeRateScheduleRows,
          candidateOnlyRateScheduleRows: preferPersistedRateSchedule
            ? structuralRateScheduleRows
            : [],
          selectedCategoryBySourceRow: preferPersistedRateSchedule
            ? undefined
            : buildContractPricingSelectedCategoryOverrides(
              authoritativeRateScheduleRows,
              sourceScope,
              'authoritative_rate_schedule',
            ),
          finalize: (assembly) => {
            const analysis = analyzeContractIntelligence({
              ...analysisInput,
              pricingAssembly: {
                sourceScope,
                candidateInputRole,
                structuralRateScheduleRows,
                candidatesBySourceRow: assembly.candidatesBySourceRow,
              },
            });
            if (!analysis) return null;
            return {
              document_id: contractDocumentId,
              analysis: preferPersistedRateSchedule
                ? { ...analysis, rate_schedule_rows: persistedRateScheduleRows }
                : analysis,
              evidence_by_id: new Map(
                syntheticDocument.evidence.map((evidence) => [evidence.id, evidence] as const),
              ),
              relationship_context: relationshipContext,
            };
          },
        };
      }
    }
  }

  const persistedProjectContext = buildPersistedContractValidationContextFromProjectSummary(
    params.projectValidationSummary,
  );
  if (persistedProjectContext) {
    return {
      sourceScope,
      ...pricingScope,
      authoritativeRateScheduleRows: persistedProjectContext.analysis.rate_schedule_rows ?? [],
      candidateOnlyRateScheduleRows: [],
      finalize: () => ({
        ...persistedProjectContext,
        relationship_context: relationshipContext,
      }),
    };
  }

  return {
    sourceScope,
    ...pricingScope,
    authoritativeRateScheduleRows: [],
    candidateOnlyRateScheduleRows: [],
    finalize: () => null,
  };
}

/**
 * Runs the assembler once per eligible pricing source and merges the results.
 *
 * The contract scope is assembled first and drives the contract validation
 * context, exactly as before. Each additional eligible pricing document is then
 * assembled under its OWN scope, so its rows carry its own source identity and
 * its own evidence lineage. Source-row identities already include the document,
 * so the merged candidate map cannot collide across sources.
 *
 * Ordering is the resolver's document order, which is itself derived from the
 * precedence snapshot — never iteration or insertion order.
 */
function executePreparedContractPricingAssembly(
  prepared: PreparedContractValidationContext,
): {
  readonly contractValidationContext: ValidatorContractAnalysisContext | null;
  readonly assembly: ContractPricingAssemblyResult;
  readonly duplicateAuthorityFindings: readonly ContractPricingDuplicateAuthorityFinding[];
} {
  // One plan entry per eligible source, contract scope first. The assembler
  // still has exactly ONE call site; it is invoked once per entry rather than
  // once per project, which is what keeps per-document identity intact.
  const assemblyPlan = [
    {
      scope: prepared.sourceScope,
      rateScheduleRows: prepared.authoritativeRateScheduleRows,
      sources: { selectedCategoryBySourceRow: prepared.selectedCategoryBySourceRow },
      candidateOnlyRateScheduleRows: prepared.candidateOnlyRateScheduleRows,
      relationshipBasis: null as string | null,
      sourceSha256: prepared.sourceSha256,
      authoredDuplicateTargetDocumentId: prepared.authoredDuplicateTargetDocumentId,
    },
    ...prepared.additionalPricingSources.map((source) => ({
      scope: source.sourceScope,
      rateScheduleRows: source.rateScheduleRows,
      sources: {} as ContractPricingAssemblySourceOptions,
      candidateOnlyRateScheduleRows: [] as readonly ContractRateScheduleRow[],
      relationshipBasis: source.relationshipBasis,
      sourceSha256: source.sourceSha256,
      authoredDuplicateTargetDocumentId: source.authoredDuplicateTargetDocumentId,
    })),
  ];

  const assembled = assemblyPlan.map((entry) => ({
    entry,
    assembly: assembleContractPricingRowsWithCandidates(
      entry.rateScheduleRows,
      entry.scope,
      entry.sources,
      entry.candidateOnlyRateScheduleRows,
    ),
  }));

  // The contract scope is always the first plan entry, and it alone finalizes
  // the contract validation context.
  const contractAssembly = assembled[0]!.assembly;

  const candidatesBySourceRow = new Map<
    ContractPricingSourceRowIdentity,
    readonly ContractPricingAssemblyRow[]
  >();
  for (const entry of assembled) {
    for (const [identity, candidates] of entry.assembly.candidatesBySourceRow) {
      candidatesBySourceRow.set(identity, candidates);
    }
  }

  const logicalSourceResolution = resolveContractPricingLogicalSources({
    sources: assembled.map((entry) => ({
      documentId: entry.entry.scope.documentId,
      sourceVersionIdentity: entry.entry.scope.sourceVersionIdentity,
      sourceSha256: entry.entry.sourceSha256,
      authoredDuplicateTargetDocumentId: entry.entry.authoredDuplicateTargetDocumentId,
      relationshipBasis: entry.entry.relationshipBasis,
      rows: entry.assembly.selectedRows,
    })),
    sourceIdentityStoreState: prepared.sourceIdentityStoreState,
    sourceIdentityReadError: prepared.sourceIdentityReadError,
    discriminators: prepared.duplicateAuthorityDiscriminators,
  });

  const assembly: ContractPricingAssemblyResult = Object.freeze({
    selectedRows: logicalSourceResolution.selectedRows,
    candidatesBySourceRow,
  });

  return {
    contractValidationContext: prepared.finalize(contractAssembly),
    assembly,
    duplicateAuthorityFindings: logicalSourceResolution.findings,
  };
}

export function buildContractValidationContext(
  params: ContractValidationContextParams,
): ValidatorContractAnalysisContext | null {
  return buildContractPricingExecution(params).contractValidationContext;
}

/**
 * The full contract pricing execution: the validation context, the assembled
 * rows across every eligible source, and any unresolved duplicate authority.
 *
 * Same single chokepoint as {@link buildContractValidationContext}; this one
 * simply does not discard the assembly and diagnostics the caller needs.
 */
export function buildContractPricingExecution(
  params: ContractValidationContextParams,
): {
  readonly contractValidationContext: ValidatorContractAnalysisContext | null;
  readonly assembly: ContractPricingAssemblyResult;
  readonly duplicateAuthorityFindings: readonly ContractPricingDuplicateAuthorityFinding[];
  readonly scheduleGovernance: ResolvedPricingScheduleGovernance | null;
} {
  const prepared = prepareContractValidationContext(params);
  return {
    ...executePreparedContractPricingAssembly(prepared),
    scheduleGovernance: prepared.scheduleGovernance,
  };
}

function buildFactLookups(params: {
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  contractValidationContext: ValidatorContractAnalysisContext | null;
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
  truthCategoryDocumentIds: ProjectValidatorInput['truthCategoryDocumentIds'];
  assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
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
    assembledContractPricingRows: params.assembledContractPricingRows,
  });
  const contractAnalysisRateSchedulePresent =
    params.contractValidationContext?.analysis.pricing_model?.rate_schedule_present?.value === true;
  const derivedRateRowCount =
    rateScheduleItems.length > 0
      ? rateScheduleItems.length
      : toNumber(rateRowCountFact?.value ?? null);

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

export function applyEffectiveInvoiceFacts(params: {
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
        .map((entry, index) => completeEffectiveInvoiceLineCanonicalFields({
          row: {
            ...entry,
            id: readRowString(entry, ['id', 'invoice_line_id', 'line_id']) ?? `fact:${documentId}:line:${index + 1}`,
            invoice_id: readRowString(entry, ['invoice_id', 'source_invoice_id']) ?? invoiceId,
            invoice_number: readRowString(entry, ['invoice_number', 'invoice_no']) ?? invoiceNumber,
            source_document_id: readRowString(entry, ['source_document_id', 'document_id']) ?? documentId,
          },
          effectiveFactSource: fact.source,
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
  return buildValidatorInputFromSourceSnapshot(await loadValidatorSourceSnapshot(projectId));
}

/**
 * Everything one validation execution loads and derives BEFORE the authority
 * decision is made.
 *
 * This is the frozen boundary the legacy/canonical shadow comparator runs both
 * authorities against. Two properties make it the right seam:
 *
 *  - it contains no authority-dependent value, so building an input from it is a
 *    pure function of `(snapshot, authorityMode)`;
 *  - every database read for the execution has already happened, so a second
 *    authority run cannot reload documents, reread publication storage, or
 *    rerun OCR or extraction.
 *
 * Fields are deliberately the exact objects the previous single-pass loader
 * retained, so the serving path's behavior is unchanged by the split.
 */
export type ValidatorSourceSnapshot = {
  readonly project: ValidatorProjectRow;
  readonly validationPhase: ProjectValidationPhase;
  readonly documents: ValidatorDocumentRow[];
  readonly ruleStateByRuleId: Map<string, ValidationRuleState>;
  readonly mobileTickets: MobileTicketRow[];
  readonly loadTickets: LoadTicketRow[];
  readonly transactionData: ProjectTransactionData | null;
  readonly sourceArtifactSnapshot: readonly ValidatorSourceArtifactSnapshotEntry[];
  /** Whether the identity store answered at all — see D1 in the C3 design. */
  readonly sourceIdentityStoreState: ValidatorSourceIdentityStoreState;
  readonly sourceIdentityReadError: SourceIdentityReadFailure | null;
  readonly precedenceFamilies: ResolvedDocumentPrecedenceFamily[];
  readonly documentRelationships: DocumentRelationshipRecord[];
  readonly familyDocumentIds: ValidatorDocumentIdsByFamily;
  readonly governingDocumentIds: ValidatorDocumentIdsByFamily;
  readonly truthCategoryDocumentIds: ValidatorTruthCategoryDocumentIds;
  readonly factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  readonly allFacts: ValidatorFactRecord[];
  readonly invoices: InvoiceRow[];
  readonly invoiceLines: InvoiceLineRow[];
  readonly assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
  readonly contractValidationContext: ValidatorContractAnalysisContext | null;
  /** Unresolved duplicate pricing authority, blocking when non-empty. */
  readonly contractPricingDuplicateAuthority: readonly ContractPricingDuplicateAuthorityFinding[];
  readonly pricingScheduleGovernance: ResolvedPricingScheduleGovernance | null;
  readonly baseFactLookups: ValidatorFactLookups;
  readonly contractUploadGuidanceRateScheduleIncluded: ContractUploadGuidanceRateScheduleIncluded | null;
  readonly invoiceLineRateLinkRows: readonly InvoiceLineRateLinkRow[];
  readonly sourceArtifactSnapshotDigest: string | null;
};

/**
 * Performs every read and every authority-independent derivation for one
 * execution, exactly once.
 */
export async function loadValidatorSourceSnapshot(
  projectId: string,
): Promise<ValidatorSourceSnapshot> {
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
    transactionData,
    sourceArtifactSnapshotResult,
  ] =
    await Promise.all([
      loadExtractionFactRows(documentIds),
      loadLegacyExtractionRows(documentIds),
      loadDocumentFactOverrides(documentIds),
      loadDocumentFactReviews(documentIds),
      loadRuleState(projectId),
      loadStructuredRows('mobile_tickets', projectId),
      loadStructuredRows('load_tickets', projectId),
      getCanonicalTransactionDataForProject({
        projectId,
        documentIds,
      }),
      loadSourceArtifactSnapshot({ project, documents }),
    ]);

  const sourceArtifactSnapshot = sourceArtifactSnapshotResult.entries;

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
    existingInvoices: [],
    existingInvoiceLines: [],
  });
  const baseInvoices = syntheticInvoices.invoices;
  const baseInvoiceLines = syntheticInvoices.invoiceLines;
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
  const preparedContractValidationContext = prepareContractValidationContext({
    projectValidationSummary: project.validation_summary_json,
    documents,
    factsByDocumentId,
    legacyRowsByDocumentId,
    truthCategoryDocumentIds,
    sourceArtifactSnapshot,
    precedenceFamilies,
    documentRelationships,
    excludedValidationDocumentIds,
    sourceIdentityStoreState: sourceArtifactSnapshotResult.storeState,
    sourceIdentityReadError: sourceArtifactSnapshotResult.readError,
  });
  const contractPricingExecution = executePreparedContractPricingAssembly(
    preparedContractValidationContext,
  );
  const contractValidationContext = contractPricingExecution.contractValidationContext;
  const assembledContractPricingRows = retainAssembledContractPricingRows(
    contractPricingExecution.assembly.selectedRows,
  );
  const baseFactLookups = buildFactLookups({
    factsByDocumentId,
    contractValidationContext,
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds,
    assembledContractPricingRows,
  });

  // The last two reads of the execution. Both are authority-independent: the
  // guidance row is keyed by contract document, and the rate-link rows are
  // scoped by organization and project. Resolving links against the winning
  // authority's rate rows is a pure step, performed per authority below.
  const contractDocumentIdForGuidance =
    contractValidationContext?.document_id ?? truthCategoryDocumentIds.contract_identity[0] ?? null;
  const [contractUploadGuidance, invoiceLineRateLinkRows] = await Promise.all([
    contractDocumentIdForGuidance
      ? loadContractUploadGuidanceForDocument(getSupabaseAdmin()!, contractDocumentIdForGuidance).catch(
        () => null,
      )
      : Promise.resolve(null),
    loadInvoiceLineRateLinkRows(project),
  ]);

  return {
    project,
    validationPhase,
    documents,
    ruleStateByRuleId,
    mobileTickets: mobileTickets as MobileTicketRow[],
    loadTickets: loadTickets as LoadTicketRow[],
    transactionData: transactionData ?? null,
    sourceArtifactSnapshot,
    sourceIdentityStoreState: sourceArtifactSnapshotResult.storeState,
    sourceIdentityReadError: sourceArtifactSnapshotResult.readError,
    precedenceFamilies,
    documentRelationships,
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds,
    factsByDocumentId,
    allFacts,
    invoices: effectiveInvoices,
    invoiceLines: effectiveInvoiceLines,
    assembledContractPricingRows,
    contractValidationContext,
    contractPricingDuplicateAuthority: contractPricingExecution.duplicateAuthorityFindings,
    pricingScheduleGovernance: preparedContractValidationContext.scheduleGovernance,
    baseFactLookups,
    contractUploadGuidanceRateScheduleIncluded: contractUploadGuidance?.rate_schedule_included ?? null,
    invoiceLineRateLinkRows,
    sourceArtifactSnapshotDigest: buildSourceArtifactSnapshotDigest(sourceArtifactSnapshot),
  };
}

/**
 * Builds one validator input from a frozen source snapshot under one authority.
 *
 * Pure and synchronous: given the same snapshot and the same authority mode this
 * always produces the same input. That is what makes a two-authority comparison
 * possible without reloading anything and without either run being able to
 * observe the other's work — the snapshot's collections are read, never mutated,
 * and every authority-dependent structure below is freshly constructed.
 *
 * `authorityMode`, when supplied, overrides the ambient environment for THIS
 * input only. The serving path omits it so production behavior continues to come
 * from `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY` alone.
 */
export function buildValidatorInputFromSourceSnapshot(
  snapshot: ValidatorSourceSnapshot,
  options: { readonly authorityMode?: ProjectTruthAuthorityMode } = {},
): ProjectValidatorInput {
  const {
    project,
    validationPhase,
    documents,
    assembledContractPricingRows,
    contractValidationContext,
    truthCategoryDocumentIds,
    familyDocumentIds,
    governingDocumentIds,
    factsByDocumentId,
    allFacts,
    ruleStateByRuleId,
    mobileTickets,
    loadTickets,
    precedenceFamilies,
    sourceArtifactSnapshot,
    documentRelationships,
  } = snapshot;
  const effectiveInvoices = snapshot.invoices;
  const effectiveInvoiceLines = snapshot.invoiceLines;
  const baseFactLookups = snapshot.baseFactLookups;
  const transactionData = snapshot.transactionData ?? undefined;
  // An explicit mode is expressed as a scoped environment record rather than a
  // second code path, so both authorities travel through the identical resolver
  // the serving path uses.
  const env: Readonly<Record<string, string | undefined>> | undefined =
    options.authorityMode != null
      ? { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: options.authorityMode }
      : undefined;
  // ── The single authority decision for this execution ──────────────────────
  // Resolved exactly once, before any rule pack runs. In canonical mode the
  // frozen canonical registry section replaces legacy rate schedule items; in
  // legacy mode the legacy items pass through untouched. Downstream packs and
  // the manual-link/rate-map builders below consume whichever authority won,
  // without knowing which it was.
  const projectTruthAuthority = resolveProjectTruthAuthority({
    projectId: project.id,
    env,
    assembledContractPricingRows,
    contractPricingDuplicateAuthority: snapshot.contractPricingDuplicateAuthority,
    pricingContext: {
      // Schedule governance is READ from the precedence family that resolved it
      // (`governing_document_id`), not re-derived from row agreement — rows from
      // two sources never agree, and agreeing is not what makes a document
      // govern. Falls back to the assembled contract document only when the
      // family established no governance.
      documentId: snapshot.pricingScheduleGovernance?.documentId
        ?? contractValidationContext?.document_id
        ?? null,
      // Schedule identity is not exposed on the validator contract context.
      // Left null rather than inferred; the registry digest still pins the
      // exact resolved rows.
      scheduleId: null,
      scheduleName: null,
    },
    governingDocumentFamily: snapshot.pricingScheduleGovernance?.family ?? null,
    legacyRateScheduleItems: baseFactLookups.rateScheduleItems,
    // Transaction and document-relationship truth join the same single
    // assembly. These are the frozen objects already retained by validator-input
    // construction; canonical mode adapts them and never re-reads sources.
    transactionRows: transactionData?.rows ?? [],
    transactionDatasets: transactionData?.datasets ?? [],
    // Effective invoice truth, already scoped and override-applied above.
    invoiceRows: effectiveInvoices,
    invoiceLineRows: effectiveInvoiceLines,
    sourceArtifactIdByDocumentId: buildSourceArtifactIdByDocumentId(sourceArtifactSnapshot),
    sourceIdentityStoreState: snapshot.sourceIdentityStoreState,
    sourceIdentityReadError: snapshot.sourceIdentityReadError,
    documentFamilyByDocumentId: buildDocumentFamilyByDocumentId(familyDocumentIds),
    governingDocumentIds,
    familyDocumentIds,
    documentRelationships,
    sourceArtifactSnapshotDigest: snapshot.sourceArtifactSnapshotDigest,
  });
  // Canonical truth governs only when it actually established. A blocked or
  // failed canonical context must NOT quietly hand back legacy items: the block
  // is surfaced as an honest validation outcome instead.
  const authoritativeRateScheduleItems = isCanonicalAuthorityEstablished(projectTruthAuthority)
    ? [...projectTruthAuthority.validatorProjection!.rateScheduleItems]
    : isCanonicalAuthorityUnavailable(projectTruthAuthority)
      ? []
      : [...baseFactLookups.rateScheduleItems];

  const factLookups = {
    ...baseFactLookups,
    rateScheduleItems: authoritativeRateScheduleItems,
    contractUploadGuidanceRateScheduleIncluded: snapshot.contractUploadGuidanceRateScheduleIncluded,
  };
  const manualRateLinkOverrides = buildManualRateLinkOverrides({
    rows: snapshot.invoiceLineRateLinkRows,
    rateScheduleItems: factLookups.rateScheduleItems,
  });
  const mobileToLoadsMap = buildMobileToLoadsMap(snapshot.loadTickets);
  const invoiceLineToRateMap = buildInvoiceLineToRateMap(
    effectiveInvoiceLines,
    factLookups.rateScheduleItems,
    manualRateLinkOverrides,
  );
  // ── Transaction authority reroute ────────────────────────────────────────
  // In canonical mode the rows every downstream consumer reads — exposure,
  // reconciliation, and the transaction rule packs — are the canonical
  // projection. Swapping this single array moves all of them onto canonical
  // truth without any rule pack knowing which authority produced it. Legacy and
  // canonical rows are never both active in one execution.
  const canonicalTransactionRows = isCanonicalAuthorityEstablished(projectTruthAuthority)
    ? projectCanonicalTransactionRows(
      projectTruthAuthority.validatorProjection!.transactions.rows,
      project.id,
    )
    // A blocked or failed canonical context must NOT hand back legacy rows.
    // Mirroring the rate-schedule seam, transaction truth becomes empty so the
    // block surfaces as an honest outcome instead of a legacy rescue that
    // would mix authorities inside one run.
    : isCanonicalAuthorityUnavailable(projectTruthAuthority)
      ? []
      : null;
  const effectiveTransactionData = canonicalTransactionRows != null
    ? { datasets: transactionData?.datasets ?? [], rows: canonicalTransactionRows }
    : transactionData;
  const validatorTransactionData = effectiveTransactionData
    ? {
      ...effectiveTransactionData,
      rollups: buildValidatorTransactionRollups(effectiveTransactionData),
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
    mobileTickets,
    loadTickets,
    fallbackTotalBilled: readPersistedProjectTotalBilled(project.validation_summary_json),
  });
  const baseInput = {
    project,
    validationPhase,
    documents,
    assembledContractPricingRows,
    sourceArtifactSnapshot,
    documentRelationships,
    precedenceFamilies,
    familyDocumentIds,
    governingDocumentIds,
    truthCategoryDocumentIds,
    ruleStateByRuleId,
    factsByDocumentId,
    allFacts,
    mobileTickets,
    loadTickets,
    invoices: effectiveInvoices,
    invoiceLines: effectiveInvoiceLines,
    mobileToLoadsMap,
    invoiceLineToRateMap,
    manualRateLinkOverrides,
    projectTotals,
    factLookups,
    contractValidationContext,
    transactionData: validatorTransactionData,
    projectTruthAuthority,
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

export async function runProjectValidation(
  projectId: string,
): Promise<{
  result: ValidatorResult;
  input: ProjectValidatorInput;
  sourceSnapshot: ValidatorSourceSnapshot;
}> {
  const sourceSnapshot = await loadValidatorSourceSnapshot(projectId);
  const { result, input } = executeProjectValidation(
    buildValidatorInputFromSourceSnapshot(sourceSnapshot),
  );
  return { result, input, sourceSnapshot };
}

/**
 * Runs every rule pack, exposure, and finalization for one already-built input.
 *
 * Synchronous and side-effect free: it reads the input, produces findings, and
 * returns a result. It never persists, publishes, notifies, or mutates project
 * state — those belong to the serving orchestration above it. This is what makes
 * a second, non-serving authority execution safe to run in memory.
 */
export function executeProjectValidation(
  input: ProjectValidatorInput,
): { result: ValidatorResult; input: ProjectValidatorInput } {
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

  findings.push(...runAuthoredRateRowQuarantineRules(input));
  rulesApplied.push(PACK_AUTHORED_RATE_ROW_QUARANTINE);

  // Canonical ticket-grain conflicts run before the gating packs so a disputed
  // quantity or amount blocks rather than silently feeding downstream totals.
  // Contributes nothing in legacy mode.
  findings.push(...runTransactionGrainConflictRules(input));
  rulesApplied.push(PACK_TRANSACTION_GRAIN_CONFLICT);

  // Canonical identity and governing-relationship integrity runs alongside the
  // grain-conflict pack, before the gating packs, so an unresolved invoice
  // identity or a conflicting governing contract blocks rather than letting a
  // downstream total consume ambiguous truth. Contributes nothing in legacy mode.
  findings.push(...runCanonicalTruthIntegrityRules(input));
  rulesApplied.push(PACK_CANONICAL_TRUTH_INTEGRITY);

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
      return {
        input,
        result: finalizeResult(findings, rulesApplied, {
          contractInvoiceReconciliation,
          invoiceTransactionReconciliation,
          crossDocumentRateVerification,
          reconciliation,
          exposure,
          overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
          contractDocumentId: input.factLookups.contractDocumentId,
          contractValidationContext: input.contractValidationContext,
          validationPhase: input.validationPhase,
        }),
      };
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

  return {
    input,
    result: finalizeResult(findings, rulesApplied, {
      contractInvoiceReconciliation,
      invoiceTransactionReconciliation,
      crossDocumentRateVerification,
      reconciliation,
      exposure,
      overviewFinancials: deriveWorkspaceOverviewFinancials(input, exposure),
      contractDocumentId: input.factLookups.contractDocumentId,
      contractValidationContext: input.contractValidationContext,
      validationPhase: input.validationPhase,
    }),
  };
}

export async function validateProject(projectId: string): Promise<ValidatorResult> {
  return (await runProjectValidation(projectId)).result;
}

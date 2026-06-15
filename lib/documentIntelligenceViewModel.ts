import {
  findEvidenceByValueMatch,
  hasInspectableValue,
} from '@/lib/extraction/evidenceValueMatch';
import {
  type DocumentFactAnchorType,
  type DocumentFactAnchorRecord,
  type DocumentFactAnchorRect,
} from '@/lib/documentFactAnchors';
import {
  type DocumentFactReviewRecord,
  type DocumentFactReviewStatus,
} from '@/lib/documentFactReviews';
import {
  displaySourceFromActionType,
  type DocumentFactDisplaySource,
  type DocumentFactOverrideActionType,
  type DocumentFactOverrideRecord,
} from '@/lib/documentFactOverrides';
import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import {
  contractCeilingSummary,
  isRatePriceNoCeilingMachineClassification,
} from '@/lib/contracts/contractCeiling';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import {
  assembleContractPricingRows,
  type ContractPricingAssemblyRow,
} from '@/lib/contracts/contractPricingAssembly';
import { applyContractorIdentityResolutionToNormalizedDocument } from '@/lib/contracts/contractorIdentity';
import {
  buildCanonicalTransactionSummaryFromRows,
  resolveCanonicalProjectFacts,
  spreadsheetReviewReadinessStatusForProjectFacts,
  type CanonicalProjectTransactionRowInput,
} from '@/lib/projectFacts';
import {
  normalizeCanonicalInvoiceNumber,
  recoverInvoiceLineItemsFromExtractionData,
  resolveInvoiceLineUnitPrice,
} from '@/lib/invoices/invoiceParser';
import { normalizeInvoiceContractorDisplay } from '@/lib/invoices/invoiceCanonicalNames';
import type { PipelineFact } from '@/lib/pipeline/types';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  AuditNote,
  DocumentExecutionTrace,
  DocumentFamily,
  InvoiceExtraction,
  NormalizedDecision,
  PipelineTraceNode,
  TransactionDataExtraction,
} from '@/lib/types/documentIntelligence';
import type {
  TransactionDataDisposalSiteGroup,
  TransactionDataDmsFdsLifecycleSummary,
  TransactionDataInvoiceGroup,
  TransactionDataInvoiceReadinessSummary,
  TransactionDataMaterialGroup,
  TransactionDataOutlierRow,
  TransactionDataProjectOperationsOverview,
  TransactionDataRateCodeGroup,
  TransactionDataRecord,
  TransactionDataServiceItemGroup,
  TransactionDataSiteMaterialGroup,
  TransactionDataSiteTypeGroup,
} from '@/lib/types/transactionData';
import type { ValidationFinding } from '@/types/validator';
import {
  normalizeSpreadsheetEligibility,
  ticketTypeBucketFromRawRow,
} from '@/lib/spreadsheetDocumentReview';
import {
  RAW_TICKET_KEYS,
  rawRowText,
} from '@/lib/extraction/xlsx/normalizeTransactionData';

export { normalizeInvoiceContractorDisplay } from '@/lib/invoices/invoiceCanonicalNames';

export type DocumentFactState =
  | 'auto'
  | 'reviewed'
  | 'overridden'
  | 'missing'
  | 'conflicted'
  | 'derived';

export type DocumentFactValueType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'boolean'
  | 'array'
  | 'unknown';

export type DocumentIntelligenceTone = 'neutral' | 'accent' | 'good' | 'warning' | 'danger';

export type EvidenceGeometry = {
  polygon: Array<[number, number]>;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  layoutWidth?: number;
  layoutHeight?: number;
};

export type DocumentEvidenceAnchor = {
  id: string;
  factId: string;
  evidenceId: string;
  sourceDocumentId: string;
  anchorSource: 'machine' | 'human';
  anchorType: DocumentFactAnchorType;
  overrideId?: string | null;
  isPrimary?: boolean;
  pageNumber: number | null;
  startPage: number | null;
  endPage: number | null;
  snippet: string | null;
  quoteText: string | null;
  parserSource: string;
  sourceLayer: string;
  sourceRegionId: string | null;
  matchType: string;
  extractionVersion: string | null;
  startOffset: number | null;
  endOffset: number | null;
  confidence: number | null;
  weak: boolean;
  geometry: EvidenceGeometry | null;
  /** How coordinates were resolved for this anchor (diagnostics / coverage). */
  geometryResolution?: 'evidence_id' | 'source_element_id' | 'text_overlap' | 'none';
};

export type DocumentFactOverrideHistoryItem = {
  id: string;
  fieldKey: string;
  valueJson: unknown;
  valueDisplay: string;
  rawValue: string | null;
  actionType: DocumentFactOverrideActionType;
  displaySource: Exclude<DocumentFactDisplaySource, 'auto'>;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
  supersedesOverrideId: string | null;
};

export type DocumentFactReviewSummary = {
  reviewStatus: DocumentFactReviewStatus;
  reviewedBy: string;
  reviewedAt: string;
  notes: string | null;
};

export type DocumentFactReviewHistoryItem = {
  id: string;
  fieldKey: string;
  reviewStatus: DocumentFactReviewStatus;
  reviewedValueJson: unknown;
  reviewedValueDisplay: string | null;
  reviewedBy: string;
  reviewedAt: string;
  notes: string | null;
};

export type DocumentFact = {
  id: string;
  documentId: string;
  fieldKey: string;
  fieldLabel: string;
  schemaGroup: string;
  schemaGroupLabel: string;
  valueType: DocumentFactValueType;
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  valueBoolean: boolean | null;
  normalizedValue: unknown;
  normalizedDisplay: string;
  rawValue: string | null;
  rawDisplay: string | null;
  confidence: number | null;
  confidenceLabel: 'high' | 'medium' | 'low' | 'none';
  confidenceReason: string | null;
  reviewState: DocumentFactState;
  statusLabel: string;
  evidenceCount: number;
  anchorCount: number;
  primaryPage: number | null;
  primaryAnchor: DocumentEvidenceAnchor | null;
  anchors: DocumentEvidenceAnchor[];
  normalizationNotes: string[];
  missingSourceContext: string[];
  derivationKind: string | null;
  displaySource: DocumentFactDisplaySource;
  displayValue: string;
  machineValue: unknown;
  machineDisplay: string;
  humanValue: unknown;
  humanDisplay: string | null;
  reviewStatus: DocumentFactReviewStatus | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  reviewHistory: DocumentFactReviewHistoryItem[];
  humanDefinedSchedule: boolean;
  overrideHistory: DocumentFactOverrideHistoryItem[];
  /** Pipeline normalizeNode resolution path (undefined for adapter-only facts). */
  pipelineEvidenceResolution?: 'primary' | 'value_fallback' | 'none';
  relatedDecisionIds: string[];
  relatedDecisionTitles: string[];
  /**
   * Pipeline normalizeNode tag for special presentation (not a separate ledger fact).
   * Example: `rate_price_no_ceiling` on contract_ceiling.
   */
  machineClassification?: string | null;
};

export type DocumentFactGroup = {
  key: string;
  label: string;
  order: number;
  facts: DocumentFact[];
  factCount: number;
  missingCount: number;
  conflictedCount: number;
};

export type DocumentIntelligenceStripItem = {
  key: string;
  label: string;
  value: string;
  detail?: string;
  tone: DocumentIntelligenceTone;
};

export type DiagnosticsDrawerModel = {
  id: string;
  title: string;
  summary: string;
  json?: unknown;
  textBlocks?: Array<{
    id: string;
    label: string;
    description?: string;
    content: string;
  }>;
  rowInspection?: {
    label: string;
    rows: Array<{
      row_id: string;
      rate_code: string | null;
      row_role: string;
      confidence: number | null;
      warnings: string[];
    }>;
  };
};

export type DocumentSourceTextPage = {
  pageNumber: number;
  sourceMethod: string | null;
  text: string;
};

export type SpreadsheetReviewKpis = {
  totalTickets: number;
  totalCyd: number | null;
  totalNetTonnage: number | null;
  invoicedTickets: number;
  totalInvoices: number;
  totalInvoicedAmount: number;
  uninvoicedLines: number;
  eligible: number;
  ineligible: number;
};

export type SpreadsheetReviewVolumeBasis = {
  metric: 'cyd' | 'net_tonnage' | null;
  unitLabel: 'CYD' | 'Tons' | null;
  headerLabel: string;
};

export type SpreadsheetReviewRateCodeRow = {
  rateCode: string | null;
  description: string | null;
  ticketCount: number;
  amount: number | null;
};

export type SpreadsheetReviewFlowRow = {
  label: string;
  ticketCount: number;
  eligibleTickets: number | null;
  ineligibleTickets: number | null;
  volume: number | null;
  percentOfTotalVolume: number | null;
  amount: number | null;
  percentOfTotalCost: number | null;
};

export type SpreadsheetReviewServiceItemRow = {
  serviceItem: string;
  ticketCount: number;
  eligibleTickets: number | null;
  ineligibleTickets: number | null;
  diameterUnits: number | null;
  amount: number | null;
  percentOfTotalServiceCost: number | null;
};

export type SpreadsheetReviewRiskSummary = {
  highRiskIssues: number;
  mediumRiskIssues: number;
  lowRiskIssues: number;
  ticketsAffected: number;
  invoicesAffected: number;
  estimatedAmountAtRisk: number | null;
};

export type SpreadsheetReviewRiskIssueRow = {
  issueType: string;
  severity: 'High' | 'Medium' | 'Low';
  ticketCount: number;
  affectedTicketPreview: string | null;
  invoiceCount: number;
  amountImpact: number | null;
  whyItMatters: string;
  actionNeeded: string;
};

export type SpreadsheetReviewRiskDrilldownRow = {
  ticketNumber: string | null;
  invoiceNumber: string | null;
  issueType: string;
  severity: 'High' | 'Medium' | 'Low';
  materialOrServiceItem: string | null;
  site: string | null;
  amount: number | null;
  reason: string;
};

export type SpreadsheetReviewDataset = {
  records: TransactionDataRecord[];
  summary: TransactionDataExtraction['summary'] | null;
  rollups: TransactionDataExtraction['rollups'] | null;
  projectOperationsOverview: TransactionDataProjectOperationsOverview | null;
  groupedByRateCode: TransactionDataRateCodeGroup[];
  groupedByServiceItemMobileOnly: TransactionDataServiceItemGroup[];
  groupedByMaterialMobileOnly: TransactionDataMaterialGroup[];
  groupedByDisposalSite: TransactionDataDisposalSiteGroup[];
  groupedBySiteType: TransactionDataSiteTypeGroup[];
  outlierRows: TransactionDataOutlierRow[];
  invoiceReadinessSummary: TransactionDataInvoiceReadinessSummary | null;
  dmsFdsLifecycleSummary: TransactionDataDmsFdsLifecycleSummary | null;
  kpis: SpreadsheetReviewKpis;
  totalExtendedCost: number | null;
  /** Pre-computed invoiced transaction count. Avoids an O(N) filter over records at render time. */
  invoicedTransactionCount: number;
  volumeBasis: SpreadsheetReviewVolumeBasis;
  rateCodeRows: SpreadsheetReviewRateCodeRow[];
  serviceItemRows: SpreadsheetReviewServiceItemRow[];
  materialRows: SpreadsheetReviewFlowRow[];
  disposalSiteRows: SpreadsheetReviewFlowRow[];
  siteTypeRows: SpreadsheetReviewFlowRow[];
  riskSummary: SpreadsheetReviewRiskSummary | null;
  groupedRiskIssues: SpreadsheetReviewRiskIssueRow[];
  riskDrilldownRows: SpreadsheetReviewRiskDrilldownRow[];
};

export type DocumentContractRateRow = {
  rowId: string;
  description: string | null;
  unit: string | null;
  rate: number | null;
  category: string | null;
  page: number | null;
  sourceAnchorIds: string[];
};

export type DocumentIntelligenceViewModel = {
  family: DocumentFamily;
  facts: DocumentFact[];
  groups: DocumentFactGroup[];
  factById: Map<string, DocumentFact>;
  defaultFactId: string | null;
  strip: DocumentIntelligenceStripItem[];
  extractionVersion: string | null;
  extractionTimestamp: string | null;
  parserStatus: string;
  schemaMappingStatus: string;
  sourceModeLabel: string;
  sourceTextPages: DocumentSourceTextPage[];
  rateScheduleSource: 'auto' | 'human';
  rateSchedulePages: string | null;
  rateScheduleAnchor: DocumentEvidenceAnchor | null;
  humanDefinedSchedule: boolean;
  pageMarkerCounts: Record<number, number>;
  counts: {
    totalFacts: number;
    lowConfidenceFacts: number;
    missingEvidenceFacts: number;
    conflictingFacts: number;
    missingFacts: number;
  };
  /** Anchor grounding coverage (facts + anchor geometry), for QA and parser feedback. */
  anchorCoverage: {
    totalFacts: number;
    factsWithAtLeastOneAnchor: number;
    factsWithValueButNoAnchor: number;
    pipelineFactsPrimaryResolution: number;
    pipelineFactsValueFallbackResolution: number;
    adapterFactsValueFallback: number;
    anchorsTotal: number;
    anchorsWithGeometry: number;
    anchorsPageOnly: number;
  };
  diagnostics: DiagnosticsDrawerModel[];
  /**
   * Typed extraction for invoice documents. Populated when family === 'invoice' and
   * the execution trace carries structured extracted data. Used by InvoiceSurface.
   */
  invoiceExtraction: InvoiceExtraction | null;
  /**
   * Typed extraction for transaction_data spreadsheets. Populated when family === 'spreadsheet'
   * and document_type includes 'transaction_data'.
   */
  transactionDataExtraction: TransactionDataExtraction | null;
  spreadsheetReviewDataset: SpreadsheetReviewDataset | null;
  contractRateRows?: DocumentContractRateRow[];
  contractPricingAssemblyRows?: ContractPricingAssemblyRow[];
};

type SupportedScalar = string | number | boolean | null;

type FlattenedField = {
  key: string;
  label: string;
  value: SupportedScalar | SupportedScalar[];
  source: 'typed_fields' | 'structured_fields' | 'section_signals' | 'trace_facts' | 'extracted';
};

function toDocumentContractRateRows(
  rows: ContractRateScheduleRow[] | null | undefined,
): DocumentContractRateRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row): DocumentContractRateRow | null => {
      const rowId = typeof row.row_id === 'string' ? row.row_id.trim() : '';
      if (!rowId) return null;

      const description =
        typeof row.description === 'string' && row.description.trim().length > 0
          ? row.description.trim()
          : null;
      const unit =
        typeof row.unit === 'string' && row.unit.trim().length > 0
          ? row.unit.trim()
          : typeof row.unit_type === 'string' && row.unit_type.trim().length > 0
            ? row.unit_type.trim()
            : null;
      const category =
        typeof row.category === 'string' && row.category.trim().length > 0
          ? row.category.trim()
          : typeof row.material_type === 'string' && row.material_type.trim().length > 0
            ? row.material_type.trim()
            : null;
      const rate =
        typeof row.rate === 'number' && Number.isFinite(row.rate)
          ? row.rate
          : typeof row.rate_amount === 'number' && Number.isFinite(row.rate_amount)
            ? row.rate_amount
            : null;
      const page =
        typeof row.page === 'number' && Number.isFinite(row.page) && row.page > 0 ? row.page : null;

      return {
        rowId,
        description,
        unit,
        rate,
        category,
        page,
        sourceAnchorIds: Array.isArray(row.source_anchor_ids)
          ? row.source_anchor_ids.filter(
              (anchorId): anchorId is string =>
                typeof anchorId === 'string' && anchorId.trim().length > 0,
            )
          : [],
      };
    })
    .filter((row): row is DocumentContractRateRow => row != null);
}

type GeometryCandidate = {
  id: string;
  pageNumber: number | null;
  text: string;
  geometry: EvidenceGeometry | null;
};

type BuildParams = {
  documentId: string;
  documentType: string | null;
  documentName: string;
  documentTitle: string | null;
  projectName: string | null;
  preferredExtraction: {
    id?: string | null;
    created_at?: string | null;
    data?: Record<string, unknown> | null;
  } | null;
  relatedDocs: RelatedDocInput[];
  normalizedDecisions: NormalizedDecision[];
  extractionGaps: ExtractionGap[];
  auditNotes: AuditNote[];
  nodeTraces: PipelineTraceNode[];
  executionTrace: DocumentExecutionTrace | null;
  extractionHistory: Array<{
    id: string;
    created_at: string;
    data: Record<string, unknown>;
  }>;
  factOverrides?: DocumentFactOverrideRecord[];
  factAnchors?: DocumentFactAnchorRecord[];
  factReviews?: DocumentFactReviewRecord[];
  projectValidationSummary?: Record<string, unknown> | null;
  projectValidationStatus?: string | null;
  projectValidationFindings?: readonly ValidationFinding[];
  transactionDatasets?: Array<Record<string, unknown>>;
  transactionRows?: Array<Record<string, unknown>>;
  reviewedDecisionIds?: Iterable<string>;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function asLooseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '').trim();
    if (cleaned.length === 0) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasMeaningfulGroupLabel(value: string | null | undefined): value is string {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'unset' && normalized !== 'unknown';
}

type SpreadsheetReviewTicketSummary = {
  ticketCount: number;
  eligibleTickets: number;
  ineligibleTickets: number;
};

type SpreadsheetReviewRiskDescriptor = {
  issueType: string;
  whyItMatters: string;
  actionNeeded: string;
};

function findRawRowValue(rawRow: Record<string, unknown>, fieldName: string): unknown {
  const normalizedFieldName = fieldName.trim().toLowerCase();
  for (const [key, value] of Object.entries(rawRow)) {
    if (key.trim().toLowerCase() === normalizedFieldName) return value;
  }
  return null;
}

function findFirstRawRowValue(rawRow: Record<string, unknown>, fieldNames: readonly string[]): unknown {
  for (const fieldName of fieldNames) {
    const value = findRawRowValue(rawRow, fieldName);
    if (value != null) return value;
  }
  return null;
}

function compareTransactionRecordOrder(left: TransactionDataRecord, right: TransactionDataRecord): number {
  const sheetDelta = left.source_sheet_name.localeCompare(right.source_sheet_name, 'en-US');
  if (sheetDelta !== 0) return sheetDelta;
  const rowDelta = left.source_row_number - right.source_row_number;
  if (rowDelta !== 0) return rowDelta;
  return left.id.localeCompare(right.id, 'en-US');
}

function diameterValueForRecord(record: TransactionDataRecord): number | null {
  const normalizedDiameter = asLooseNumber(record.diameter);
  if (normalizedDiameter != null) return normalizedDiameter;
  return asLooseNumber(findFirstRawRowValue(record.raw_row ?? {}, ['Diameter', 'Diameters']));
}

function selectTicketDiameter(records: readonly TransactionDataRecord[]): number | null {
  const orderedRecords = [...records].sort(compareTransactionRecordOrder);
  for (const record of orderedRecords) {
    const value = diameterValueForRecord(record);
    if (value != null) return value;
  }
  return null;
}

function sumServiceItemDiameters(records: readonly TransactionDataRecord[]): number | null {
  const recordsByTicket = new Map<string, TransactionDataRecord[]>();
  for (const record of records) {
    const ticketKey = normalizeTicketIdentity(record.transaction_number, `record:${record.id}`);
    const ticketRecords = recordsByTicket.get(ticketKey) ?? [];
    ticketRecords.push(record);
    recordsByTicket.set(ticketKey, ticketRecords);
  }

  let sum: number | null = null;
  for (const ticketRecords of recordsByTicket.values()) {
    const value = selectTicketDiameter(ticketRecords);
    if (value == null) continue;
    sum = (sum ?? 0) + value;
  }

  return sum;
}

function normalizeTicketIdentity(ticketNumber: string | null | undefined, fallback: string): string {
  if (typeof ticketNumber !== 'string') return fallback;
  const trimmed = ticketNumber.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : fallback;
}

function preferredTicketNumber(
  candidates: Array<string | null | undefined>,
  disallowedIdentities: readonly string[] = [],
): string | null {
  const blocked = new Set(
    disallowedIdentities
      .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
      .filter((value) => value.length > 0),
  );

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (blocked.has(trimmed.toUpperCase())) continue;
    return trimmed;
  }

  return null;
}

function normalizeInvoiceIdentity(invoiceNumber: string | null | undefined): string | null {
  if (typeof invoiceNumber !== 'string') return null;
  const trimmed = invoiceNumber.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

function normalizeEligibilityBucket(value: string | null | undefined): 'eligible' | 'ineligible' {
  return normalizeSpreadsheetEligibility(value);
}

function readLegacyUnknownEligibilityCount(value: unknown): number {
  const source = asRecord(value);
  if (!source) return 0;
  return (
    asLooseNumber(source.unknown_eligibility_count)
    ?? asLooseNumber(source.unknownEligibilityCount)
    ?? 0
  );
}

function coerceSpreadsheetEligibilityCounts(params: {
  eligibleCount: number | null | undefined;
  ineligibleCount: number | null | undefined;
  legacyUnknownCount?: number | null | undefined;
}): {
  eligibleCount: number | null;
  ineligibleCount: number | null;
} {
  const eligibleCount = params.eligibleCount ?? null;
  const ineligibleBase = params.ineligibleCount ?? null;
  const legacyUnknownCount = params.legacyUnknownCount ?? null;
  const ineligibleCount =
    ineligibleBase != null || legacyUnknownCount != null
      ? (ineligibleBase ?? 0) + (legacyUnknownCount ?? 0)
      : null;

  return {
    eligibleCount,
    ineligibleCount,
  };
}

function stripLegacyUnknownEligibilityFields<T extends object>(value: T): T {
  const clone = { ...value } as Record<string, unknown>;
  delete clone.unknown_eligibility_count;
  delete clone.unknownEligibilityCount;
  return clone as T;
}

function sumRecordNumberField(
  records: readonly TransactionDataRecord[],
  field: 'cyd' | 'net_tonnage' | 'extended_cost' | 'transaction_quantity',
): number | null {
  return records.reduce<number | null>((sum, record) => {
    const value = asFiniteNumber(record[field]);
    if (value == null) return sum;
    return (sum ?? 0) + value;
  }, null);
}

function summarizeTickets(records: readonly TransactionDataRecord[]): SpreadsheetReviewTicketSummary {
  const buckets = new Map<string, { hasEligible: boolean; hasIneligible: boolean }>();
  for (const record of records) {
    const ticketKey = normalizeTicketIdentity(record.transaction_number, `record:${record.id}`);
    const states = buckets.get(ticketKey) ?? { hasEligible: false, hasIneligible: false };
    if (normalizeEligibilityBucket(record.eligibility) === 'eligible') {
      states.hasEligible = true;
    } else {
      states.hasIneligible = true;
    }
    buckets.set(ticketKey, states);
  }

  let eligibleTickets = 0;
  let ineligibleTickets = 0;

  for (const states of buckets.values()) {
    if (states.hasIneligible) {
      ineligibleTickets += 1;
    } else if (states.hasEligible) {
      eligibleTickets += 1;
    } else {
      ineligibleTickets += 1;
    }
  }

  return {
    ticketCount: buckets.size,
    eligibleTickets,
    ineligibleTickets,
  };
}

function percentOf(value: number | null, total: number | null): number | null {
  if (value == null || total == null || total === 0) return null;
  return (value / total) * 100;
}

function shouldSurfaceRateCodeCostDriverRow(group: TransactionDataRateCodeGroup): boolean {
  const hasRateCode = hasMeaningfulGroupLabel(group.rate_code);
  const amount = asLooseNumber(group.total_extended_cost);
  const hasMeaningfulCostSignal = amount != null && Math.abs(amount) > 0;
  return hasRateCode && hasMeaningfulCostSignal;
}

function buildRecordMap(records: readonly TransactionDataRecord[]): Map<string, TransactionDataRecord> {
  const mapped = new Map<string, TransactionDataRecord>();

  for (const record of records) {
    mapped.set(record.id, record);

    const rawRow = asRecord(record.raw_row);
    const rawId = typeof rawRow?.id === 'string' ? rawRow.id.trim() : '';
    if (rawId.length > 0 && !mapped.has(rawId)) mapped.set(rawId, record);
  }

  return mapped;
}

function groupTicketCounts(group: {
  row_count: number;
  eligible_count?: number | null;
  ineligible_count?: number | null;
}): {
  ticketCount: number;
  eligibleTickets: number | null;
  ineligibleTickets: number | null;
} {
  const eligibleTickets = asLooseNumber(group.eligible_count);
  const ineligibleTickets = asLooseNumber(group.ineligible_count);

  return {
    ticketCount: eligibleTickets != null || ineligibleTickets != null
      ? Math.max(
        group.row_count,
        (eligibleTickets ?? 0) + (ineligibleTickets ?? 0),
      )
      : group.row_count,
    eligibleTickets,
    ineligibleTickets,
  };
}

function resolveGroupRecords(
  recordIds: readonly string[] | null | undefined,
  recordsById: ReadonlyMap<string, TransactionDataRecord>,
): TransactionDataRecord[] {
  if (!Array.isArray(recordIds) || recordIds.length === 0) return [];
  return recordIds.flatMap((recordId) => {
    const record = recordsById.get(recordId);
    return record ? [record] : [];
  });
}

function buildRecordLabelMap<TGroup>(
  groups: readonly TGroup[],
  getLabel: (group: TGroup) => string | null | undefined,
  getRecordIds: (group: TGroup) => readonly string[],
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of groups) {
    const label = getLabel(group);
    if (!hasMeaningfulGroupLabel(label)) continue;
    for (const recordId of getRecordIds(group)) {
      if (!labels.has(recordId)) labels.set(recordId, label.trim());
    }
  }
  return labels;
}

function determineVolumeBasis(params: {
  summary: TransactionDataExtraction['summary'] | null;
  projectOperationsOverview: TransactionDataProjectOperationsOverview | null;
  rollups: TransactionDataExtraction['rollups'] | null;
  records: readonly TransactionDataRecord[];
  groupedByMaterial: readonly TransactionDataMaterialGroup[];
  groupedByDisposalSite: readonly TransactionDataDisposalSiteGroup[];
  groupedBySiteType: readonly TransactionDataSiteTypeGroup[];
}): SpreadsheetReviewVolumeBasis {
  const totalCyd =
    asLooseNumber(params.summary?.total_cyd_ticket_grain)
    ?? asLooseNumber(params.summary?.total_cyd)
    ?? asLooseNumber(params.projectOperationsOverview?.total_cyd)
    ?? asLooseNumber(params.rollups?.total_cyd_ticket_grain)
    ?? asLooseNumber(params.rollups?.total_cyd)
    ?? asLooseNumber(params.rollups?.totalCyd)
    ?? null;
  const totalNetTonnage = sumRecordNumberField(params.records, 'net_tonnage');
  const hasGroupedCyd =
    params.groupedByMaterial.some((group) => Math.abs(group.total_cyd) > 0)
    || params.groupedByDisposalSite.some((group) => Math.abs(group.total_cyd) > 0)
    || params.groupedBySiteType.some((group) => Math.abs(group.total_cyd) > 0);

  if ((totalCyd != null && Math.abs(totalCyd) > 0) || hasGroupedCyd) {
    return {
      metric: 'cyd',
      unitLabel: 'CYD',
      headerLabel: 'Volume (CYD)',
    };
  }

  if (totalNetTonnage != null && Math.abs(totalNetTonnage) > 0) {
    return {
      metric: 'net_tonnage',
      unitLabel: 'Tons',
      headerLabel: 'Volume (Tons)',
    };
  }

  return {
    metric: totalCyd != null ? 'cyd' : (totalNetTonnage != null ? 'net_tonnage' : null),
    unitLabel: totalCyd != null ? 'CYD' : (totalNetTonnage != null ? 'Tons' : null),
    headerLabel:
      totalCyd != null
        ? 'Volume (CYD)'
        : (totalNetTonnage != null ? 'Volume (Tons)' : 'Volume'),
  };
}

function getGroupVolume<TGroup extends { total_cyd: number; record_ids: string[] }>(
  group: TGroup,
  records: readonly TransactionDataRecord[],
  volumeBasis: SpreadsheetReviewVolumeBasis,
): number | null {
  if (volumeBasis.metric === 'cyd') return asLooseNumber(group.total_cyd);
  if (volumeBasis.metric === 'net_tonnage') return sumRecordNumberField(records, 'net_tonnage');
  return null;
}

function buildFlowRows<TGroup extends {
  total_cyd: number;
  total_extended_cost: number;
  row_count: number;
  record_ids: string[];
  eligible_count?: number | null;
  ineligible_count?: number | null;
}>(params: {
  groups: readonly TGroup[];
  getLabel: (group: TGroup) => string | null | undefined;
  recordsById: ReadonlyMap<string, TransactionDataRecord>;
  volumeBasis: SpreadsheetReviewVolumeBasis;
  totalVolume: number | null;
  totalCost: number | null;
}): SpreadsheetReviewFlowRow[] {
  return params.groups
    .map((group) => {
      const label = params.getLabel(group);
      if (!hasMeaningfulGroupLabel(label)) return null;

      const memberRecords = resolveGroupRecords(group.record_ids, params.recordsById);
      const ticketSummary = memberRecords.length > 0 ? summarizeTickets(memberRecords) : null;
      const fallbackTicketCounts = groupTicketCounts(group);
      const volume = getGroupVolume(group, memberRecords, params.volumeBasis);
      const amount = asLooseNumber(group.total_extended_cost);

      return {
        label: label.trim(),
        ticketCount: ticketSummary?.ticketCount ?? fallbackTicketCounts.ticketCount,
        eligibleTickets: ticketSummary?.eligibleTickets ?? fallbackTicketCounts.eligibleTickets,
        ineligibleTickets: ticketSummary?.ineligibleTickets ?? fallbackTicketCounts.ineligibleTickets,
        volume,
        percentOfTotalVolume: percentOf(volume, params.totalVolume),
        amount,
        percentOfTotalCost: percentOf(amount, params.totalCost),
      } satisfies SpreadsheetReviewFlowRow;
    })
    .filter((row): row is SpreadsheetReviewFlowRow => row != null)
    .sort((left, right) => {
      const amountDelta = (right.amount ?? 0) - (left.amount ?? 0);
      if (amountDelta !== 0) return amountDelta;
      const volumeDelta = (right.volume ?? 0) - (left.volume ?? 0);
      if (volumeDelta !== 0) return volumeDelta;
      return left.label.localeCompare(right.label, 'en-US');
    });
}

function buildServiceItemRows(params: {
  groups: readonly TransactionDataServiceItemGroup[];
  recordsById: ReadonlyMap<string, TransactionDataRecord>;
}): Array<Omit<SpreadsheetReviewServiceItemRow, 'percentOfTotalServiceCost'>> {
  const rows: Array<Omit<SpreadsheetReviewServiceItemRow, 'percentOfTotalServiceCost'>> = [];

  for (const group of params.groups) {
    if (!hasMeaningfulGroupLabel(group.service_item)) continue;

    const memberRecords = resolveGroupRecords(group.record_ids, params.recordsById);
    const fallbackTicketCounts = groupTicketCounts(group);
    if (memberRecords.length === 0) {
      rows.push({
        serviceItem: group.service_item.trim(),
        ticketCount: fallbackTicketCounts.ticketCount,
        eligibleTickets: fallbackTicketCounts.eligibleTickets,
        ineligibleTickets: fallbackTicketCounts.ineligibleTickets,
        diameterUnits: null,
        amount: asLooseNumber(group.total_extended_cost),
      });
      continue;
    }

    const ticketSummary = summarizeTickets(memberRecords);
    rows.push({
      serviceItem: group.service_item.trim(),
      ticketCount: ticketSummary.ticketCount,
      eligibleTickets: ticketSummary.eligibleTickets,
      ineligibleTickets: ticketSummary.ineligibleTickets,
      diameterUnits: sumServiceItemDiameters(memberRecords),
      amount: sumRecordNumberField(memberRecords, 'extended_cost'),
    });
  }

  return rows.sort((left, right) => {
    const amountDelta = (right.amount ?? 0) - (left.amount ?? 0);
    if (amountDelta !== 0) return amountDelta;
    const serviceDelta = left.serviceItem.localeCompare(right.serviceItem, 'en-US');
    return serviceDelta;
  });
}

function describeRiskReason(reason: string): SpreadsheetReviewRiskDescriptor {
  const normalized = reason.trim().toLowerCase();

  if (normalized.includes('missing invoice number')) {
    return {
      issueType: 'Missing Invoice #',
      whyItMatters: 'Rows without an invoice link cannot be reconciled to a bill.',
      actionNeeded: 'Add or confirm the Invoice # before invoice review.',
    };
  }
  if (normalized.includes('missing rate code')) {
    return {
      issueType: 'Missing Rate Code',
      whyItMatters: 'Rows without a rate code cannot be matched to contract pricing.',
      actionNeeded: 'Assign or confirm the rate code for the affected tickets.',
    };
  }
  if (normalized.includes('missing quantity')) {
    return {
      issueType: 'Missing Quantity',
      whyItMatters: 'Missing quantity prevents unit and amount validation.',
      actionNeeded: 'Populate Quantity and confirm the billing unit.',
    };
  }
  if (normalized.includes('missing extended cost')) {
    return {
      issueType: 'Missing Amount',
      whyItMatters: 'Missing amount prevents invoice reconciliation and rollup validation.',
      actionNeeded: 'Populate the billed amount before invoice review.',
    };
  }
  if (normalized.includes('zero extended cost')) {
    return {
      issueType: 'Zero Cost Rows',
      whyItMatters: 'Zero-amount rows can indicate incomplete billing or data issues.',
      actionNeeded: 'Confirm whether the row is informational or requires corrected billing.',
    };
  }
  if (normalized.includes('mileage review')) {
    return {
      issueType: 'Mileage Review',
      whyItMatters: 'Mileage-driven charges need route and distance support.',
      actionNeeded: 'Verify the cited mileage and confirm supporting documentation.',
    };
  }
  if (normalized.includes('distance from feature review')) {
    return {
      issueType: 'Distance from Feature Review',
      whyItMatters: 'Location-based charges need distance support to remain billable.',
      actionNeeded: 'Confirm the measured distance and source evidence.',
    };
  }
  if (normalized.includes('load call review')) {
    return {
      issueType: 'Load Call Review',
      whyItMatters: 'Load-call support affects whether monitored work is fully auditable.',
      actionNeeded: 'Confirm the load call documentation for the affected tickets.',
    };
  }
  if (normalized.includes('duplicate')) {
    return {
      issueType: 'Duplicate Ticket / Invoice Review',
      whyItMatters: 'Duplicate billing patterns can lead to overpayment risk.',
      actionNeeded: 'Verify whether the duplicate represents a valid separate billable event.',
    };
  }
  if (normalized.includes('baseline') || normalized.includes('deviates from')) {
    return {
      issueType: 'Rate Review',
      whyItMatters: 'Rate outliers can indicate billing or mapping errors.',
      actionNeeded: 'Confirm the billed rate against the expected contract rate.',
    };
  }

  return {
    issueType: titleize(reason),
    whyItMatters: 'This row needs review before the project can be considered invoice-ready.',
    actionNeeded: 'Review the affected tickets and confirm the supporting detail.',
  };
}

function toRiskSeverity(severity: 'warning' | 'critical'): 'High' | 'Medium' | 'Low' {
  return severity === 'critical' ? 'High' : 'Medium';
}

function riskSeverityRank(severity: 'High' | 'Medium' | 'Low'): number {
  if (severity === 'High') return 0;
  if (severity === 'Medium') return 1;
  return 2;
}

function sumUniqueAmounts(values: Iterable<[string, number | null]>): number | null {
  const seen = new Set<string>();
  let sum: number | null = null;
  for (const [key, value] of values) {
    if (seen.has(key) || value == null) continue;
    seen.add(key);
    sum = (sum ?? 0) + value;
  }
  return sum;
}

function buildCompactTicketPreview(
  ticketNumbers: readonly string[],
  previewLimit = 3,
): string | null {
  if (ticketNumbers.length === 0) return null;
  const preview = ticketNumbers.slice(0, previewLimit);
  const overflow = ticketNumbers.length - preview.length;
  return overflow > 0
    ? `${preview.join(', ')} + ${overflow} more`
    : preview.join(', ');
}

function sanitizeSpreadsheetOutlierRows(
  outlierRows: readonly TransactionDataOutlierRow[],
): TransactionDataOutlierRow[] {
  return outlierRows.flatMap((row) => {
    const reasons = row.reasons.filter((reason) => {
      const normalized = reason.trim().toLowerCase();
      return normalized !== 'eligibility status unresolved';
    });

    if (reasons.length === 0) return [];
    return [{ ...row, reasons }];
  });
}

function buildRiskPresentation(params: {
  outlierRows: readonly TransactionDataOutlierRow[];
  recordsById: ReadonlyMap<string, TransactionDataRecord>;
  siteByRecordId: ReadonlyMap<string, string>;
}): {
  riskSummary: SpreadsheetReviewRiskSummary | null;
  groupedRiskIssues: SpreadsheetReviewRiskIssueRow[];
  riskDrilldownRows: SpreadsheetReviewRiskDrilldownRow[];
} {
  type FlatIssue = {
    recordId: string;
    ticketKey: string;
    invoiceKey: string | null;
    ticketNumber: string | null;
    invoiceNumber: string | null;
    issueType: string;
    severity: 'High' | 'Medium' | 'Low';
    amount: number | null;
    whyItMatters: string;
    actionNeeded: string;
    reason: string;
    materialOrServiceItem: string | null;
    site: string | null;
  };

  const flatIssues: FlatIssue[] = [];

  for (const row of params.outlierRows) {
    const record = params.recordsById.get(row.record_id) ?? null;
    const materialOrServiceItem = record?.material ?? record?.service_item ?? null;
    const ticketNumber = preferredTicketNumber(
      [
        row.transaction_number,
        record?.transaction_number,
        rawRowText(record?.raw_row ?? {}, RAW_TICKET_KEYS),
      ],
      [row.record_id],
    );
    const amount =
      asLooseNumber(row.metrics.extended_cost)
      ?? asFiniteNumber(record?.extended_cost ?? null);

    for (const reason of [...new Set(row.reasons.map((value) => value.trim()).filter((value) => value.length > 0))]) {
      const descriptor = describeRiskReason(reason);
      flatIssues.push({
        recordId: row.record_id,
        ticketKey: normalizeTicketIdentity(ticketNumber, `record:${row.record_id}`),
        invoiceKey: normalizeInvoiceIdentity(row.invoice_number),
        ticketNumber,
        invoiceNumber: row.invoice_number,
        issueType: descriptor.issueType,
        severity: toRiskSeverity(row.severity),
        amount,
        whyItMatters: descriptor.whyItMatters,
        actionNeeded: descriptor.actionNeeded,
        reason,
        materialOrServiceItem,
        site: params.siteByRecordId.get(row.record_id) ?? null,
      });
    }
  }

  const groupedRiskIssues = Array.from(
    flatIssues.reduce((map, issue) => {
      const existing = map.get(issue.issueType) ?? {
        issueType: issue.issueType,
        severity: issue.severity,
        ticketKeys: new Set<string>(),
        ticketNumbers: [] as string[],
        ticketNumberKeys: new Set<string>(),
        invoiceKeys: new Set<string>(),
        amounts: new Map<string, number | null>(),
        whyItMatters: issue.whyItMatters,
        actionNeeded: issue.actionNeeded,
      };

      if (riskSeverityRank(issue.severity) < riskSeverityRank(existing.severity)) {
        existing.severity = issue.severity;
      }
      existing.ticketKeys.add(issue.ticketKey);
      if (typeof issue.ticketNumber === 'string' && issue.ticketNumber.trim().length > 0) {
        const ticketNumber = issue.ticketNumber.trim();
        const ticketNumberKey = ticketNumber.toUpperCase();
        if (!existing.ticketNumberKeys.has(ticketNumberKey)) {
          existing.ticketNumberKeys.add(ticketNumberKey);
          existing.ticketNumbers.push(ticketNumber);
        }
      }
      if (issue.invoiceKey) existing.invoiceKeys.add(issue.invoiceKey);
      existing.amounts.set(issue.recordId, issue.amount);
      map.set(issue.issueType, existing);
      return map;
    }, new Map<string, {
      issueType: string;
      severity: 'High' | 'Medium' | 'Low';
      ticketKeys: Set<string>;
      ticketNumbers: string[];
      ticketNumberKeys: Set<string>;
      invoiceKeys: Set<string>;
      amounts: Map<string, number | null>;
      whyItMatters: string;
      actionNeeded: string;
    }>()),
  )
    .map(([, issue]) => ({
      issueType: issue.issueType,
      severity: issue.severity,
      ticketCount: issue.ticketKeys.size,
      affectedTicketPreview: buildCompactTicketPreview(issue.ticketNumbers),
      invoiceCount: issue.invoiceKeys.size,
      amountImpact: sumUniqueAmounts(issue.amounts.entries()),
      whyItMatters: issue.whyItMatters,
      actionNeeded: issue.actionNeeded,
    }))
    .sort((left, right) => {
      const severityDelta = riskSeverityRank(left.severity) - riskSeverityRank(right.severity);
      if (severityDelta !== 0) return severityDelta;
      const ticketDelta = right.ticketCount - left.ticketCount;
      if (ticketDelta !== 0) return ticketDelta;
      return left.issueType.localeCompare(right.issueType, 'en-US');
    });

  const riskDrilldownRows = Array.from(
    flatIssues.reduce((map, issue) => {
      const key = `${issue.issueType}|${issue.ticketKey}|${issue.invoiceKey ?? 'no-invoice'}`;
      const existing = map.get(key) ?? {
        ticketNumber: issue.ticketNumber,
        invoiceNumber: issue.invoiceNumber,
        issueType: issue.issueType,
        severity: issue.severity,
        materialOrServiceItem: issue.materialOrServiceItem,
        site: issue.site,
        amountByRecord: new Map<string, number | null>(),
        reasons: new Set<string>(),
      };

      if (riskSeverityRank(issue.severity) < riskSeverityRank(existing.severity)) {
        existing.severity = issue.severity;
      }
      if (existing.materialOrServiceItem == null && issue.materialOrServiceItem != null) {
        existing.materialOrServiceItem = issue.materialOrServiceItem;
      }
      if (existing.site == null && issue.site != null) {
        existing.site = issue.site;
      }
      existing.amountByRecord.set(issue.recordId, issue.amount);
      existing.reasons.add(issue.reason);
      map.set(key, existing);
      return map;
    }, new Map<string, {
      ticketNumber: string | null;
      invoiceNumber: string | null;
      issueType: string;
      severity: 'High' | 'Medium' | 'Low';
      materialOrServiceItem: string | null;
      site: string | null;
      amountByRecord: Map<string, number | null>;
      reasons: Set<string>;
    }>()),
  )
    .map(([, issue]) => ({
      ticketNumber: issue.ticketNumber,
      invoiceNumber: issue.invoiceNumber,
      issueType: issue.issueType,
      severity: issue.severity,
      materialOrServiceItem: issue.materialOrServiceItem,
      site: issue.site,
      amount: sumUniqueAmounts(issue.amountByRecord.entries()),
      reason: Array.from(issue.reasons).sort((left, right) => left.localeCompare(right, 'en-US')).join('; '),
    }))
    .sort((left, right) => {
      const severityDelta = riskSeverityRank(left.severity) - riskSeverityRank(right.severity);
      if (severityDelta !== 0) return severityDelta;
      const amountDelta = (right.amount ?? 0) - (left.amount ?? 0);
      if (amountDelta !== 0) return amountDelta;
      return (left.ticketNumber ?? '').localeCompare(right.ticketNumber ?? '', 'en-US');
    });

  if (groupedRiskIssues.length === 0) {
    return {
      riskSummary: null,
      groupedRiskIssues,
      riskDrilldownRows,
    };
  }

  const ticketKeys = new Set(flatIssues.map((issue) => issue.ticketKey));
  const invoiceKeys = new Set(
    flatIssues
      .map((issue) => issue.invoiceKey)
      .filter((value): value is string => value != null),
  );

  return {
    riskSummary: {
      highRiskIssues: groupedRiskIssues.filter((issue) => issue.severity === 'High').length,
      mediumRiskIssues: groupedRiskIssues.filter((issue) => issue.severity === 'Medium').length,
      lowRiskIssues: groupedRiskIssues.filter((issue) => issue.severity === 'Low').length,
      ticketsAffected: ticketKeys.size,
      invoicesAffected: invoiceKeys.size,
      estimatedAmountAtRisk: sumUniqueAmounts(flatIssues.map((issue) => [issue.recordId, issue.amount] as const)),
    },
    groupedRiskIssues,
    riskDrilldownRows,
  };
}

function sanitizeProjectOperationsOverview(
  overview: TransactionDataProjectOperationsOverview | null | undefined,
): TransactionDataProjectOperationsOverview | null {
  if (!overview) return null;
  const legacyUnknownCount = readLegacyUnknownEligibilityCount(overview);
  const eligibilityCounts = coerceSpreadsheetEligibilityCounts({
    eligibleCount: asLooseNumber(overview.eligible_count),
    ineligibleCount: asLooseNumber(overview.ineligible_count),
    legacyUnknownCount,
  });

  return {
    ...stripLegacyUnknownEligibilityFields(overview),
    eligible_count: eligibilityCounts.eligibleCount ?? 0,
    ineligible_count: eligibilityCounts.ineligibleCount ?? 0,
  };
}

function toCanonicalConsistentRollups(
  canonicalSummary: Record<string, unknown> | null,
  extractionRollups: TransactionDataExtraction['rollups'] | null,
): TransactionDataExtraction['rollups'] | null {
  if (!canonicalSummary) return extractionRollups ?? null;

  const legacyExtractionRollups = extractionRollups as (TransactionDataExtraction['rollups'] & {
    distinctInvoiceNumbers?: string[];
    distinctRateCodes?: string[];
    distinctServiceItems?: string[];
    distinctMaterials?: string[];
  }) | null;

  const totalTickets =
    asLooseNumber(canonicalSummary.total_tickets)
    ?? asLooseNumber(extractionRollups?.total_tickets)
    ?? asLooseNumber(extractionRollups?.totalTickets);
  const totalCyd =
    asLooseNumber(canonicalSummary.total_cyd_ticket_grain)
    ?? asLooseNumber(canonicalSummary.total_cyd)
    ?? asLooseNumber(extractionRollups?.total_cyd_ticket_grain)
    ?? asLooseNumber(extractionRollups?.total_cyd)
    ?? asLooseNumber(extractionRollups?.totalCyd);
  const totalExtendedCost =
    asLooseNumber(canonicalSummary.total_extended_cost)
    ?? asLooseNumber(extractionRollups?.total_extended_cost)
    ?? asLooseNumber(extractionRollups?.totalExtendedCost);
  const totalTransactionQuantity =
    asLooseNumber(canonicalSummary.total_transaction_quantity)
    ?? asLooseNumber(extractionRollups?.total_transaction_quantity)
    ?? asLooseNumber(extractionRollups?.totalTransactionQuantity);
  const invoicedTicketCount =
    asLooseNumber(canonicalSummary.invoiced_ticket_count)
    ?? asLooseNumber(extractionRollups?.invoiced_ticket_count)
    ?? asLooseNumber(extractionRollups?.invoicedTicketCount);
  const distinctInvoiceCount =
    asLooseNumber(canonicalSummary.distinct_invoice_count)
    ?? asLooseNumber(extractionRollups?.distinct_invoice_count)
    ?? asLooseNumber(extractionRollups?.distinctInvoiceCount);
  const totalInvoicedAmount =
    asLooseNumber(canonicalSummary.total_invoiced_amount)
    ?? asLooseNumber(extractionRollups?.total_invoiced_amount)
    ?? asLooseNumber(extractionRollups?.totalInvoicedAmount);
  const uninvoicedLineCount =
    asLooseNumber(canonicalSummary.uninvoiced_line_count)
    ?? asLooseNumber(extractionRollups?.uninvoiced_line_count)
    ?? asLooseNumber(extractionRollups?.uninvoicedLineCount);
  const eligibleCount =
    asLooseNumber(canonicalSummary.eligible_count)
    ?? asLooseNumber(extractionRollups?.eligible_count)
    ?? asLooseNumber(extractionRollups?.eligibleCount);
  const ineligibleCount =
    asLooseNumber(canonicalSummary.ineligible_count)
    ?? asLooseNumber(extractionRollups?.ineligible_count)
    ?? asLooseNumber(extractionRollups?.ineligibleCount);
  const eligibilityCounts = coerceSpreadsheetEligibilityCounts({
    eligibleCount,
    ineligibleCount,
    legacyUnknownCount:
      readLegacyUnknownEligibilityCount(canonicalSummary)
      + readLegacyUnknownEligibilityCount(extractionRollups),
  });
  const rowsWithMissingRateCode =
    asLooseNumber(canonicalSummary.rows_with_missing_rate_code)
    ?? asLooseNumber(extractionRollups?.rows_with_missing_rate_code)
    ?? asLooseNumber(extractionRollups?.rowsWithMissingRateCode);
  const rowsWithMissingInvoiceNumber =
    asLooseNumber(canonicalSummary.rows_with_missing_invoice_number)
    ?? asLooseNumber(extractionRollups?.rows_with_missing_invoice_number)
    ?? asLooseNumber(extractionRollups?.rowsWithMissingInvoiceNumber);
  const rowsWithMissingQuantity =
    asLooseNumber(canonicalSummary.rows_with_missing_quantity)
    ?? asLooseNumber(extractionRollups?.rows_with_missing_quantity)
    ?? asLooseNumber(extractionRollups?.rowsWithMissingQuantity);
  const rowsWithMissingExtendedCost =
    asLooseNumber(canonicalSummary.rows_with_missing_extended_cost)
    ?? asLooseNumber(extractionRollups?.rows_with_missing_extended_cost)
    ?? asLooseNumber(extractionRollups?.rowsWithMissingExtendedCost);
  const rowsWithZeroCost =
    asLooseNumber(canonicalSummary.rows_with_zero_cost)
    ?? asLooseNumber(extractionRollups?.rows_with_zero_cost)
    ?? asLooseNumber(extractionRollups?.rowsWithZeroCost);
  const rowsWithExtremeUnitRate =
    asLooseNumber(canonicalSummary.rows_with_extreme_unit_rate)
    ?? asLooseNumber(extractionRollups?.rows_with_extreme_unit_rate)
    ?? asLooseNumber(extractionRollups?.rowsWithExtremeUnitRate);
  const distinctInvoiceNumbers = Array.isArray(canonicalSummary.distinct_invoice_numbers)
    ? (canonicalSummary.distinct_invoice_numbers as string[])
    : (extractionRollups?.distinct_invoice_numbers ?? legacyExtractionRollups?.distinctInvoiceNumbers);
  const distinctRateCodes = Array.isArray(canonicalSummary.distinct_rate_codes)
    ? (canonicalSummary.distinct_rate_codes as string[])
    : (extractionRollups?.distinct_rate_codes ?? legacyExtractionRollups?.distinctRateCodes);
  const distinctServiceItems = Array.isArray(canonicalSummary.distinct_service_items)
    ? (canonicalSummary.distinct_service_items as string[])
    : (extractionRollups?.distinct_service_items ?? legacyExtractionRollups?.distinctServiceItems);
  const distinctMaterials = Array.isArray(canonicalSummary.distinct_materials)
    ? (canonicalSummary.distinct_materials as string[])
    : (extractionRollups?.distinct_materials ?? legacyExtractionRollups?.distinctMaterials);
  const groupedByRateCode = Array.isArray(canonicalSummary.grouped_by_rate_code)
    ? (canonicalSummary.grouped_by_rate_code as TransactionDataRateCodeGroup[])
    : (extractionRollups?.groupedByRateCode ?? extractionRollups?.grouped_by_rate_code);
  const groupedByInvoice = Array.isArray(canonicalSummary.grouped_by_invoice)
    ? (canonicalSummary.grouped_by_invoice as TransactionDataInvoiceGroup[])
    : (extractionRollups?.groupedByInvoice ?? extractionRollups?.grouped_by_invoice);
  const groupedBySiteMaterial = Array.isArray(canonicalSummary.grouped_by_site_material)
    ? (canonicalSummary.grouped_by_site_material as TransactionDataSiteMaterialGroup[])
    : (extractionRollups?.groupedBySiteMaterial ?? extractionRollups?.grouped_by_site_material);
  const groupedByServiceItem = Array.isArray(canonicalSummary.grouped_by_service_item)
    ? (canonicalSummary.grouped_by_service_item as TransactionDataServiceItemGroup[])
    : (extractionRollups?.groupedByServiceItem ?? extractionRollups?.grouped_by_service_item);
  const groupedByMaterial = Array.isArray(canonicalSummary.grouped_by_material)
    ? (canonicalSummary.grouped_by_material as TransactionDataMaterialGroup[])
    : (extractionRollups?.groupedByMaterial ?? extractionRollups?.grouped_by_material);
  const groupedBySiteType = Array.isArray(canonicalSummary.grouped_by_site_type)
    ? (canonicalSummary.grouped_by_site_type as TransactionDataSiteTypeGroup[])
    : (extractionRollups?.groupedBySiteType ?? extractionRollups?.grouped_by_site_type);
  const groupedByDisposalSite = Array.isArray(canonicalSummary.grouped_by_disposal_site)
    ? (canonicalSummary.grouped_by_disposal_site as TransactionDataDisposalSiteGroup[])
    : (extractionRollups?.groupedByDisposalSite ?? extractionRollups?.grouped_by_disposal_site);
  const outlierRows = Array.isArray(canonicalSummary.outlier_rows)
    ? (canonicalSummary.outlier_rows as TransactionDataOutlierRow[])
    : (extractionRollups?.outlierRows ?? extractionRollups?.outlier_rows);
  const sanitizedOutlierRows = sanitizeSpreadsheetOutlierRows(outlierRows ?? []);

  return {
    ...stripLegacyUnknownEligibilityFields(extractionRollups ?? {}),
    total_tickets: totalTickets,
    totalTickets,
    total_cyd: totalCyd,
    totalCyd,
    total_cyd_ticket_grain: totalCyd,
    totalCydTicketGrain: totalCyd,
    total_cyd_ticket_grain_full: asLooseNumber(canonicalSummary.total_cyd_ticket_grain_full)
      ?? asLooseNumber(extractionRollups?.total_cyd_ticket_grain_full),
    total_mileage_ticket_grain: asLooseNumber(canonicalSummary.total_mileage_ticket_grain)
      ?? asLooseNumber(extractionRollups?.total_mileage_ticket_grain),
    total_mileage_ticket_grain_full: asLooseNumber(canonicalSummary.total_mileage_ticket_grain_full)
      ?? asLooseNumber(extractionRollups?.total_mileage_ticket_grain_full),
    total_diameter: asLooseNumber(canonicalSummary.total_diameter)
      ?? asLooseNumber(extractionRollups?.total_diameter),
    total_diameter_full: asLooseNumber(canonicalSummary.total_diameter_full)
      ?? asLooseNumber(extractionRollups?.total_diameter_full),
    total_net_tonnage: asLooseNumber(canonicalSummary.total_net_tonnage)
      ?? asLooseNumber(extractionRollups?.total_net_tonnage),
    total_net_tonnage_full: asLooseNumber(canonicalSummary.total_net_tonnage_full)
      ?? asLooseNumber(extractionRollups?.total_net_tonnage_full),
    total_extended_cost: totalExtendedCost,
    totalExtendedCost,
    total_transaction_quantity: totalTransactionQuantity,
    totalTransactionQuantity,
    invoiced_ticket_count: invoicedTicketCount,
    invoicedTicketCount,
    distinct_invoice_count: distinctInvoiceCount,
    distinctInvoiceCount,
    total_invoiced_amount: totalInvoicedAmount,
    totalInvoicedAmount,
    uninvoiced_line_count: uninvoicedLineCount,
    uninvoicedLineCount,
    eligible_count: eligibilityCounts.eligibleCount,
    eligibleCount: eligibilityCounts.eligibleCount,
    ineligible_count: eligibilityCounts.ineligibleCount,
    ineligibleCount: eligibilityCounts.ineligibleCount,
    rows_with_missing_rate_code: rowsWithMissingRateCode,
    rowsWithMissingRateCode,
    rows_with_missing_invoice_number: rowsWithMissingInvoiceNumber,
    rowsWithMissingInvoiceNumber,
    rows_with_missing_quantity: rowsWithMissingQuantity,
    rowsWithMissingQuantity,
    rows_with_missing_extended_cost: rowsWithMissingExtendedCost,
    rowsWithMissingExtendedCost,
    rows_with_zero_cost: rowsWithZeroCost,
    rowsWithZeroCost,
    rows_with_extreme_unit_rate: rowsWithExtremeUnitRate,
    rowsWithExtremeUnitRate,
    distinct_invoice_numbers: distinctInvoiceNumbers,
    distinctInvoiceNumbers: distinctInvoiceNumbers,
    distinct_rate_codes: distinctRateCodes,
    distinctRateCodes: distinctRateCodes,
    distinct_service_items: distinctServiceItems,
    distinctServiceItems: distinctServiceItems,
    distinct_materials: distinctMaterials,
    distinctMaterials: distinctMaterials,
    grouped_by_rate_code: groupedByRateCode,
    groupedByRateCode,
    grouped_by_invoice: groupedByInvoice,
    groupedByInvoice,
    grouped_by_site_material: groupedBySiteMaterial,
    groupedBySiteMaterial,
    grouped_by_service_item: groupedByServiceItem,
    groupedByServiceItem,
    grouped_by_material: groupedByMaterial,
    groupedByMaterial,
    grouped_by_site_type: groupedBySiteType,
    groupedBySiteType,
    grouped_by_disposal_site: groupedByDisposalSite,
    groupedByDisposalSite,
    outlier_rows: sanitizedOutlierRows,
    outlierRows: sanitizedOutlierRows,
  } as TransactionDataExtraction['rollups'];
}

function toSpreadsheetReviewDataset(
  extraction: TransactionDataExtraction | null,
  canonical?: {
    projectValidationSummary?: Record<string, unknown> | null;
    projectValidationStatus?: string | null;
    projectValidationFindings?: readonly ValidationFinding[];
    transactionDatasets?: Array<Record<string, unknown>>;
    transactionRows?: Array<Record<string, unknown>>;
  },
): SpreadsheetReviewDataset | null {
  const canonicalSummary =
    (canonical?.transactionDatasets ?? [])
      .map((dataset) => asRecord(dataset.summary_json))
      .find((summaryRow): summaryRow is Record<string, unknown> => summaryRow != null)
    ?? null;
  const canonicalRecords = (canonical?.transactionRows ?? []).flatMap((row) => {
    const rowRecord = asRecord(row);
    if (!rowRecord) return [];
    const recordJson = asRecord(rowRecord.record_json);
    if (!recordJson) return [];
    const rawRowJson = asRecord(rowRecord.raw_row_json);
    const mergedRecord =
      rawRowJson && asRecord(recordJson.raw_row) == null
        ? { ...recordJson, raw_row: rawRowJson }
        : recordJson;
    return [mergedRecord as unknown as TransactionDataRecord];
  });

  const hasCanonicalDatasetData = canonicalSummary != null || canonicalRecords.length > 0;
  const hasNormalizedDatasetTables =
    (canonical?.transactionDatasets?.length ?? 0) > 0 ||
    (canonical?.transactionRows?.length ?? 0) > 0;
  const legacyExtraction = hasNormalizedDatasetTables ? null : extraction;
  if (!extraction && !hasCanonicalDatasetData) return null;

  const records = canonicalRecords.length > 0 ? canonicalRecords : (legacyExtraction?.records ?? []);
  const rawSummary =
    (canonicalSummary as TransactionDataExtraction['summary'] | null)
    ?? legacyExtraction?.summary
    ?? null;
  const rollups = toCanonicalConsistentRollups(canonicalSummary, legacyExtraction?.rollups ?? null);
  const projectOperationsOverview = sanitizeProjectOperationsOverview(
    (asRecord(canonicalSummary?.project_operations_overview) as TransactionDataProjectOperationsOverview | null)
    ?? legacyExtraction?.projectOperationsOverview
    ?? null,
  );
  const summaryEligibilityCounts = coerceSpreadsheetEligibilityCounts({
    eligibleCount:
      asLooseNumber(rawSummary?.eligible_count)
      ?? asLooseNumber(projectOperationsOverview?.eligible_count)
      ?? asLooseNumber(rollups?.eligible_count)
      ?? asLooseNumber(rollups?.eligibleCount),
    ineligibleCount:
      asLooseNumber(rawSummary?.ineligible_count)
      ?? asLooseNumber(projectOperationsOverview?.ineligible_count)
      ?? asLooseNumber(rollups?.ineligible_count)
      ?? asLooseNumber(rollups?.ineligibleCount),
    legacyUnknownCount: readLegacyUnknownEligibilityCount(rawSummary),
  });
  const baseInvoiceReadinessSummary =
    (asRecord(canonicalSummary?.invoice_readiness_summary) as TransactionDataInvoiceReadinessSummary | null)
    ?? legacyExtraction?.invoiceReadinessSummary
    ?? null;
  const dmsFdsLifecycleSummary =
    (asRecord(canonicalSummary?.dms_fds_lifecycle_summary) as TransactionDataDmsFdsLifecycleSummary | null)
    ?? legacyExtraction?.dmsFdsLifecycleSummary
    ?? null;

  const groupedByRateCode =
    (Array.isArray(canonicalSummary?.grouped_by_rate_code)
      ? (canonicalSummary.grouped_by_rate_code as TransactionDataRateCodeGroup[])
      : null)
    ?? legacyExtraction?.summary?.grouped_by_rate_code
    ?? rollups?.groupedByRateCode
    ?? rollups?.grouped_by_rate_code
    ?? [];
  const groupedByServiceItem =
    (Array.isArray(canonicalSummary?.grouped_by_service_item)
      ? (canonicalSummary.grouped_by_service_item as TransactionDataServiceItemGroup[])
      : null)
    ?? legacyExtraction?.groupedByServiceItem
    ?? legacyExtraction?.summary?.grouped_by_service_item
    ?? rollups?.groupedByServiceItem
    ?? rollups?.grouped_by_service_item
    ?? [];
  const groupedByMaterial =
    (Array.isArray(canonicalSummary?.grouped_by_material)
      ? (canonicalSummary.grouped_by_material as TransactionDataMaterialGroup[])
      : null)
    ?? legacyExtraction?.groupedByMaterial
    ?? legacyExtraction?.summary?.grouped_by_material
    ?? rollups?.groupedByMaterial
    ?? rollups?.grouped_by_material
    ?? [];
  const groupedByDisposalSite =
    (Array.isArray(canonicalSummary?.grouped_by_disposal_site)
      ? (canonicalSummary.grouped_by_disposal_site as TransactionDataDisposalSiteGroup[])
      : null)
    ?? legacyExtraction?.groupedByDisposalSite
    ?? legacyExtraction?.summary?.grouped_by_disposal_site
    ?? rollups?.groupedByDisposalSite
    ?? rollups?.grouped_by_disposal_site
    ?? [];
  const groupedBySiteType =
    (Array.isArray(canonicalSummary?.grouped_by_site_type)
      ? (canonicalSummary.grouped_by_site_type as TransactionDataSiteTypeGroup[])
      : null)
    ?? legacyExtraction?.groupedBySiteType
    ?? legacyExtraction?.summary?.grouped_by_site_type
    ?? rollups?.groupedBySiteType
    ?? rollups?.grouped_by_site_type
    ?? [];
  const outlierRows =
    (Array.isArray(canonicalSummary?.outlier_rows)
      ? (canonicalSummary.outlier_rows as TransactionDataOutlierRow[])
      : null)
    ?? legacyExtraction?.outlierRows
    ?? legacyExtraction?.summary?.outlier_rows
    ?? rollups?.outlierRows
    ?? rollups?.outlier_rows
    ?? [];
  const sanitizedOutlierRows = sanitizeSpreadsheetOutlierRows(outlierRows);
  const summary = rawSummary
    ? ({
        ...stripLegacyUnknownEligibilityFields(rawSummary),
        eligible_count: summaryEligibilityCounts.eligibleCount ?? 0,
        ineligible_count: summaryEligibilityCounts.ineligibleCount ?? 0,
        outlier_rows: sanitizedOutlierRows,
        project_operations_overview: projectOperationsOverview,
      } as TransactionDataExtraction['summary'])
    : null;

  const ticketTypeByRecordId = new Map<string, string>();
  for (const record of records) {
    const bucket = ticketTypeBucketFromRawRow(record.raw_row ?? {});
    ticketTypeByRecordId.set(record.id, bucket);
  }

  const groupedByServiceItemMobileOnly = groupedByServiceItem.filter((group) => {
    if (!hasMeaningfulGroupLabel(group.service_item)) return false;
    if (group.record_ids.length === 0) return false;
    return group.record_ids.some((recordId) => ticketTypeByRecordId.get(recordId) === 'mobile_unit');
  });

  const groupedByMaterialMobileOnly = groupedByMaterial.filter((group) => {
    if (!hasMeaningfulGroupLabel(group.material)) return false;
    if (group.record_ids.length === 0) return false;
    return group.record_ids.some((recordId) => ticketTypeByRecordId.get(recordId) === 'mobile');
  });

  const totalNetTonnage = records.reduce<number | null>((sum, record) => {
    const value = asFiniteNumber(record.net_tonnage);
    if (value == null) return sum;
    return (sum ?? 0) + value;
  }, null);
  const distinctTransactionCount = new Set(
    records
      .map((record) => (typeof record.transaction_number === 'string' ? record.transaction_number.trim().toUpperCase() : ''))
      .filter((value) => value.length > 0),
  ).size;

  const projectFacts = resolveCanonicalProjectFacts({
    validationStatus: canonical?.projectValidationStatus,
    validationSummary: canonical?.projectValidationSummary,
    validationFindings: canonical?.projectValidationFindings,
  });
  const projectBlockedReasons = projectFacts.blocked_reasons;
  const projectTotalInvoicedAmount =
    projectFacts.total_billed
    ?? projectFacts.exposure_total_billed;
  const projectTotalInvoices = projectFacts.exposure?.invoices.length ?? null;

  const invoiceReadinessStatus = spreadsheetReviewReadinessStatusForProjectFacts({
    facts: projectFacts,
    fallback: baseInvoiceReadinessSummary?.status ?? null,
  });

  const invoiceReadinessSummary = baseInvoiceReadinessSummary
    ? {
        ...baseInvoiceReadinessSummary,
        status: invoiceReadinessStatus ?? baseInvoiceReadinessSummary.status,
        blocking_reasons:
          projectBlockedReasons.length > 0
            ? projectBlockedReasons
            : baseInvoiceReadinessSummary.blocking_reasons,
      }
    : (
      invoiceReadinessStatus != null || projectBlockedReasons.length > 0
        ? {
            status: invoiceReadinessStatus ?? 'needs_review',
            total_tickets: 0,
            invoiced_ticket_count: 0,
            distinct_invoice_count: 0,
            total_invoiced_amount: 0,
            uninvoiced_line_count: 0,
            rows_with_missing_rate_code: 0,
            rows_with_missing_quantity: 0,
            rows_with_missing_extended_cost: 0,
            rows_with_zero_cost: 0,
            rows_with_extreme_unit_rate: 0,
            outlier_row_count: 0,
            blocking_reasons: projectBlockedReasons,
            record_ids: [],
            evidence_refs: [],
          }
        : null
    );

  const kpis: SpreadsheetReviewKpis = {
    totalTickets:
      summary?.total_tickets ??
      projectOperationsOverview?.total_tickets ??
      rollups?.totalTickets ??
      distinctTransactionCount,
    totalCyd:
      summary?.total_cyd_ticket_grain ??
      summary?.total_cyd ??
      projectOperationsOverview?.total_cyd ??
      rollups?.total_cyd_ticket_grain ??
      rollups?.totalCyd ??
      null,
    totalNetTonnage,
    invoicedTickets:
      summary?.invoiced_ticket_count ??
      projectOperationsOverview?.invoiced_ticket_count ??
      rollups?.invoicedTicketCount ??
      0,
    totalInvoices:
      projectTotalInvoices ??
      summary?.distinct_invoice_count ??
      projectOperationsOverview?.distinct_invoice_count ??
      rollups?.distinctInvoiceCount ??
      0,
    totalInvoicedAmount:
      projectTotalInvoicedAmount ??
      summary?.total_invoiced_amount ??
      projectOperationsOverview?.total_invoiced_amount ??
      rollups?.totalInvoicedAmount ??
      0,
    uninvoicedLines:
      summary?.uninvoiced_line_count ??
      projectOperationsOverview?.uninvoiced_line_count ??
      rollups?.uninvoicedLineCount ??
      0,
    eligible:
      summary?.eligible_count ??
      projectOperationsOverview?.eligible_count ??
      rollups?.eligibleCount ??
      0,
    ineligible:
      summary?.ineligible_count ??
      projectOperationsOverview?.ineligible_count ??
      rollups?.ineligibleCount ??
      0,
  };

  const recordsById = buildRecordMap(records);
  const totalExtendedCost =
    asLooseNumber(summary?.total_extended_cost)
    ?? asLooseNumber(rollups?.total_extended_cost)
    ?? asLooseNumber(rollups?.totalExtendedCost)
    ?? sumRecordNumberField(records, 'extended_cost')
    ?? projectTotalInvoicedAmount
    ?? asLooseNumber(projectOperationsOverview?.total_invoiced_amount);
  const volumeBasis = determineVolumeBasis({
    summary,
    projectOperationsOverview,
    rollups,
    records,
    groupedByMaterial,
    groupedByDisposalSite,
    groupedBySiteType,
  });
  const totalProjectVolume =
    volumeBasis.metric === 'cyd'
      ? (
        asLooseNumber(summary?.total_cyd_ticket_grain)
        ?? asLooseNumber(summary?.total_cyd)
        ?? asLooseNumber(projectOperationsOverview?.total_cyd)
        ?? asLooseNumber(rollups?.total_cyd_ticket_grain)
        ?? asLooseNumber(rollups?.total_cyd)
        ?? asLooseNumber(rollups?.totalCyd)
      )
      : (
        volumeBasis.metric === 'net_tonnage'
          ? totalNetTonnage
          : null
      );
  const rateCodeRows = groupedByRateCode
    .filter(shouldSurfaceRateCodeCostDriverRow)
    .map((group) => ({
      rateCode: group.rate_code,
      description: group.rate_description_sample,
      ticketCount: group.row_count,
      amount: asLooseNumber(group.total_extended_cost),
    }))
    .sort((left, right) => {
      const amountDelta = (right.amount ?? 0) - (left.amount ?? 0);
      if (amountDelta !== 0) return amountDelta;
      return (left.rateCode ?? left.description ?? '').localeCompare(
        right.rateCode ?? right.description ?? '',
        'en-US',
      );
    });

  const rawServiceItemRows = buildServiceItemRows({
    groups: groupedByServiceItem,
    recordsById,
  });
  const totalServiceCost = rawServiceItemRows.reduce<number | null>((sum, row) => {
    if (row.amount == null) return sum;
    return (sum ?? 0) + row.amount;
  }, null);
  const serviceItemRows = rawServiceItemRows.map((row) => ({
    ...row,
    percentOfTotalServiceCost: percentOf(row.amount, totalServiceCost),
  }));
  const materialRows = buildFlowRows({
    groups: groupedByMaterial,
    getLabel: (group) => group.material,
    recordsById,
    volumeBasis,
    totalVolume: totalProjectVolume,
    totalCost: totalExtendedCost,
  });
  const disposalSiteRows = buildFlowRows({
    groups: groupedByDisposalSite,
    getLabel: (group) => group.disposal_site,
    recordsById,
    volumeBasis,
    totalVolume: totalProjectVolume,
    totalCost: totalExtendedCost,
  });
  const siteTypeRows = buildFlowRows({
    groups: groupedBySiteType,
    getLabel: (group) => group.site_type,
    recordsById,
    volumeBasis,
    totalVolume: totalProjectVolume,
    totalCost: totalExtendedCost,
  });
  const disposalSiteByRecordId = buildRecordLabelMap(
    groupedByDisposalSite,
    (group) => group.disposal_site,
    (group) => group.record_ids,
  );
  const siteTypeByRecordId = buildRecordLabelMap(
    groupedBySiteType,
    (group) => group.site_type,
    (group) => group.record_ids,
  );
  const siteByRecordId = new Map(disposalSiteByRecordId);
  for (const [recordId, siteType] of siteTypeByRecordId.entries()) {
    if (!siteByRecordId.has(recordId)) siteByRecordId.set(recordId, siteType);
  }
  const {
    riskSummary,
    groupedRiskIssues,
    riskDrilldownRows,
  } = buildRiskPresentation({
    outlierRows: sanitizedOutlierRows,
    recordsById,
    siteByRecordId,
  });

  // Pre-compute invoicedTransactionCount to avoid an O(N) filter over records at render time.
  // Mirrors the exact logic previously inlined in SpreadsheetReviewSurface.invoicedTransactionCount().
  const totalTransactionsForInvoicedCount =
    summary?.row_count
    ?? invoiceReadinessSummary?.record_ids.length
    ?? records.length;
  const precomputedInvoicedTransactionCount = invoiceReadinessSummary
    ? Math.max(totalTransactionsForInvoicedCount - invoiceReadinessSummary.uninvoiced_line_count, 0)
    : records.filter((record) =>
        typeof record.invoice_number === 'string' && record.invoice_number.trim().length > 0,
      ).length;

  return {
    records,
    summary,
    rollups,
    projectOperationsOverview,
    groupedByRateCode,
    groupedByServiceItemMobileOnly,
    groupedByMaterialMobileOnly,
    groupedByDisposalSite,
    groupedBySiteType,
    outlierRows: sanitizedOutlierRows,
    invoiceReadinessSummary,
    dmsFdsLifecycleSummary,
    kpis,
    totalExtendedCost,
    invoicedTransactionCount: precomputedInvoicedTransactionCount,
    volumeBasis,
    rateCodeRows,
    serviceItemRows,
    materialRows,
    disposalSiteRows,
    siteTypeRows,
    riskSummary,
    groupedRiskIssues,
    riskDrilldownRows,
  };
}

type DecisionMeta = {
  ids: string[];
  titles: string[];
  families: Set<NormalizedDecision['family']>;
  severity: Set<NormalizedDecision['severity']>;
  details: string[];
};

type BaseDocumentFact = Omit<
  DocumentFact,
  | 'displaySource'
  | 'displayValue'
  | 'machineValue'
  | 'machineDisplay'
  | 'humanValue'
  | 'humanDisplay'
  | 'reviewStatus'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'reviewNotes'
  | 'reviewHistory'
  | 'humanDefinedSchedule'
  | 'overrideHistory'
  | 'anchorCount'
  | 'primaryAnchor'
>;

const CONTRACT_CEILING_RATE_PRICE_LEDGER_NOTE =
  'Rate based ceiling per schedule. No total ceiling stated; Exhibit A rates are not to exceed.';

export const RATE_SCHEDULE_KIND_FIELD_KEY = 'rate_schedule_kind' as const;

const ADDITIONAL_FACT_SOURCE_PRIORITY: Record<FlattenedField['source'], number> = {
  structured_fields: 0,
  typed_fields: 1,
  section_signals: 2,
  trace_facts: 3,
  extracted: 4,
};

const FIELD_KEY_ALIASES: Record<DocumentFamily | 'generic', Record<string, string>> = {
  contract: {
    vendor_name: 'contractor_name',
    contractor: 'contractor_name',
    contract_date: 'executed_date',
    effective_date: 'executed_date',
    nte_amount: 'contract_ceiling',
    not_to_exceed_amount: 'contract_ceiling',
    contract_sum: 'contract_ceiling',
    rate_section_present: 'rate_schedule_present',
    unit_price_structure_present: 'rate_schedule_present',
    rate_section_pages: 'rate_schedule_pages',
    canonical_contract_rate_schedule_assembly_schedule_kind: RATE_SCHEDULE_KIND_FIELD_KEY,
    rate_items_detected: 'rate_row_count',
  },
  invoice: {
    vendor_name: 'contractor_name',
    contractor: 'contractor_name',
    current_amount_due: 'billed_amount',
    current_payment_due: 'billed_amount',
    total_amount: 'billed_amount',
    amount_due: 'billed_amount',
    lineitems: 'invoice_line_items',
    line_items: 'invoice_line_items',
    line_item_codes: 'line_item_codes',
    lineitemcodes: 'line_item_codes',
    periodfrom: 'period_from',
    periodto: 'period_to',
    period_start_date: 'period_start',
    period_end_date: 'period_end',
    service_period_start: 'period_start',
    service_period_end: 'period_end',
  },
  payment_recommendation: {
    vendor_name: 'contractor_name',
    contractor: 'contractor_name',
    invoice_number: 'invoice_reference',
    report_reference: 'invoice_reference',
    net_recommended_amount: 'approved_amount',
    amount_recommended_for_payment: 'approved_amount',
    date_of_invoice: 'recommendation_date',
  },
  ticket: {
    invoice_number: 'invoice_references',
  },
  spreadsheet: {
    detected_sheet_names: 'sheet_names',
    summary_detected_sheet_names: 'sheet_names',
    processed_sheet_names: 'sheet_names',
    sheet_names: 'sheet_names',
  },
  operational: {},
  generic: {},
};

const FIELD_PRIORITY: Record<DocumentFamily | 'generic', string[]> = {
  contract: [
    'contractor_name',
    'owner_name',
    'executed_date',
    'contract_ceiling',
    'rate_schedule_present',
    RATE_SCHEDULE_KIND_FIELD_KEY,
    'rate_schedule_pages',
    'rate_row_count',
    'time_and_materials_present',
  ],
  invoice: [
    'invoice_number',
    'contractor_name',
    'client_name',
    'invoice_date',
    'billed_amount',
    'period_start',
    'period_end',
    'line_item_count',
    'invoice_line_items',
    'po_number',
  ],
  payment_recommendation: [
    'invoice_reference',
    'contractor_name',
    'recommendation_date',
    'approved_amount',
  ],
  ticket: [
    'invoice_references',
    'ticket_row_count',
    'missing_quantity_rows',
    'missing_rate_rows',
    'ticket_rows',
  ],
  spreadsheet: [
    'project_operations_overview',
    'invoice_readiness_summary',
    'row_count',
    'total_tickets',
    'total_cyd',
    'total_extended_cost',
    'total_transaction_quantity',
    'invoiced_ticket_count',
    'distinct_invoice_count',
    'total_invoiced_amount',
    'uninvoiced_line_count',
    'eligible_count',
    'ineligible_count',
    'distinct_invoice_numbers',
    'distinct_rate_codes',
    'distinct_service_items',
    'distinct_materials',
    'grouped_by_service_item',
    'grouped_by_material',
    'grouped_by_site_type',
    'grouped_by_disposal_site',
    'grouped_by_rate_code',
    'grouped_by_invoice',
    'grouped_by_site_material',
    'dms_fds_lifecycle_summary',
    'outlier_rows',
    'boundary_location_review',
    'distance_from_feature_review',
    'debris_class_at_disposal_site_review',
    'mileage_review',
    'load_call_review',
    'linked_mobile_load_consistency_review',
    'truck_trip_time_review',
    'rows_with_missing_rate_code',
    'rows_with_missing_invoice_number',
    'rows_with_missing_quantity',
    'rows_with_missing_extended_cost',
    'rows_with_zero_cost',
    'rows_with_extreme_unit_rate',
    'transaction_data_records',
    'header_map',
    'detected_header_map',
    'sheet_names',
    'detected_sheet_names',
    'inferred_date_range_start',
    'inferred_date_range_end',
    'sheet_count',
  ],
  operational: [],
  generic: [
    'document_id',
    'document_number',
    'project_name',
    'contractor_name',
    'invoice_number',
    'invoice_date',
    'billed_amount',
  ],
};

const SECONDARY_ADAPTER_FIELDS = new Set([
  'schema_type',
  'material_types',
  'detected_document_type',
]);

const RAW_VALUE_ALIASES: Record<string, string[]> = {
  contractor_name: ['vendor_name', 'contractorName', 'contractor'],
  client_name: ['customer_name', 'owner_name', 'clientName', 'ownerName', 'bill_to_name'],
  owner_name: ['ownerName', 'client_name', 'customer_name'],
  executed_date: ['contract_date', 'effective_date', 'executedDate'],
  contract_ceiling: ['nte_amount', 'notToExceedAmount', 'contract_sum'],
  billed_amount: ['current_amount_due', 'currentPaymentDue', 'total_amount'],
  approved_amount: ['amountRecommendedForPayment', 'approved_amount', 'net_recommended_amount'],
  invoice_reference: ['invoice_number', 'report_reference'],
  recommendation_date: ['recommendationDate', 'date_of_invoice'],
  line_item_support_present: ['line_items'],
  line_item_count: ['line_items'],
};

const DISPLAYABLE_METADATA_KEY_EXCEPTIONS = new Set([
  'rate_section_pages',
  'rate_schedule_pages',
]);

const INTERNAL_METADATA_KEY_SEGMENTS = new Set([
  'anchor',
  'confidence',
  'context',
  'evidence',
  'heuristic',
  'location',
  'match',
  'matches',
  'matching',
  'method',
  'page',
  'pages',
  'parser',
  'reason',
  'region',
  'score',
  'source',
]);

const GROUP_DEFINITIONS: Record<
  DocumentFamily | 'fallback',
  Array<{ key: string; label: string; order: number; patterns: RegExp[] }>
> = {
  contract: [
    {
      key: 'document_identity',
      label: 'Document Identity',
      order: 10,
      patterns: [/document/i, /contract_number/i, /project/i, /vendor_number/i],
    },
    {
      key: 'parties',
      label: 'Parties',
      order: 20,
      patterns: [/contractor/i, /owner/i, /vendor/i, /customer/i, /applicant/i, /payee/i],
    },
    {
      key: 'dates',
      label: 'Dates',
      order: 30,
      patterns: [/date/i, /term/i, /period/i, /renewal/i, /expiration/i],
    },
    {
      key: 'financial_terms',
      label: 'Financial Terms',
      order: 40,
      patterns: [/amount/i, /total/i, /sum/i, /ceiling/i, /fee/i, /cost/i, /retainage/i],
    },
    {
      key: 'rate_schedule',
      label: 'Rate Schedule',
      order: 50,
      patterns: [/rate/i, /pricing/i, /unit/i, /line_item/i, /schedule/i, /time_and_materials/i],
    },
    {
      key: 'compliance_clauses',
      label: 'Compliance Clauses',
      order: 60,
      patterns: [/compliance/i, /fema/i, /federal/i, /insurance/i, /permit/i, /tdec/i],
    },
    {
      key: 'approval_execution',
      label: 'Approval And Execution',
      order: 70,
      patterns: [/approv/i, /sign/i, /execut/i, /author/i],
    },
    {
      key: 'scope_geography',
      label: 'Scope And Geography',
      order: 80,
      patterns: [/scope/i, /location/i, /site/i, /county/i, /state/i, /geograph/i],
    },
  ],
  invoice: [
    {
      key: 'contractor_client',
      label: 'Contractor And Client',
      order: 10,
      patterns: [/vendor/i, /payee/i, /contractor/i, /owner/i, /applicant/i, /client/i],
    },
    {
      key: 'invoice_identifiers',
      label: 'Invoice Identifiers',
      order: 20,
      patterns: [/invoice/i, /reference/i, /report/i, /po_/i, /purchase_order/i, /contract_number/i],
    },
    {
      key: 'billing_period',
      label: 'Service Period',
      order: 30,
      patterns: [/period/i, /invoice_date/i, /billing/i, /service_date/i, /date/i],
    },
    {
      key: 'amounts',
      label: 'Amounts',
      order: 40,
      patterns: [/amount/i, /total/i, /due/i, /paid/i, /sum/i, /retainage/i],
    },
    {
      key: 'rate_lines',
      label: 'Rate Lines',
      order: 50,
      patterns: [/line_item/i, /rate/i, /qty/i, /quantity/i, /unit/i],
    },
    {
      key: 'approvals',
      label: 'Approvals',
      order: 60,
      patterns: [/approv/i, /recommend/i, /author/i],
    },
    {
      key: 'supporting_references',
      label: 'Supporting References',
      order: 70,
      patterns: [/support/i, /ticket/i, /attachment/i, /backup/i, /reference/i],
    },
  ],
  payment_recommendation: [
    {
      key: 'parties',
      label: 'Parties',
      order: 10,
      patterns: [/contractor/i, /vendor/i, /applicant/i, /owner/i, /payee/i],
    },
    {
      key: 'recommendation_context',
      label: 'Recommendation Context',
      order: 20,
      patterns: [/recommend/i, /invoice_reference/i, /report/i, /document/i],
    },
    {
      key: 'amounts',
      label: 'Amounts',
      order: 30,
      patterns: [/amount/i, /total/i, /adjustment/i, /payment/i],
    },
    {
      key: 'dates',
      label: 'Dates',
      order: 40,
      patterns: [/date/i, /period/i],
    },
    {
      key: 'approvals',
      label: 'Approvals',
      order: 50,
      patterns: [/approv/i, /author/i, /review/i],
    },
  ],
  ticket: [
    {
      key: 'document_identity',
      label: 'Document Identity',
      order: 10,
      patterns: [/ticket/i, /document/i, /invoice_reference/i],
    },
    {
      key: 'operations',
      label: 'Operations',
      order: 20,
      patterns: [/row/i, /quantity/i, /rate/i, /load/i, /dump/i, /truck/i, /capacity/i],
    },
    {
      key: 'dates',
      label: 'Dates',
      order: 30,
      patterns: [/date/i, /period/i],
    },
    {
      key: 'references',
      label: 'References',
      order: 40,
      patterns: [/reference/i, /site/i, /material/i, /contractor/i],
    },
  ],
  spreadsheet: [
    {
      key: 'dataset_summary',
      label: 'Dataset Summary',
      order: 10,
      patterns: [
        /source_type/i,
        /project/i,
        /project_operations_overview/i,
        /invoice_readiness_summary/i,
        /^row_count$/i,
        /^total_/i,
        /^distinct_/i,
        /^invoiced_ticket_count$/i,
        /^uninvoiced_line_count$/i,
        /^eligible_count$/i,
        /^ineligible_count$/i,
        /header_map/i,
        /sheet_names/i,
        /inferred_date_range/i,
      ],
    },
    {
      key: 'grouped_review_tables',
      label: 'Grouped Review Tables',
      order: 20,
      patterns: [/^grouped_by_/i, /dms_fds_lifecycle_summary/i],
    },
    {
      key: 'flags_outliers',
      label: 'Flags And Outliers',
      order: 30,
      patterns: [/outlier_rows/i, /^rows_with_/i, /_review$/i],
    },
    {
      key: 'row_drilldown',
      label: 'Row-Level Drilldown',
      order: 40,
      patterns: [/transaction_data_records/i],
    },
    {
      key: 'document_identity',
      label: 'Document Identity',
      order: 50,
      patterns: [/sheet/i, /workbook/i, /document/i],
    },
  ],
  operational: [
    {
      key: 'document_identity',
      label: 'Document Identity',
      order: 10,
      patterns: [/document/i, /report/i, /project/i],
    },
    {
      key: 'operations',
      label: 'Operations',
      order: 20,
      patterns: [/site/i, /location/i, /status/i, /material/i, /task/i],
    },
    {
      key: 'dates',
      label: 'Dates',
      order: 30,
      patterns: [/date/i, /period/i],
    },
  ],
  generic: [
    {
      key: 'document_identity',
      label: 'Document Identity',
      order: 10,
      patterns: [/document/i, /project/i, /type/i, /identifier/i],
    },
    {
      key: 'parties',
      label: 'Parties',
      order: 20,
      patterns: [/vendor/i, /contractor/i, /owner/i, /customer/i, /applicant/i, /payee/i],
    },
    {
      key: 'dates',
      label: 'Dates',
      order: 30,
      patterns: [/date/i, /period/i, /term/i],
    },
    {
      key: 'financials',
      label: 'Financials',
      order: 40,
      patterns: [/amount/i, /total/i, /rate/i, /fee/i, /cost/i, /sum/i, /balance/i],
    },
    {
      key: 'references',
      label: 'References',
      order: 50,
      patterns: [/invoice/i, /contract/i, /reference/i, /support/i, /attachment/i, /ticket/i],
    },
    {
      key: 'signals',
      label: 'Extracted Signals',
      order: 60,
      patterns: [/present/i, /missing/i, /confidence/i, /signal/i],
    },
  ],
  fallback: [
    {
      key: 'additional_fields',
      label: 'Additional Extracted Fields',
      order: 99,
      patterns: [/.*/],
    },
  ],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asTransactionDataExtraction(value: unknown): TransactionDataExtraction | null {
  const record = asRecord(value);
  if (!record) return null;
  const hasUsableShape =
    record.sourceType === 'transaction_data'
    || typeof record.rowCount === 'number'
    || Array.isArray(record.records)
    || asRecord(record.summary) != null
    || asRecord(record.rollups) != null;
  return hasUsableShape ? (record as unknown as TransactionDataExtraction) : null;
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Human labels for stable schema keys; invoice party keys use operator-facing contractor/client language. */
const FACT_FIELD_LABEL_OVERRIDES: Record<string, string> = {
  contractor_name: 'Contractor',
  client_name: 'Client',
  owner_name: 'Client',
  [RATE_SCHEDULE_KIND_FIELD_KEY]: 'Rate Schedule Kind',
};

function fieldLabelForKey(fieldKey: string): string {
  return FACT_FIELD_LABEL_OVERRIDES[fieldKey] ?? titleize(fieldKey);
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scalarToString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => scalarToString(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}

function canonicalFieldKey(fieldKey: string, family: DocumentFamily): string {
  const normalized = toSnakeCase(fieldKey);
  return (
    FIELD_KEY_ALIASES[family]?.[normalized] ??
    FIELD_KEY_ALIASES.generic[normalized] ??
    normalized
  );
}

function isInternalMetadataFieldKey(fieldKey: string): boolean {
  const normalized = toSnakeCase(fieldKey);
  if (DISPLAYABLE_METADATA_KEY_EXCEPTIONS.has(normalized)) return false;

  const segments = normalized.split('_').filter(Boolean);
  const lastSegment = segments.at(-1) ?? normalized;

  return INTERNAL_METADATA_KEY_SEGMENTS.has(lastSegment);
}

const INVOICE_DISPLAY_HIDDEN_FACT_KEYS = new Set([
  'invoice_status',
  'status',
  'section',
  'normalized',
  'text',
  'raw_text',
  'rawtext',
  'raw_section_text',
  'section_text',
  'period_through',
  'period_from',
  'period_to',
]);

const INVOICE_PERIOD_RANGE_FACT_KEYS = new Set([
  'billing_period',
  'invoice_period',
  'period',
]);

function parseInvoiceDisplayAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const parsed = Number.parseFloat(trimmed.replace(/[()$,\s]/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function invoiceFactAmountValue(fact: DocumentFact): number | null {
  return (
    parseInvoiceDisplayAmount(fact.normalizedValue)
    ?? parseInvoiceDisplayAmount(fact.valueNumber)
    ?? parseInvoiceDisplayAmount(fact.displayValue)
    ?? parseInvoiceDisplayAmount(fact.rawValue)
  );
}

function invoiceLineItemRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  return invoiceLineItemRows(record.line_items ?? record.lineItems ?? record.items);
}

function hasInvoiceLineItemTable(facts: readonly DocumentFact[]): boolean {
  return facts.some((fact) => {
    const key = canonicalFieldKey(fact.fieldKey, 'invoice');
    if (key !== 'invoice_line_items') return false;
    return invoiceLineItemRows(fact.normalizedValue ?? fact.machineValue).length > 0;
  });
}

function shouldHideInvoiceDisplayFact(fact: DocumentFact, allFacts: readonly DocumentFact[]): boolean {
  const canonical = canonicalFieldKey(fact.fieldKey, 'invoice');
  const normalized = toSnakeCase(fact.fieldKey);
  const hasLineItems = hasInvoiceLineItemTable(allFacts);
  const hasServicePeriodEndpoints = allFacts.some((candidate) => {
    const key = canonicalFieldKey(candidate.fieldKey, 'invoice');
    return (
      (key === 'period_start' || key === 'period_end')
      && candidate.reviewState !== 'missing'
      && candidate.displayValue !== 'Missing'
    );
  });

  if (canonical === 'invoice_line_items' || canonical === 'line_item_count') return false;
  if (canonical === 'line_item_support_present' && hasLineItems) return true;
  if (canonical === 'line_item_codes' && hasLineItems) return true;

  if (canonical === 'subtotal_amount') {
    const billed = allFacts.find((candidate) =>
      canonicalFieldKey(candidate.fieldKey, 'invoice') === 'billed_amount',
    );
    const billedAmount = billed ? invoiceFactAmountValue(billed) : null;
    const subtotalAmount = invoiceFactAmountValue(fact);
    if (billedAmount != null && subtotalAmount != null) {
      return Math.abs(billedAmount - subtotalAmount) < 0.015;
    }
    return billed != null && billed.displayValue === fact.displayValue;
  }

  if (INVOICE_DISPLAY_HIDDEN_FACT_KEYS.has(canonical) || INVOICE_DISPLAY_HIDDEN_FACT_KEYS.has(normalized)) {
    return true;
  }

  if (canonical === 'period_start' || canonical === 'period_end') return false;
  if (
    hasServicePeriodEndpoints
    && (INVOICE_PERIOD_RANGE_FACT_KEYS.has(canonical) || INVOICE_PERIOD_RANGE_FACT_KEYS.has(normalized))
  ) {
    return true;
  }

  const segments = normalized.split('_').filter(Boolean);
  const lastSegment = segments.at(-1) ?? normalized;
  if (['text', 'helper', 'normalized', 'section'].includes(lastSegment)) return true;
  if (normalized.includes('raw_section')) return true;
  if (
    normalized.includes('raw')
    && (normalized.includes('text') || normalized.includes('helper') || normalized.includes('section'))
  ) {
    return true;
  }

  return false;
}

function filterDisplayFactsForFamily(
  facts: readonly DocumentFact[],
  family: DocumentFamily,
): DocumentFact[] {
  if (family !== 'invoice') return [...facts];
  return facts.filter((fact) => !shouldHideInvoiceDisplayFact(fact, facts));
}

/**
 * Missing-evidence signal: any fact with zero anchors (machine or human) may need PDF grounding.
 * Override / review display precedence is unchanged; this only drives badges and strip counts.
 */
export function shouldShowMissingEvidenceBadge(fact: DocumentFact): boolean {
  return fact.anchors.length === 0;
}

function shouldCountLowConfidence(fact: DocumentFact): boolean {
  return (
    fact.reviewState !== 'reviewed' &&
    fact.reviewState !== 'overridden' &&
    fact.confidenceLabel === 'low'
  );
}

function fieldPriorityRank(family: DocumentFamily, fieldKey: string): number {
  const canonical = canonicalFieldKey(fieldKey, family);
  const priorities = [...(FIELD_PRIORITY[family] ?? []), ...FIELD_PRIORITY.generic];
  const index = priorities.indexOf(canonical);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function comparableValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => comparableValue(item)).join('|');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

function inferValueType(fieldKey: string, value: unknown): DocumentFactValueType {
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    if (fieldKey === 'rate_row_count') return 'number';
    if (/(percent|pct|ratio|rate_pct|rate_percent)/i.test(fieldKey)) return 'percent';
    // Count fields are tallies, not money. Classify them before the currency
    // heuristic below so keys containing `total` (e.g. `total_tickets`) or ending in
    // `_count` (`row_count`, `eligible_count`) are not rendered with a `$`.
    if (
      /^total_tickets$/i.test(fieldKey) ||
      /(^|_)row_count$/i.test(fieldKey) ||
      /(^|_)count$/i.test(fieldKey)
    ) {
      return 'number';
    }
    // Volume / physical-quantity fields carry units (CYD, miles, tons, in), not
    // dollars. Classify them as plain numbers so the broad currency regex does not
    // force a `$`. (Unit-bearing display is deferred to a future `quantity` type.)
    if (
      /(^|_)cyd(_|$)/i.test(fieldKey) ||
      /(^|_)mileage(_|$)/i.test(fieldKey) ||
      /(^|_)diameter(_|$)/i.test(fieldKey) ||
      /(^|_)tonnage(_|$)/i.test(fieldKey) ||
      /(^|_)transaction_quantity(_|$)/i.test(fieldKey) ||
      /_quantity$/i.test(fieldKey)
    ) {
      return 'number';
    }
    if (/(amount|total|sum|ceiling|due|cost|fee|price|rate|balance|retainage|payment)/i.test(fieldKey)) {
      return 'currency';
    }
    return 'number';
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    const isDateRange = /\b(to|through|until)\b/.test(normalized);
    if (
      !isDateRange &&
      (/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value))) &&
      /date|period|term|renewal|expiration|effective/i.test(fieldKey)
    ) {
      return 'date';
    }
    return 'text';
  }
  return 'unknown';
}

function formatFactValue(value: unknown, valueType: DocumentFactValueType): string {
  if (value == null) return 'Missing';
  if (valueType === 'boolean') return value === true ? 'true' : 'false';
  if (valueType === 'date') {
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    return raw;
  }
  if (valueType === 'currency' && typeof value === 'number') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  }
  if (valueType === 'percent' && typeof value === 'number') {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      maximumFractionDigits: 3,
    }).format(value);
  }
  if (valueType === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const scalar = scalarToString(item);
      if (scalar != null) return scalar;
      if (item != null && typeof item === 'object') return compactStructuredValue(item);
      return 'Unavailable';
    }).join(', ');
  }
  if (typeof value === 'object') return compactStructuredValue(value);
  return String(value);
}

function compactStructuredValue(value: unknown): string {
  if (value == null) return 'Unavailable';
  if (Array.isArray(value)) return formatFactValue(value, 'array');
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const preferred = [
    record.line_description,
    record.lineDescription,
    record.description,
    record.code,
    record.line_code,
    record.lineCode,
  ]
    .map((item) => scalarToString(item))
    .filter((item): item is string => Boolean(item));
  if (preferred.length > 0) return preferred.join(' / ');
  const entries = Object.entries(record)
    .map(([key, item]) => {
      const scalar = scalarToString(item);
      return scalar ? `${titleize(key)}: ${scalar}` : null;
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, 4);
  return entries.length > 0 ? entries.join(' | ') : 'Unavailable';
}

function withDisplayMetadata(fact: BaseDocumentFact): DocumentFact {
  return {
    ...fact,
    machineClassification: fact.machineClassification ?? null,
    anchorCount: fact.anchors.length,
    primaryAnchor: fact.anchors[0] ?? null,
    displaySource: 'auto',
    displayValue: fact.normalizedDisplay,
    machineValue: fact.normalizedValue,
    machineDisplay: fact.normalizedDisplay,
    humanValue: null,
    humanDisplay: null,
    reviewStatus: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    reviewHistory: [],
    humanDefinedSchedule: false,
    overrideHistory: [],
  };
}

function resolvedValueTypeForDisplay(
  fieldKey: string,
  valueType: DocumentFactValueType,
  value: unknown,
): DocumentFactValueType {
  const inferred = inferValueType(fieldKey, value);
  if (valueType === 'unknown') return inferred;
  if (valueType === 'text' && inferred !== 'text' && inferred !== 'unknown') return inferred;
  return valueType;
}

function compareOverrideHistory(
  left: DocumentFactOverrideRecord,
  right: DocumentFactOverrideRecord,
): number {
  if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function groupFactOverrides(
  overrides: DocumentFactOverrideRecord[],
  family: DocumentFamily,
): Map<string, DocumentFactOverrideRecord[]> {
  return overrides.reduce((map, override) => {
    const key = canonicalFieldKey(override.fieldKey, family);
    const current = map.get(key) ?? [];
    current.push({
      ...override,
      fieldKey: key,
    });
    current.sort(compareOverrideHistory);
    map.set(key, current);
    return map;
  }, new Map<string, DocumentFactOverrideRecord[]>());
}

function compareFactReviews(
  left: DocumentFactReviewRecord,
  right: DocumentFactReviewRecord,
): number {
  const leftTime = Date.parse(left.reviewedAt);
  const rightTime = Date.parse(right.reviewedAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.reviewedAt.localeCompare(left.reviewedAt);
}

function groupFactReviews(
  reviews: DocumentFactReviewRecord[],
  family: DocumentFamily,
): Map<string, DocumentFactReviewRecord[]> {
  return reviews.reduce((map, review) => {
    const key = canonicalFieldKey(review.fieldKey, family);
    const current = map.get(key) ?? [];
    current.push({
      ...review,
      fieldKey: key,
    });
    current.sort(compareFactReviews);
    map.set(key, current);
    return map;
  }, new Map<string, DocumentFactReviewRecord[]>());
}

function reviewStatusLabel(status: DocumentFactReviewStatus): string {
  switch (status) {
    case 'confirmed':
      return 'confirmed';
    case 'corrected':
      return 'reviewed correction';
    case 'missing_confirmed':
      return 'missing confirmed';
    default:
      return 'needs followup';
  }
}

function toReviewHistoryItem(
  fieldKey: string,
  valueType: DocumentFactValueType,
  review: DocumentFactReviewRecord,
): DocumentFactReviewHistoryItem {
  const reviewedValueDisplay =
    review.reviewedValueJson == null
      ? null
      : formatFactValue(
          review.reviewedValueJson,
          resolvedValueTypeForDisplay(fieldKey, valueType, review.reviewedValueJson),
        );

  return {
    id: review.id,
    fieldKey,
    reviewStatus: review.reviewStatus,
    reviewedValueJson: review.reviewedValueJson,
    reviewedValueDisplay,
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt,
    notes: review.notes,
  };
}

function applyFactReviews(
  fact: DocumentFact,
  reviews: DocumentFactReviewRecord[],
): DocumentFact {
  if (reviews.length === 0) return fact;

  const latest = reviews[0];
  const reviewHistory = reviews.map((review) =>
    toReviewHistoryItem(fact.fieldKey, fact.valueType, review),
  );
  const note = latest.notes && latest.notes.trim().length > 0
    ? `Fact review: ${latest.notes.trim()}`
    : `Fact review status: ${reviewStatusLabel(latest.reviewStatus)}.`;
  const reviewedBase: DocumentFact = {
    ...fact,
    reviewStatus: latest.reviewStatus,
    reviewedBy: latest.reviewedBy,
    reviewedAt: latest.reviewedAt,
    reviewNotes: latest.notes,
    reviewHistory,
    normalizationNotes: fact.normalizationNotes.includes(note)
      ? fact.normalizationNotes
      : [note, ...fact.normalizationNotes],
  };

  if (latest.reviewStatus === 'needs_followup') {
    return {
      ...reviewedBase,
      statusLabel: reviewStatusLabel(latest.reviewStatus),
    };
  }

  if (latest.reviewStatus === 'confirmed') {
    if (latest.reviewedValueJson != null) {
      const resolvedValueType = resolvedValueTypeForDisplay(
        fact.fieldKey,
        fact.valueType,
        latest.reviewedValueJson,
      );
      const reviewedDisplay = formatFactValue(latest.reviewedValueJson, resolvedValueType);
      return {
        ...reviewedBase,
        valueType: resolvedValueType,
        reviewState: 'reviewed',
        statusLabel: reviewStatusLabel(latest.reviewStatus),
        displayValue: reviewedDisplay,
        humanValue: latest.reviewedValueJson,
        humanDisplay: reviewedDisplay,
      };
    }

    return {
      ...reviewedBase,
      reviewState: 'reviewed',
      statusLabel: reviewStatusLabel(latest.reviewStatus),
    };
  }

  if (latest.reviewStatus === 'missing_confirmed') {
    return {
      ...reviewedBase,
      reviewState: 'reviewed',
      statusLabel: reviewStatusLabel(latest.reviewStatus),
    };
  }

  if (latest.reviewStatus === 'corrected' && latest.reviewedValueJson != null) {
    const resolvedValueType = resolvedValueTypeForDisplay(
      fact.fieldKey,
      fact.valueType,
      latest.reviewedValueJson,
    );
    const reviewedDisplay = formatFactValue(latest.reviewedValueJson, resolvedValueType);
    return {
      ...reviewedBase,
      valueType: resolvedValueType,
      reviewState: 'reviewed',
      statusLabel: reviewStatusLabel(latest.reviewStatus),
      displaySource: 'human_corrected',
      displayValue: reviewedDisplay,
      humanValue: latest.reviewedValueJson,
      humanDisplay: reviewedDisplay,
    };
  }

  return reviewedBase;
}

function toOverrideHistoryItem(
  fieldKey: string,
  valueType: DocumentFactValueType,
  override: DocumentFactOverrideRecord,
): DocumentFactOverrideHistoryItem {
  const resolvedValueType = resolvedValueTypeForDisplay(fieldKey, valueType, override.valueJson);
  return {
    id: override.id,
    fieldKey,
    valueJson: override.valueJson,
    valueDisplay: formatFactValue(override.valueJson, resolvedValueType),
    rawValue: override.rawValue,
    actionType: override.actionType,
    displaySource: displaySourceFromActionType(override.actionType),
    reason: override.reason,
    createdBy: override.createdBy,
    createdAt: override.createdAt,
    isActive: override.isActive,
    supersedesOverrideId: override.supersedesOverrideId,
  };
}

function applyFactOverrides(
  fact: DocumentFact,
  overrides: DocumentFactOverrideRecord[],
): DocumentFact {
  if (overrides.length === 0) return fact;

  const activeOverride = overrides.find((override) => override.isActive) ?? null;
  const overrideHistory = overrides.map((override) =>
    toOverrideHistoryItem(fact.fieldKey, fact.valueType, override),
  );

  if (!activeOverride) {
    return {
      ...fact,
      overrideHistory,
    };
  }

  const resolvedValueType = resolvedValueTypeForDisplay(
    fact.fieldKey,
    fact.valueType,
    activeOverride.valueJson,
  );
  const humanDisplay = formatFactValue(activeOverride.valueJson, resolvedValueType);
  const note =
    activeOverride.reason && activeOverride.reason.trim().length > 0
      ? `Human override reason: ${activeOverride.reason}`
      : `Human ${activeOverride.actionType === 'add' ? 'addition' : 'correction'} is active.`;

  return {
    ...fact,
    valueType: resolvedValueType,
    reviewState: 'overridden',
    statusLabel: factStatusLabel('overridden'),
    displaySource: displaySourceFromActionType(activeOverride.actionType),
    displayValue: humanDisplay,
    humanValue: activeOverride.valueJson,
    humanDisplay,
    overrideHistory,
    normalizationNotes: fact.normalizationNotes.includes(note)
      ? fact.normalizationNotes
      : [note, ...fact.normalizationNotes],
  };
}

function normalizeDocumentFactAnchorRect(
  value: unknown,
): DocumentFactAnchorRect | null {
  const rect = asRecord(value);
  if (!rect) return null;

  const x = typeof rect.x === 'number' ? rect.x : null;
  const y = typeof rect.y === 'number' ? rect.y : null;
  const width = typeof rect.width === 'number' ? rect.width : null;
  const height = typeof rect.height === 'number' ? rect.height : null;
  if (x == null || y == null || width == null || height == null) return null;

  return {
    x,
    y,
    width,
    height,
    layoutWidth: typeof rect.layoutWidth === 'number' ? rect.layoutWidth : null,
    layoutHeight: typeof rect.layoutHeight === 'number' ? rect.layoutHeight : null,
  };
}

function compareFactAnchorRecords(
  left: DocumentFactAnchorRecord,
  right: DocumentFactAnchorRecord,
): number {
  if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function groupFactAnchors(
  anchors: DocumentFactAnchorRecord[],
  family: DocumentFamily,
): Map<string, DocumentFactAnchorRecord[]> {
  return anchors.reduce((map, anchor) => {
    const key = canonicalFieldKey(anchor.fieldKey, family);
    const current = map.get(key) ?? [];
    current.push({
      ...anchor,
      fieldKey: key,
    });
    current.sort(compareFactAnchorRecords);
    map.set(key, current);
    return map;
  }, new Map<string, DocumentFactAnchorRecord[]>());
}

function compareDocumentEvidenceAnchors(
  left: DocumentEvidenceAnchor,
  right: DocumentEvidenceAnchor,
): number {
  if ((left.isPrimary ?? false) !== (right.isPrimary ?? false)) {
    return left.isPrimary ? -1 : 1;
  }
  if (left.anchorSource !== right.anchorSource) {
    return left.anchorSource === 'human' ? -1 : 1;
  }
  const leftPage = left.startPage ?? left.pageNumber ?? Number.MAX_SAFE_INTEGER;
  const rightPage = right.startPage ?? right.pageNumber ?? Number.MAX_SAFE_INTEGER;
  if (leftPage !== rightPage) return leftPage - rightPage;
  return left.id.localeCompare(right.id);
}

function mergeDocumentEvidenceAnchors(anchors: DocumentEvidenceAnchor[]): DocumentEvidenceAnchor[] {
  const byId = new Map<string, DocumentEvidenceAnchor>();
  for (const anchor of anchors) {
    if (!byId.has(anchor.id)) {
      byId.set(anchor.id, anchor);
    }
  }
  return [...byId.values()].sort(compareDocumentEvidenceAnchors);
}

function buildHumanAnchor(params: {
  factId: string;
  documentId: string;
  anchor: DocumentFactAnchorRecord;
}): DocumentEvidenceAnchor {
  const rect = normalizeDocumentFactAnchorRect(params.anchor.rectJson);
  const geometry = rect
    ? {
        polygon: [
          [rect.x, rect.y],
          [rect.x + rect.width, rect.y],
          [rect.x + rect.width, rect.y + rect.height],
          [rect.x, rect.y + rect.height],
        ] as Array<[number, number]>,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        layoutWidth: rect.layoutWidth ?? undefined,
        layoutHeight: rect.layoutHeight ?? undefined,
      }
    : null;

  return {
    id: `manual:${params.anchor.id}`,
    factId: params.factId,
    evidenceId: params.anchor.id,
    sourceDocumentId: params.documentId,
    anchorSource: 'human',
    anchorType: params.anchor.anchorType,
    overrideId: params.anchor.overrideId,
    isPrimary: params.anchor.isPrimary,
    pageNumber: params.anchor.pageNumber,
    startPage: params.anchor.startPage,
    endPage: params.anchor.endPage,
    snippet: params.anchor.snippet,
    quoteText: params.anchor.quoteText,
    parserSource: 'human_anchor',
    sourceLayer:
      params.anchor.anchorType === 'table_region'
        ? 'Human table region'
        : params.anchor.anchorType === 'page_range'
          ? 'Human page range'
          : params.anchor.anchorType === 'region'
            ? 'Human region'
            : 'Human text',
    sourceRegionId: params.anchor.id,
    matchType:
      params.anchor.anchorType === 'table_region'
        ? 'human table region anchor'
        : params.anchor.anchorType === 'page_range'
          ? 'human page range anchor'
          : params.anchor.anchorType === 'region'
            ? 'human region anchor'
            : 'human text anchor',
    extractionVersion: null,
    startOffset: null,
    endOffset: null,
    confidence: null,
    weak: false,
    geometry,
    geometryResolution: geometry ? 'none' : 'none',
  };
}

function applyPersistedFactAnchors(
  fact: DocumentFact,
  factAnchors: DocumentFactAnchorRecord[],
): DocumentFact {
  if (factAnchors.length === 0) {
    return {
      ...fact,
      anchorCount: fact.anchors.length,
      primaryAnchor: fact.anchors[0] ?? null,
    };
  }

  const activeOverrideId = fact.overrideHistory.find((item) => item.isActive)?.id ?? null;
  const relevantAnchors = factAnchors.filter(
    (anchor) => anchor.overrideId == null || anchor.overrideId === activeOverrideId,
  );

  if (relevantAnchors.length === 0) {
    return {
      ...fact,
      anchorCount: fact.anchors.length,
      primaryAnchor: fact.anchors[0] ?? null,
    };
  }

  const manualAnchors = relevantAnchors.map((anchor) =>
    buildHumanAnchor({
      factId: fact.id,
      documentId: fact.documentId,
      anchor,
    }),
  );

  const anchors = mergeDocumentEvidenceAnchors([...manualAnchors, ...fact.anchors]);
  const primaryAnchor = anchors[0] ?? null;

  return {
    ...fact,
    anchors,
    evidenceCount: anchors.length,
    anchorCount: anchors.length,
    primaryAnchor,
    primaryPage: primaryAnchor?.pageNumber ?? null,
  };
}

const RATE_SCHEDULE_CONTROL_FIELD_KEY = 'rate_schedule_pages';
const RATE_SCHEDULE_FACT_FIELDS = ['rate_schedule_present', 'rate_schedule_pages'] as const;

function isRateScheduleControlAnchorRecord(anchor: DocumentFactAnchorRecord): boolean {
  return anchor.anchorType === 'page_range' || anchor.anchorType === 'table_region';
}

function formatRateSchedulePagesValue(startPage: number, endPage: number): string {
  return startPage === endPage ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
}

function manualDisplaySourceForFact(fact: DocumentFact): Exclude<DocumentFactDisplaySource, 'auto'> {
  return fact.machineValue == null || fact.machineDisplay === 'Missing'
    ? 'human_added'
    : 'human_corrected';
}

function ensureRateScheduleFact(
  facts: DocumentFact[],
  family: DocumentFamily,
  documentId: string,
  fieldKey: (typeof RATE_SCHEDULE_FACT_FIELDS)[number],
): DocumentFact {
  const existing = facts.find(
    (fact) => canonicalFieldKey(fact.fieldKey, family) === fieldKey,
  );
  if (existing) return existing;

  const group = resolveSchemaGroup(family, fieldKey);
  return withDisplayMetadata({
    id: `${documentId}:${fieldKey}:rate-schedule`,
    documentId,
    fieldKey,
    fieldLabel: fieldLabelForKey(fieldKey),
    schemaGroup: group.key,
    schemaGroupLabel: group.label,
    valueType: fieldKey === 'rate_schedule_present' ? 'boolean' : 'text',
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBoolean: null,
    normalizedValue: null,
    normalizedDisplay: 'Missing',
    rawValue: null,
    rawDisplay: null,
    confidence: null,
    confidenceLabel: 'none',
    confidenceReason: 'No machine-defined rate schedule location is available.',
    reviewState: 'missing',
    statusLabel: factStatusLabel('missing'),
    evidenceCount: 0,
    primaryPage: null,
    anchors: [],
    normalizationNotes: [],
    missingSourceContext: [],
    derivationKind: 'human_schedule_control',
    relatedDecisionIds: [],
    relatedDecisionTitles: [],
  });
}

function applyHumanRateScheduleToFact(params: {
  fact: DocumentFact;
  humanAnchor: DocumentEvidenceAnchor;
  fieldKey: (typeof RATE_SCHEDULE_FACT_FIELDS)[number];
  pagesDisplay: string;
}): DocumentFact {
  const humanValue = params.fieldKey === 'rate_schedule_present' ? true : params.pagesDisplay;
  const humanDisplay = params.fieldKey === 'rate_schedule_present' ? 'true' : params.pagesDisplay;
  const anchors = mergeDocumentEvidenceAnchors([
    {
      ...params.humanAnchor,
      factId: params.fact.id,
    },
    ...params.fact.anchors,
  ]);
  const primaryAnchor = anchors[0] ?? null;
  const note = `Human-defined rate schedule ${params.pagesDisplay} is active.`;

  return {
    ...params.fact,
    reviewState: 'overridden',
    statusLabel: factStatusLabel('overridden'),
    displaySource: manualDisplaySourceForFact(params.fact),
    displayValue: humanDisplay,
    humanValue,
    humanDisplay,
    humanDefinedSchedule: true,
    derivationKind: 'human_schedule_control',
    anchors,
    evidenceCount: anchors.length,
    anchorCount: anchors.length,
    primaryAnchor,
    primaryPage: primaryAnchor?.pageNumber ?? null,
    normalizationNotes: params.fact.normalizationNotes.includes(note)
      ? params.fact.normalizationNotes
      : [note, ...params.fact.normalizationNotes],
  };
}

function applyHumanRateScheduleDefinition(params: {
  facts: DocumentFact[];
  family: DocumentFamily;
  documentId: string;
  anchorRecord: DocumentFactAnchorRecord | null;
}): {
  facts: DocumentFact[];
  rateScheduleSource: 'auto' | 'human';
  rateSchedulePages: string | null;
  rateScheduleAnchor: DocumentEvidenceAnchor | null;
  humanDefinedSchedule: boolean;
} {
  if (!params.anchorRecord || !isRateScheduleControlAnchorRecord(params.anchorRecord)) {
    const rateSchedulePagesFact =
      params.facts.find(
        (fact) => canonicalFieldKey(fact.fieldKey, params.family) === RATE_SCHEDULE_CONTROL_FIELD_KEY,
      ) ?? null;
    const rateSchedulePresentFact =
      params.facts.find(
        (fact) => canonicalFieldKey(fact.fieldKey, params.family) === 'rate_schedule_present',
      ) ?? null;
    const effectiveAnchor = rateSchedulePagesFact?.primaryAnchor ?? rateSchedulePresentFact?.primaryAnchor ?? null;
    const effectivePages =
      rateSchedulePagesFact && rateSchedulePagesFact.displayValue !== 'Missing'
        ? rateSchedulePagesFact.displayValue
        : null;

    return {
      facts: params.facts,
      rateScheduleSource: 'auto',
      rateSchedulePages: effectivePages,
      rateScheduleAnchor: effectiveAnchor,
      humanDefinedSchedule: false,
    };
  }

  const pagesDisplay = formatRateSchedulePagesValue(
    params.anchorRecord.startPage,
    params.anchorRecord.endPage,
  );
  const controlAnchor = buildHumanAnchor({
    factId: `${params.documentId}:rate_schedule_pages:control`,
    documentId: params.documentId,
    anchor: params.anchorRecord,
  });
  const workingFacts = [...params.facts];

  for (const fieldKey of RATE_SCHEDULE_FACT_FIELDS) {
    const nextFact = applyHumanRateScheduleToFact({
      fact: ensureRateScheduleFact(workingFacts, params.family, params.documentId, fieldKey),
      humanAnchor: controlAnchor,
      fieldKey,
      pagesDisplay,
    });
    const existingIndex = workingFacts.findIndex(
      (fact) => canonicalFieldKey(fact.fieldKey, params.family) === fieldKey,
    );
    if (existingIndex === -1) {
      workingFacts.push(nextFact);
    } else {
      workingFacts[existingIndex] = nextFact;
    }
  }

  return {
    facts: workingFacts,
    rateScheduleSource: 'human',
    rateSchedulePages: pagesDisplay,
    rateScheduleAnchor: {
      ...controlAnchor,
      factId: `${params.documentId}:rate_schedule_pages:control`,
    },
    humanDefinedSchedule: true,
  };
}

function confidenceLabel(confidence: number | null): 'high' | 'medium' | 'low' | 'none' {
  if (confidence == null || confidence <= 0) return 'none';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
}

function parserSourceFromEvidence(evidence: EvidenceObject): string {
  const metadata = asRecord(evidence.metadata);
  const sourceMethod = metadata?.source_method;
  if (typeof sourceMethod === 'string' && sourceMethod.trim().length > 0) {
    return sourceMethod;
  }
  const sourcePath = metadata?.source_extraction_path;
  return typeof sourcePath === 'string' && sourcePath.trim().length > 0
    ? sourcePath
    : evidence.kind;
}

function sourceLayerLabel(evidence: EvidenceObject): string {
  const parserSource = parserSourceFromEvidence(evidence);
  if (parserSource === 'ocr') return 'OCR';
  if (parserSource === 'pdf_text') return 'Native text';
  if (parserSource.includes('legacy_evidence_v1')) return 'Page text';
  if (evidence.kind === 'table' || evidence.kind === 'table_row') return 'Table parser';
  if (evidence.kind === 'form_field') return 'Form parser';
  if (evidence.kind.startsWith('sheet')) return 'Sheet parser';
  if (parserSource.includes('unstructured')) return 'Document region';
  if (parserSource.includes('pdf_content_layers')) return 'Native text';
  return titleize(parserSource.replace(/[:_.]/g, ' '));
}

function matchTypeLabel(evidence: EvidenceObject): string {
  switch (evidence.kind) {
    case 'table_row':
      return 'table row anchor';
    case 'table':
      return 'table region anchor';
    case 'form_field':
      return 'form field anchor';
    case 'sheet_row':
      return 'sheet row anchor';
    case 'sheet_cell':
      return 'sheet cell anchor';
    default:
      return 'text anchor';
  }
}

function snippetFromEvidence(evidence: EvidenceObject): string | null {
  if (typeof evidence.text === 'string' && evidence.text.trim().length > 0) {
    return evidence.text.trim();
  }
  if (evidence.value != null) return String(evidence.value);
  if (typeof evidence.location.nearby_text === 'string' && evidence.location.nearby_text.trim().length > 0) {
    return evidence.location.nearby_text.trim();
  }
  return null;
}

function buildBoundingBox(points: Array<[number, number]>): EvidenceGeometry['boundingBox'] {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function normalizeGeometry(raw: unknown): EvidenceGeometry | null {
  const coordinates = asRecord(raw);
  const pointsValue = asArray<number[]>(coordinates?.points);
  if (pointsValue.length === 0) return null;

  const points = pointsValue
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length === 0) return null;

  return {
    polygon: points,
    boundingBox: buildBoundingBox(points),
    layoutWidth:
      typeof coordinates?.layout_width === 'number'
        ? coordinates.layout_width
        : undefined,
    layoutHeight:
      typeof coordinates?.layout_height === 'number'
        ? coordinates.layout_height
        : undefined,
  };
}

function flattenFields(
  value: unknown,
  source: FlattenedField['source'],
  prefix = '',
  depth = 0,
): FlattenedField[] {
  if (depth > 2 || value == null) return [];

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix.length === 0) return [];
    return [{
      key: prefix,
      label: titleize(prefix.split('_').at(-1) ?? prefix),
      value,
      source,
    }];
  }

  if (Array.isArray(value)) {
    if (prefix.length === 0 || value.length === 0) return [];
    if (value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))) {
      return [{
        key: prefix,
        label: titleize(prefix.split('_').at(-1) ?? prefix),
        value: value as SupportedScalar[],
        source,
      }];
    }
    return [];
  }

  const record = asRecord(value);
  if (!record) return [];

  return Object.entries(record).flatMap(([key, child]) =>
    flattenFields(child, source, prefix ? `${prefix}_${key}` : key, depth + 1),
  );
}

function buildRawSourceMap(params: {
  typedFields: Record<string, unknown>;
  structuredFields: Record<string, unknown>;
  sectionSignals: Record<string, unknown>;
  traceFacts: Record<string, unknown>;
  extracted: Record<string, unknown>;
}): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const flattened = [
    ...flattenFields(params.typedFields, 'typed_fields'),
    ...flattenFields(params.structuredFields, 'structured_fields'),
    ...flattenFields(params.sectionSignals, 'section_signals'),
    ...flattenFields(params.traceFacts, 'trace_facts'),
    ...flattenFields(params.extracted, 'extracted'),
  ];

  for (const entry of flattened) {
    if (isInternalMetadataFieldKey(entry.key)) continue;
    map.set(entry.key, entry.value);
    map.set(toCamelCase(entry.key), entry.value);
    map.set(toSnakeCase(entry.key), entry.value);
  }

  return map;
}

function resolveRawValue(fieldKey: string, rawValueMap: Map<string, unknown>): string | null {
  const candidates = [fieldKey, toCamelCase(fieldKey), ...(RAW_VALUE_ALIASES[fieldKey] ?? [])];
  let fallbackValue: string | null = null;

  for (const candidate of candidates) {
    const rawValue = rawValueMap.get(candidate);
    const stringValue = scalarToString(rawValue);
    if (!stringValue) continue;
    if (typeof rawValue === 'string') return stringValue;
    if (fallbackValue == null) fallbackValue = stringValue;
  }

  return fallbackValue;
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(normalizeSearchText(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeSearchText(right).split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let hits = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) hits += 1;
  }
  return hits / Math.min(leftTokens.size, rightTokens.size);
}

function buildGeometryCandidates(extractionData: Record<string, unknown> | null): {
  byId: Map<string, EvidenceGeometry>;
  byPage: Map<number, GeometryCandidate[]>;
} {
  const extraction = asRecord(extractionData?.extraction);
  const parsedElements = asArray<Record<string, unknown>>(asRecord(extraction?.parsed_elements_v1)?.elements);
  const byId = new Map<string, EvidenceGeometry>();
  const byPage = new Map<number, GeometryCandidate[]>();

  for (const element of parsedElements) {
    const id = typeof element.id === 'string' ? element.id : null;
    if (!id) continue;

    const geometry = normalizeGeometry(element.coordinates);
    if (geometry) byId.set(id, geometry);

    const pageNumber = typeof element.page_number === 'number' ? element.page_number : null;
    if (pageNumber == null) continue;

    const pageEntries = byPage.get(pageNumber) ?? [];
    pageEntries.push({
      id,
      pageNumber,
      text: scalarToString(element.text) ?? scalarToString(element.text_preview) ?? '',
      geometry,
    });
    byPage.set(pageNumber, pageEntries);
  }

  return { byId, byPage };
}

type GeometryResolutionKind = NonNullable<DocumentEvidenceAnchor['geometryResolution']>;

function resolveGeometryForEvidence(
  evidence: EvidenceObject,
  geometryById: Map<string, EvidenceGeometry>,
  geometryByPage: Map<number, GeometryCandidate[]>,
): { geometry: EvidenceGeometry | null; resolution: GeometryResolutionKind } {
  const metadata = asRecord(evidence.metadata);
  const idCandidates: string[] = [];
  if (typeof metadata?.source_element_id === 'string') idCandidates.push(metadata.source_element_id);
  if (typeof evidence.id === 'string') idCandidates.push(evidence.id);
  const uniqueIds = [...new Set(idCandidates)];

  for (const id of uniqueIds) {
    const direct = geometryById.get(id);
    if (direct) {
      return {
        geometry: direct,
        resolution:
          typeof metadata?.source_element_id === 'string' && metadata.source_element_id === id
            ? 'source_element_id'
            : 'evidence_id',
      };
    }
  }

  const pageNumber = typeof evidence.location.page === 'number' ? evidence.location.page : null;
  if (pageNumber == null) return { geometry: null, resolution: 'none' };

  const candidates = geometryByPage.get(pageNumber) ?? [];
  if (candidates.length === 0) return { geometry: null, resolution: 'none' };

  const needle = snippetFromEvidence(evidence);
  const needleTrim = needle?.trim() ?? '';
  if (needleTrim.length < 2) return { geometry: null, resolution: 'none' };

  let bestScore = 0;
  let bestGeometry: EvidenceGeometry | null = null;
  for (const candidate of candidates) {
    if (!candidate.geometry || candidate.text.length === 0) continue;
    const score = tokenOverlapScore(needleTrim, candidate.text);
    if (score > bestScore) {
      bestScore = score;
      bestGeometry = candidate.geometry;
    }
  }

  const minScore = needleTrim.length < 8 ? 0.35 : 0.45;
  if (bestScore >= minScore && bestGeometry) {
    return { geometry: bestGeometry, resolution: 'text_overlap' };
  }
  return { geometry: null, resolution: 'none' };
}

function resolveSchemaGroup(family: DocumentFamily, fieldKey: string): {
  key: string;
  label: string;
  order: number;
} {
  if (SECONDARY_ADAPTER_FIELDS.has(canonicalFieldKey(fieldKey, family))) {
    return {
      key: 'additional_fields',
      label: 'Additional Extracted Fields',
      order: 99,
    };
  }

  const definitions = [
    ...(GROUP_DEFINITIONS[family] ?? []),
    ...GROUP_DEFINITIONS.generic,
    ...GROUP_DEFINITIONS.fallback,
  ];

  for (const definition of definitions) {
    if (definition.patterns.some((pattern) => pattern.test(fieldKey))) {
      return {
        key: definition.key,
        label: definition.label,
        order: definition.order,
      };
    }
  }

  return {
    key: 'additional_fields',
    label: 'Additional Extracted Fields',
    order: 99,
  };
}

function factSortRank(fact: DocumentFact, family: DocumentFamily): [number, number, number] {
  const priority = fieldPriorityRank(family, fact.fieldKey);
  let attention = 5;
  if (fact.reviewState === 'conflicted') attention = 0;
  else if (fact.reviewState === 'missing') attention = 1;
  else if (fact.evidenceCount === 0) attention = 2;
  else if (fact.confidenceLabel === 'low' || fact.confidenceLabel === 'none') attention = 3;
  else if (fact.confidenceLabel === 'medium') attention = 4;
  return [priority, attention, fact.primaryPage ?? Number.MAX_SAFE_INTEGER];
}

/** Stable ordering for ledger rows: document-type field priority, then attention signals, then page. */
export function compareDocumentFactsForLedger(
  left: DocumentFact,
  right: DocumentFact,
  family: DocumentFamily,
): number {
  const leftRank = factSortRank(left, family);
  const rightRank = factSortRank(right, family);
  if (leftRank[0] !== rightRank[0]) return leftRank[0] - rightRank[0];
  if (leftRank[1] !== rightRank[1]) return leftRank[1] - rightRank[1];
  if (leftRank[2] !== rightRank[2]) return leftRank[2] - rightRank[2];
  return left.fieldLabel.localeCompare(right.fieldLabel);
}

function buildDecisionMeta(
  family: DocumentFamily,
  decisions: NormalizedDecision[],
): Map<string, DecisionMeta> {
  const meta = new Map<string, DecisionMeta>();

  for (const decision of decisions) {
    if (!decision.field_key) continue;
    const fieldKey = canonicalFieldKey(decision.field_key, family);
    const current = meta.get(fieldKey) ?? {
      ids: [],
      titles: [],
      families: new Set<NormalizedDecision['family']>(),
      severity: new Set<NormalizedDecision['severity']>(),
      details: [],
    };
    current.ids.push(decision.id);
    current.titles.push(decision.title);
    current.families.add(decision.family);
    current.severity.add(decision.severity);
    if (decision.detail) current.details.push(decision.detail);
    meta.set(fieldKey, current);
  }

  return meta;
}

function isContractCeilingRatePriceNoOverallCap(fact: PipelineFact | null): boolean {
  return fact?.key === 'contract_ceiling'
    && isRatePriceNoCeilingMachineClassification(fact.machine_classification);
}

function factState(params: {
  fact: PipelineFact | null;
  decisionMeta: DecisionMeta | undefined;
  reviewedDecisionIds: Set<string>;
  anchors: DocumentEvidenceAnchor[];
  value: unknown;
}): DocumentFactState {
  const { fact, decisionMeta, reviewedDecisionIds, anchors, value } = params;
  if (isContractCeilingRatePriceNoOverallCap(fact)) {
    return anchors.length > 0 ? 'auto' : 'derived';
  }
  if (value == null || comparableValue(value).length === 0) return 'missing';
  const reviewed = decisionMeta?.ids.some((id) => reviewedDecisionIds.has(id)) ?? false;
  if (decisionMeta?.families.has('mismatch')) return reviewed ? 'overridden' : 'conflicted';
  if (reviewed) return 'reviewed';
  if (anchors.length === 0) return 'derived';
  if (fact == null) return 'auto';
  if (fact.missing_source_context.length > 0) return 'derived';
  return 'auto';
}

function factStatusLabel(state: DocumentFactState): string {
  switch (state) {
    case 'reviewed':
      return 'verified';
    case 'missing':
      return 'missing';
    case 'conflicted':
      return 'conflict';
    case 'derived':
      return 'needs review';
    case 'overridden':
      return 'overridden';
    default:
      return 'auto';
  }
}

function confidenceReason(params: {
  fact: PipelineFact | null;
  anchors: DocumentEvidenceAnchor[];
  decisionMeta: DecisionMeta | undefined;
}): string | null {
  const { fact, anchors, decisionMeta } = params;
  if (decisionMeta?.details.length) return decisionMeta.details[0] ?? null;
  if (fact?.missing_source_context.length) return fact.missing_source_context[0] ?? null;
  if (anchors.length === 0) return 'No direct evidence anchor was captured for this fact.';

  const pageOnly = anchors.filter(
    (anchor) => anchor.pageNumber != null && anchor.geometry == null,
  ).length;
  if (pageOnly === anchors.length) {
    return `${anchors.length} anchor(s) with page focus but no region geometry (missing element id or overlap threshold).`;
  }
  if (pageOnly > 0) {
    return `${anchors.length} anchor(s); ${pageOnly} without region geometry.`;
  }

  const layers = [...new Set(anchors.map((anchor) => anchor.sourceLayer))];
  return `${anchors.length} anchor${anchors.length === 1 ? '' : 's'} grounded in ${layers.join(', ')}.`;
}

function buildAnchorFromEvidence(params: {
  factId: string;
  evidence: EvidenceObject;
  extractionVersion: string | null;
  geometryById: Map<string, EvidenceGeometry>;
  geometryByPage: Map<number, GeometryCandidate[]>;
}): DocumentEvidenceAnchor {
  const { factId, evidence, extractionVersion, geometryById, geometryByPage } = params;
  const metadata = asRecord(evidence.metadata);
  const { geometry, resolution: geometryResolution } = resolveGeometryForEvidence(
    evidence,
    geometryById,
    geometryByPage,
  );
  const sourceRegionId =
    typeof metadata?.source_element_id === 'string'
      ? metadata.source_element_id
      : evidence.id;

  return {
    id: `${factId}:${evidence.id}`,
    factId,
    evidenceId: evidence.id,
    sourceDocumentId: evidence.source_document_id,
    anchorSource: 'machine',
    anchorType: evidence.kind === 'table' ? 'region' : 'text',
    pageNumber: typeof evidence.location.page === 'number' ? evidence.location.page : null,
    startPage: typeof evidence.location.page === 'number' ? evidence.location.page : null,
    endPage: typeof evidence.location.page === 'number' ? evidence.location.page : null,
    snippet: snippetFromEvidence(evidence),
    quoteText: typeof evidence.text === 'string' && evidence.text.trim().length > 0
      ? evidence.text.trim()
      : null,
    parserSource: parserSourceFromEvidence(evidence),
    sourceLayer: sourceLayerLabel(evidence),
    sourceRegionId,
    matchType: matchTypeLabel(evidence),
    extractionVersion,
    startOffset: null,
    endOffset: null,
    confidence: typeof evidence.confidence === 'number' ? evidence.confidence : null,
    weak: evidence.weak,
    geometry,
    geometryResolution,
  };
}

function dedupeAnchors(anchors: DocumentEvidenceAnchor[]): DocumentEvidenceAnchor[] {
  const seen = new Set<string>();
  return anchors
    .filter((anchor) => {
      if (seen.has(anchor.evidenceId)) return false;
      seen.add(anchor.evidenceId);
      return true;
    })
    .sort((left, right) => {
      const leftPage = left.pageNumber ?? Number.MAX_SAFE_INTEGER;
      const rightPage = right.pageNumber ?? Number.MAX_SAFE_INTEGER;
      if (leftPage !== rightPage) return leftPage - rightPage;
      return left.evidenceId.localeCompare(right.evidenceId);
    });
}

function buildAdditionalFacts(params: {
  existingKeys: Set<string>;
  typedFields: Record<string, unknown>;
  structuredFields: Record<string, unknown>;
  sectionSignals: Record<string, unknown>;
  traceFacts: Record<string, unknown>;
  extracted: Record<string, unknown>;
  evidence: EvidenceObject[];
  rawValueMap: Map<string, unknown>;
  family: DocumentFamily;
  extractionVersion: string | null;
  geometryById: Map<string, EvidenceGeometry>;
  geometryByPage: Map<number, GeometryCandidate[]>;
  decisionMeta: Map<string, DecisionMeta>;
  reviewedDecisionIds: Set<string>;
  documentId: string;
}): DocumentFact[] {
  const flattened = [
    ...contractRateScheduleKindFields(params),
    ...flattenFields(params.typedFields, 'typed_fields'),
    ...flattenFields(params.structuredFields, 'structured_fields'),
    ...flattenFields(params.sectionSignals, 'section_signals'),
    ...flattenFields(params.extracted, 'extracted'),
    ...flattenFields(params.traceFacts, 'trace_facts'),
  ];

  const unique = new Map<string, FlattenedField>();
  for (const entry of flattened) {
    if (!entry.key) continue;
    if (isInternalMetadataFieldKey(entry.key)) continue;
    const fieldKey = canonicalFieldKey(entry.key, params.family);
    if (isInternalMetadataFieldKey(fieldKey)) continue;
    if (params.existingKeys.has(fieldKey)) continue;
    const current = unique.get(fieldKey);
    if (
      current == null ||
      ADDITIONAL_FACT_SOURCE_PRIORITY[entry.source] < ADDITIONAL_FACT_SOURCE_PRIORITY[current.source]
    ) {
      unique.set(fieldKey, {
        ...entry,
        key: fieldKey,
      });
    }
  }

  return [...unique.values()].map((entry) => {
    const factId = `${params.documentId}:${entry.key}`;
    const fieldValue = entry.value;
    const valueType = inferValueType(entry.key, fieldValue);
    const fieldText = scalarToString(fieldValue);
    const prefersValueGrounding = Boolean(fieldText) && hasInspectableValue(fieldValue);
    let candidateEvidence = params.evidence
      .map((evidence) => {
        const snippet = snippetFromEvidence(evidence);
        if (!snippet) return null;
        const valueScore = fieldText ? tokenOverlapScore(fieldText, snippet) : 0;
        const labelScore = tokenOverlapScore(entry.label, snippet);
        const score = prefersValueGrounding
          ? valueScore
          : Math.max(tokenOverlapScore(`${entry.label} ${fieldText ?? ''}`, snippet), labelScore);
        return score > 0.42 ? { evidence, score } : null;
      })
      .filter((item): item is { evidence: EvidenceObject; score: number } => item != null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((item) => item.evidence);

    let adapterValueFallback = false;
    if (candidateEvidence.length === 0 && hasInspectableValue(fieldValue)) {
      const fallback = findEvidenceByValueMatch(params.evidence, fieldValue, { max: 3 });
      candidateEvidence = fallback;
      if (fallback.length > 0) adapterValueFallback = true;
    }

    const anchors = dedupeAnchors(candidateEvidence.map((evidence) =>
      buildAnchorFromEvidence({
        factId,
        evidence,
        extractionVersion: params.extractionVersion,
        geometryById: params.geometryById,
        geometryByPage: params.geometryByPage,
      }),
    ));
    const decision = params.decisionMeta.get(entry.key);
    const state = factState({
      fact: null,
      decisionMeta: decision,
      reviewedDecisionIds: params.reviewedDecisionIds,
      anchors,
      value: fieldValue,
    });
    const rawValue = resolveRawValue(entry.key, params.rawValueMap);
    const group = resolveSchemaGroup(params.family, entry.key);
    let normalizedDisplay = formatFactValue(fieldValue, valueType);
    const factCanon = canonicalFieldKey(entry.key, params.family);
    if (params.family === 'invoice' && (factCanon === 'contractor_name' || entry.key === 'vendor_name')) {
      const coerced = normalizeInvoiceContractorDisplay(
        typeof fieldValue === 'string'
          ? fieldValue
          : fieldValue != null
            ? scalarToString(fieldValue)
            : null,
      );
      if (coerced) normalizedDisplay = coerced;
    }
    const notes: string[] = [];
    if (rawValue && rawValue !== normalizedDisplay) notes.push(`Raw source: ${rawValue}`);
    if (entry.source === 'section_signals') notes.push('Derived from parser section signals.');
    if (adapterValueFallback) {
      notes.push('Evidence matched by field value (adapter value fallback).');
    }

    const missingCtx =
      anchors.length === 0
        ? [
            hasInspectableValue(fieldValue)
              ? 'No evidence anchor after adapter scoring and value fallback; field value could not be matched to any evidence span.'
              : 'No evidence anchor available for this field.',
          ]
        : [];

    return withDisplayMetadata({
      id: factId,
      documentId: params.documentId,
      fieldKey: entry.key,
      fieldLabel: entry.label,
      schemaGroup: group.key,
      schemaGroupLabel: group.label,
      valueType,
      valueText: typeof fieldValue === 'string' ? fieldValue : fieldText,
      valueNumber: typeof fieldValue === 'number' ? fieldValue : null,
      valueDate: valueType === 'date' ? formatFactValue(fieldValue, 'date') : null,
      valueBoolean: typeof fieldValue === 'boolean' ? fieldValue : null,
      normalizedValue: fieldValue,
      normalizedDisplay,
      rawValue,
      rawDisplay: rawValue,
      confidence: entry.source === 'structured_fields' ? 0.82 : entry.source === 'typed_fields' ? 0.74 : 0.68,
      confidenceLabel: confidenceLabel(entry.source === 'structured_fields' ? 0.82 : entry.source === 'typed_fields' ? 0.74 : 0.68),
      confidenceReason: confidenceReason({ fact: null, anchors, decisionMeta: decision }),
      reviewState: state,
      statusLabel: factStatusLabel(state),
      evidenceCount: anchors.length,
      primaryPage: anchors[0]?.pageNumber ?? null,
      anchors,
      normalizationNotes: notes,
      missingSourceContext: missingCtx,
      derivationKind: adapterValueFallback ? 'adapter_value_fallback' : entry.source,
      relatedDecisionIds: decision?.ids ?? [],
      relatedDecisionTitles: decision?.titles ?? [],
    });
  });
}

function contractRateScheduleKindFields(params: {
  extracted: Record<string, unknown>;
  family: DocumentFamily;
}): FlattenedField[] {
  if (params.family !== 'contract') return [];

  const assembly = asRecord(params.extracted.canonicalContractRateScheduleAssembly);
  const value = assembly?.schedule_kind;
  if (typeof value !== 'string' || value.trim().length === 0) return [];

  return [{
    key: RATE_SCHEDULE_KIND_FIELD_KEY,
    label: fieldLabelForKey(RATE_SCHEDULE_KIND_FIELD_KEY),
    value: value.trim(),
    source: 'extracted',
  }];
}

function buildSyntheticMissingFacts(params: {
  existingKeys: Set<string>;
  decisions: NormalizedDecision[];
  documentId: string;
  extractionVersion: string | null;
  geometryById: Map<string, EvidenceGeometry>;
  geometryByPage: Map<number, GeometryCandidate[]>;
  family: DocumentFamily;
}): DocumentFact[] {
  return params.decisions
    .filter((decision) => Boolean(decision.field_key))
    .filter((decision) => !params.existingKeys.has(canonicalFieldKey(decision.field_key!, params.family)))
    .filter((decision) => decision.family === 'missing' || decision.family === 'mismatch')
    .map((decision) => {
      const fieldKey = canonicalFieldKey(decision.field_key!, params.family);
      const group = resolveSchemaGroup(params.family, fieldKey);
      const factId = `${params.documentId}:${fieldKey}`;
      const anchors = dedupeAnchors(
        (decision.evidence_objects ?? []).map((evidence) =>
          buildAnchorFromEvidence({
            factId,
            evidence,
            extractionVersion: params.extractionVersion,
            geometryById: params.geometryById,
            geometryByPage: params.geometryByPage,
          }),
        ),
      );
      const state: DocumentFactState = decision.family === 'mismatch' ? 'conflicted' : 'missing';

      return withDisplayMetadata({
        id: factId,
        documentId: params.documentId,
        fieldKey,
        fieldLabel: fieldLabelForKey(fieldKey),
        schemaGroup: group.key,
        schemaGroupLabel: group.label,
        valueType: 'unknown',
        valueText: null,
        valueNumber: null,
        valueDate: null,
        valueBoolean: null,
        normalizedValue: null,
        normalizedDisplay: 'Missing',
        rawValue: null,
        rawDisplay: null,
        confidence: null,
        confidenceLabel: 'none',
        confidenceReason: decision.detail,
        reviewState: state,
        statusLabel: factStatusLabel(state),
        evidenceCount: anchors.length,
        primaryPage: anchors[0]?.pageNumber ?? null,
        anchors,
      normalizationNotes: decision.expected_value != null ? [`Expected value: ${String(decision.expected_value)}`] : [],
      missingSourceContext: decision.missing_source_context ?? ['No direct evidence was captured for this expected field.'],
        derivationKind: 'decision_signal',
        relatedDecisionIds: [decision.id],
        relatedDecisionTitles: [decision.title],
      });
    });
}

function buildOverrideOnlyFacts(params: {
  overridesByField: Map<string, DocumentFactOverrideRecord[]>;
  existingKeys: Set<string>;
  documentId: string;
  family: DocumentFamily;
}): DocumentFact[] {
  const facts: DocumentFact[] = [];

  for (const [fieldKey, overrides] of params.overridesByField.entries()) {
    if (params.existingKeys.has(fieldKey)) continue;
    const activeOverride = overrides.find((override) => override.isActive) ?? overrides[0] ?? null;
    if (!activeOverride) continue;

    const group = resolveSchemaGroup(params.family, fieldKey);
    const valueType = resolvedValueTypeForDisplay(fieldKey, 'unknown', activeOverride.valueJson);

    facts.push(
      withDisplayMetadata({
        id: `${params.documentId}:${fieldKey}:override`,
        documentId: params.documentId,
        fieldKey,
        fieldLabel: fieldLabelForKey(fieldKey),
        schemaGroup: group.key,
        schemaGroupLabel: group.label,
        valueType,
        valueText: null,
        valueNumber: null,
        valueDate: null,
        valueBoolean: null,
        normalizedValue: null,
        normalizedDisplay: 'Missing',
        rawValue: null,
        rawDisplay: null,
        confidence: null,
        confidenceLabel: 'none',
        confidenceReason: 'No machine-extracted value is available for this field.',
        reviewState: 'missing',
        statusLabel: factStatusLabel('missing'),
        evidenceCount: 0,
        primaryPage: null,
        anchors: [],
        normalizationNotes: [],
        missingSourceContext: [],
        derivationKind: 'human_override',
        relatedDecisionIds: [],
        relatedDecisionTitles: [],
      }),
    );
  }

  return facts;
}

/**
 * Schema-group keys whose Fact Ledger facts represent spreadsheet/transaction truth
 * (Dataset Summary, Grouped Review Tables, Flags/Outliers). These are the groups that
 * must read the row-backed canonical summary rather than the extraction blob. The
 * Document Identity / References / Extracted Signals / Additional Extracted Fields
 * groups are intentionally excluded so they keep their (correct) blob sourcing.
 */
const ROW_BACKED_SPREADSHEET_GROUP_KEYS = new Set<string>([
  'dataset_summary',
  'grouped_review_tables',
  'flags_outliers',
]);

const ROW_BACKED_CANONICAL_FACT_NOTE = 'Sourced from row-backed canonical transaction summary.';

function repointFactToCanonicalValue(
  fact: DocumentFact,
  fieldKey: string,
  value: unknown,
): DocumentFact {
  const valueType = inferValueType(fieldKey, value);
  const normalizedDisplay = formatFactValue(value, valueType);
  const normalizationNotes = fact.normalizationNotes.includes(ROW_BACKED_CANONICAL_FACT_NOTE)
    ? fact.normalizationNotes
    : [...fact.normalizationNotes, ROW_BACKED_CANONICAL_FACT_NOTE];
  return {
    ...fact,
    valueType,
    valueText: typeof value === 'string' ? value : scalarToString(value),
    valueNumber: typeof value === 'number' ? value : null,
    valueDate: valueType === 'date' ? formatFactValue(value, 'date') : null,
    valueBoolean: typeof value === 'boolean' ? value : null,
    normalizedValue: value,
    normalizedDisplay,
    reviewState: 'derived',
    statusLabel: factStatusLabel('derived'),
    derivationKind: 'row_backed_canonical_summary',
    normalizationNotes,
    displaySource: 'auto',
    displayValue: normalizedDisplay,
    machineValue: value,
    machineDisplay: normalizedDisplay,
  };
}

/**
 * Re-points the Fact Ledger's spreadsheet/transaction-truth facts at the same
 * row-backed canonical summary the review surface and Forge already consume, instead
 * of the (often empty) extraction blob. This is a read, not a recompute: it reuses
 * `buildCanonicalTransactionSummaryFromRows` rather than summing rows a second time.
 *
 * Existing auto facts in the transaction-truth groups are overwritten with the
 * canonical value; human-reviewed / overridden facts are left untouched. Expected
 * spreadsheet fields that the blob never produced (but the rows do) are appended so
 * the ledger no longer shows them as MISSING.
 */
function applyRowBackedSpreadsheetFacts(params: {
  facts: DocumentFact[];
  family: DocumentFamily;
  rowBackedSummary: Record<string, unknown> | null;
  documentId: string;
}): DocumentFact[] {
  const { facts, family, rowBackedSummary, documentId } = params;
  if (family !== 'spreadsheet' || rowBackedSummary == null) return facts;

  const canonicalValueForKey = (fieldKey: string): { key: string; value: unknown } | null => {
    const canon = canonicalFieldKey(fieldKey, family);
    if (Object.prototype.hasOwnProperty.call(rowBackedSummary, canon)) {
      return { key: canon, value: rowBackedSummary[canon] };
    }
    if (Object.prototype.hasOwnProperty.call(rowBackedSummary, fieldKey)) {
      return { key: fieldKey, value: rowBackedSummary[fieldKey] };
    }
    return null;
  };

  const seenCanonicalKeys = new Set<string>();
  const repointed = facts.map((fact) => {
    const canon = canonicalFieldKey(fact.fieldKey, family);
    seenCanonicalKeys.add(canon);
    if (!ROW_BACKED_SPREADSHEET_GROUP_KEYS.has(fact.schemaGroup)) return fact;
    // Preserve human review / override decisions; only re-point machine values.
    if (fact.displaySource !== 'auto') return fact;
    const resolved = canonicalValueForKey(fact.fieldKey);
    if (resolved == null || resolved.value == null) return fact;
    return repointFactToCanonicalValue(fact, resolved.key, resolved.value);
  });

  const additions: DocumentFact[] = [];
  for (const key of FIELD_PRIORITY.spreadsheet) {
    const canon = canonicalFieldKey(key, family);
    if (seenCanonicalKeys.has(canon)) continue;
    if (!Object.prototype.hasOwnProperty.call(rowBackedSummary, canon)) continue;
    const value = rowBackedSummary[canon];
    if (value == null) continue;
    const group = resolveSchemaGroup(family, canon);
    if (!ROW_BACKED_SPREADSHEET_GROUP_KEYS.has(group.key)) continue;
    seenCanonicalKeys.add(canon);
    const valueType = inferValueType(canon, value);
    const normalizedDisplay = formatFactValue(value, valueType);
    additions.push(
      withDisplayMetadata({
        id: `${documentId}:${canon}`,
        documentId,
        fieldKey: canon,
        fieldLabel: fieldLabelForKey(canon),
        schemaGroup: group.key,
        schemaGroupLabel: group.label,
        valueType,
        valueText: typeof value === 'string' ? value : scalarToString(value),
        valueNumber: typeof value === 'number' ? value : null,
        valueDate: valueType === 'date' ? formatFactValue(value, 'date') : null,
        valueBoolean: typeof value === 'boolean' ? value : null,
        normalizedValue: value,
        normalizedDisplay,
        rawValue: null,
        rawDisplay: null,
        confidence: 0.9,
        confidenceLabel: confidenceLabel(0.9),
        confidenceReason: ROW_BACKED_CANONICAL_FACT_NOTE,
        reviewState: 'derived',
        statusLabel: factStatusLabel('derived'),
        evidenceCount: 0,
        primaryPage: null,
        anchors: [],
        normalizationNotes: [ROW_BACKED_CANONICAL_FACT_NOTE],
        missingSourceContext: [],
        derivationKind: 'row_backed_canonical_summary',
        relatedDecisionIds: [],
        relatedDecisionTitles: [],
      }),
    );
  }

  return [...repointed, ...additions];
}

function buildStrip(params: {
  sourceModeLabel: string;
  parserStatus: string;
  schemaStatus: string;
  totalFacts: number;
  lowConfidenceFacts: number;
  missingEvidenceFacts: number;
  conflictingFacts: number;
  extractionVersion: string | null;
  extractionTimestamp: string | null;
}): DocumentIntelligenceStripItem[] {
  return [
    {
      key: 'source_mode',
      label: 'Source Mode',
      value: params.sourceModeLabel,
      tone: params.sourceModeLabel.includes('OCR') ? 'warning' : 'good',
    },
    {
      key: 'parser_status',
      label: 'Parser Status',
      value: params.parserStatus,
      tone: params.parserStatus === 'Ready' ? 'good' : params.parserStatus === 'Partial' ? 'warning' : 'neutral',
    },
    {
      key: 'schema_mapping',
      label: 'Schema Mapping',
      value: params.schemaStatus,
      tone: params.schemaStatus === 'Mapped' ? 'good' : params.schemaStatus === 'Partial' ? 'warning' : 'neutral',
    },
    {
      key: 'fact_count',
      label: 'Facts',
      value: String(params.totalFacts),
      tone: 'accent',
    },
    {
      key: 'low_confidence',
      label: 'Low Confidence',
      value: String(params.lowConfidenceFacts),
      tone: params.lowConfidenceFacts > 0 ? 'warning' : 'good',
    },
    {
      key: 'missing_evidence',
      label: 'Missing Evidence',
      value: String(params.missingEvidenceFacts),
      tone: params.missingEvidenceFacts > 0 ? 'warning' : 'good',
    },
    {
      key: 'conflicts',
      label: 'Conflicts',
      value: String(params.conflictingFacts),
      tone: params.conflictingFacts > 0 ? 'danger' : 'good',
      detail: params.extractionVersion
        ? `${params.extractionVersion}${params.extractionTimestamp ? ` • ${params.extractionTimestamp}` : ''}`
        : params.extractionTimestamp ?? undefined,
    },
  ];
}

function sourceModeLabel(extractionData: Record<string, unknown> | null): string {
  const extraction = asRecord(extractionData?.extraction);
  const pageText = asArray<Record<string, unknown>>(asRecord(extraction?.evidence_v1)?.page_text);
  const methods = new Set(
    pageText
      .map((page) => page.source_method)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
  );

  const sourceKind = asRecord(extraction?.content_layers_v1)?.source_kind;
  if (sourceKind === 'xlsx') return 'Workbook';
  if (methods.has('ocr') && (methods.has('pdf_text') || methods.has('text'))) return 'OCR + native text';
  if (methods.has('ocr')) return 'OCR';
  if (methods.has('pdf_text') || methods.has('text')) return 'Native text';

  const mode = extraction?.mode;
  return typeof mode === 'string' && mode.trim().length > 0 ? titleize(mode) : 'Unknown';
}

function parserStatus(params: {
  extractionData: Record<string, unknown> | null;
  extractionGaps: ExtractionGap[];
  facts: DocumentFact[];
}): string {
  const extraction = asRecord(params.extractionData?.extraction);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  if (contentLayers && params.facts.length > 0) {
    return params.extractionGaps.some((gap) => gap.severity === 'critical') ? 'Partial' : 'Ready';
  }
  if (contentLayers) return 'Parsing';
  if (asRecord(extraction?.evidence_v1)) return 'Fallback';
  return 'Waiting';
}

function schemaStatus(facts: DocumentFact[]): string {
  if (facts.length === 0) return 'Unmapped';
  if (
    facts.some(
      (fact) =>
        fact.displaySource === 'auto' &&
        (fact.reviewState === 'missing' || fact.evidenceCount === 0),
    )
  ) {
    return 'Partial';
  }
  return 'Mapped';
}

function buildOperationalTableAssemblyDiagnostic(params: {
  extracted: Record<string, unknown>;
  fieldKey: string;
  id: string;
  title: string;
  summary: string;
}): DiagnosticsDrawerModel | null {
  const result = asRecord(params.extracted[params.fieldKey]);
  if (!result) return null;

  const rows = asArray<Record<string, unknown>>(result.rows);
  const rejectedRows = asArray<Record<string, unknown>>(result.rejected_rows);
  const unclassifiedRows = asArray<Record<string, unknown>>(result.unclassified_rows);
  const assemblyWarnings = asArray<unknown>(result.assembly_warnings)
    .filter((warning): warning is string => typeof warning === 'string');
  const rowsMissingEvidence = rows.filter((row) => asArray<unknown>(row.evidence_refs).length === 0).length;
  const rowWarningCount = rows.reduce(
    (sum, row) => sum + asArray<unknown>(row.warnings).length,
    0,
  );

  return {
    id: params.id,
    title: params.title,
    summary: params.summary,
    textBlocks: [
      {
        id: 'summary',
        label: 'Shadow Assembly Summary',
        description: 'Parser remains authoritative',
        content: [
          `Rows reconstructed: ${rows.length}`,
          `Rejected rows: ${rejectedRows.length}`,
          `Unclassified rows: ${unclassifiedRows.length}`,
          `Warnings: ${assemblyWarnings.length + rowWarningCount}`,
          `Evidence refs: ${rowsMissingEvidence === 0 ? 'present' : `MISSING on ${rowsMissingEvidence} rows`}`,
          'Shadow mode: active — parser authoritative',
        ].join('\n'),
      },
    ],
    rowInspection: {
      label: 'Inspect rows',
      rows: rows.map((row) => ({
        row_id: typeof row.row_id === 'string' ? row.row_id : 'unknown',
        rate_code: typeof row.rate_code === 'string' ? row.rate_code : null,
        row_role: typeof row.row_role === 'string' ? row.row_role : 'unknown',
        confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence)
          ? row.confidence
          : null,
        warnings: asArray<unknown>(row.warnings)
          .filter((warning): warning is string => typeof warning === 'string'),
      })),
    },
  };
}

function buildOperationalRateDiffDiagnostic(
  extracted: Record<string, unknown>,
): DiagnosticsDrawerModel | null {
  const diff = asRecord(extracted.canonicalOperationalRateDiff);
  if (!diff) return null;
  const rows = asArray<Record<string, unknown>>(diff.rows);
  const summary = asRecord(diff.summary) ?? {};
  const count = (key: string) => typeof summary[key] === 'number' ? summary[key] as number : 0;

  return {
    id: 'canonical_operational_rate_diff',
    title: 'Cross Document Rate Diff',
    summary: 'Shadow-only invoice-to-contract operational rate comparison.',
    textBlocks: [
      {
        id: 'summary',
        label: 'Shadow Diff Summary',
        description: 'No validator or execution coupling',
        content: [
          `Matched rows: ${count('matched_rows')}`,
          `Ambiguous rows: ${count('ambiguous_rows')}`,
          `Unmatched rows: ${count('unmatched_rows')}`,
          `Low-confidence matches: ${count('low_confidence_matches')}`,
          `Rows exceeding contract ceiling: ${count('rows_exceeding_contract_ceiling')}`,
          `Passthrough rows: ${count('passthrough_rows')}`,
          `T&M rows: ${count('tm_rows')}`,
          'Shadow mode: active - no approval or payment gating',
        ].join('\n'),
      },
    ],
    rowInspection: {
      label: 'Inspect rate diff rows',
      rows: rows.map((row) => ({
        row_id: typeof row.invoice_row_id === 'string' ? row.invoice_row_id : 'unknown',
        rate_code: typeof row.contract_row_id === 'string' ? row.contract_row_id : null,
        row_role: typeof row.variance_status === 'string' ? row.variance_status : 'unknown',
        confidence: typeof row.match_confidence === 'number' && Number.isFinite(row.match_confidence)
          ? row.match_confidence
          : null,
        warnings: (() => {
          const candidateCount = asArray<Record<string, unknown>>(row.candidate_matches).length;
          return [
            ...asArray<unknown>(row.mismatch_reasons)
              .filter((reason): reason is string => typeof reason === 'string'),
            ...(candidateCount > 1 ? [`candidate matches: ${candidateCount}`] : []),
          ];
        })(),
      })),
    },
    json: {
      project_id: diff.project_id ?? null,
      invoice_document_id: diff.invoice_document_id ?? null,
      contract_document_id: diff.contract_document_id ?? null,
      generated_at: diff.generated_at ?? null,
      rows,
    },
  };
}

function buildSourceTextPages(extractionData: Record<string, unknown> | null): DocumentSourceTextPage[] {
  const extraction = asRecord(extractionData?.extraction);
  const evidencePageText = asArray<Record<string, unknown>>(asRecord(extraction?.evidence_v1)?.page_text);
  const contentLayerPages = asArray<Record<string, unknown>>(
    asRecord(asRecord(asRecord(extraction?.content_layers_v1)?.pdf)?.text)?.pages,
  );
  const sourcePages = evidencePageText.length > 0 ? evidencePageText : contentLayerPages;
  const pages = sourcePages
    .map((page, index) => {
      const text = scalarToString(page.text) ?? scalarToString(page.content) ?? '';
      const pageNumber = typeof page.page_number === 'number'
        ? page.page_number
        : typeof page.pageNumber === 'number'
          ? page.pageNumber
          : index + 1;
      return {
        pageNumber,
        sourceMethod: typeof page.source_method === 'string'
          ? page.source_method
          : typeof page.sourceMethod === 'string'
            ? page.sourceMethod
            : null,
        text,
      };
    })
    .filter((page) => page.text.trim().length > 0);

  const seen = new Set<number>();
  return pages
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .filter((page) => {
      if (seen.has(page.pageNumber)) return false;
      seen.add(page.pageNumber);
      return true;
    });
}

function buildDiagnostics(params: {
  extractionData: Record<string, unknown> | null;
  extractionHistory: Array<{ id: string; created_at: string; data: Record<string, unknown> }>;
  executionTrace: DocumentExecutionTrace | null;
  extracted: Record<string, unknown>;
  groups: DocumentFactGroup[];
  facts: DocumentFact[];
  auditNotes: AuditNote[];
  nodeTraces: PipelineTraceNode[];
}): DiagnosticsDrawerModel[] {
  const extraction = asRecord(params.extractionData?.extraction);
  const evidenceV1 = asRecord(extraction?.evidence_v1);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  const parsedElements = asRecord(extraction?.parsed_elements_v1);
  const pageText = asArray<Record<string, unknown>>(evidenceV1?.page_text);
  const invoiceAssemblyDiagnostic = buildOperationalTableAssemblyDiagnostic({
    extracted: params.extracted,
    fieldKey: 'canonicalOperationalTableRowAssembly',
    id: 'canonical_operational_table_row_assembly',
    title: 'Invoice Operational Row Assembly',
    summary: 'canonicalOperationalTableRowAssembler shadow output.',
  });
  const contractRateAssemblyDiagnostic = buildOperationalTableAssemblyDiagnostic({
    extracted: params.extracted,
    fieldKey: 'canonicalContractRateScheduleAssembly',
    id: 'canonical_contract_rate_schedule_assembly',
    title: 'Contract Rate Assembly',
    summary: 'contract rate schedule shadow output.',
  });
  const operationalRateDiffDiagnostic = buildOperationalRateDiffDiagnostic(params.extracted);

  // DEV ONLY: this project currently exposes diagnostics as a collapsed document-workspace surface,
  // but there is no production admin/debug permission gate around the diagnostics collection.
  // Keep assembler inspection sanitized here until a real production gate is added.
  return [
    invoiceAssemblyDiagnostic,
    contractRateAssemblyDiagnostic,
    operationalRateDiffDiagnostic,
    {
      id: 'schema_map',
      title: 'Schema Map',
      summary: 'Normalized fact and evidence adapter output.',
      json: {
        group_count: params.groups.length,
        fact_count: params.facts.length,
        groups: params.groups.map((group) => ({
          key: group.key,
          label: group.label,
          facts: group.facts.map((fact) => ({
            field_key: fact.fieldKey,
            field_label: fact.fieldLabel,
            display_source: fact.displaySource,
            display_value: fact.displayValue,
            normalized_value: fact.normalizedValue,
            machine_value: fact.machineValue,
            human_value: fact.humanValue,
            review_status: fact.reviewStatus,
            reviewed_by: fact.reviewedBy,
            reviewed_at: fact.reviewedAt,
            raw_value: fact.rawValue,
            confidence: fact.confidence,
            review_state: fact.reviewState,
            evidence_count: fact.evidenceCount,
            primary_page: fact.primaryPage,
          })),
        })),
      },
    },
    {
      id: 'page_text',
      title: 'OCR And Page Text',
      summary: `${pageText.length} page text layer${pageText.length === 1 ? '' : 's'} available.`,
      textBlocks: pageText.map((page, index) => ({
        id: `page-${index + 1}`,
        label: `Page ${typeof page.page_number === 'number' ? page.page_number : index + 1}`,
        description: typeof page.source_method === 'string' ? `Source: ${page.source_method}` : undefined,
        content: scalarToString(page.text) ?? '',
      })),
    },
    {
      id: 'parser_output',
      title: 'Parser Output',
      summary: 'Content layers and parsed document regions.',
      json: {
        content_layers_v1: contentLayers,
        parsed_elements_v1: parsedElements,
      },
    },
    {
      id: 'trace',
      title: 'Trace And Audit',
      summary: 'Pipeline trace, audit notes, and execution snapshot.',
      json: {
        execution_trace: params.executionTrace,
        audit_notes: params.auditNotes,
        node_traces: params.nodeTraces,
      },
    },
    {
      id: 'raw_extraction',
      title: 'Raw Extraction JSON',
      summary: 'Original blob payload persisted for this document.',
      json: params.extractionData,
    },
    {
      id: 'history',
      title: 'Extraction History',
      summary: `${params.extractionHistory.length} extraction snapshot${params.extractionHistory.length === 1 ? '' : 's'}.`,
      json: params.extractionHistory.map((row) => ({
        id: row.id,
        created_at: row.created_at,
      })),
    },
  ].filter((drawer): drawer is DiagnosticsDrawerModel => {
    if (drawer == null) return false;
    if (drawer.json && typeof drawer.json === 'object') {
      if (Array.isArray(drawer.json)) return drawer.json.length > 0;
      return Object.keys(drawer.json as Record<string, unknown>).length > 0;
    }
    return drawer.textBlocks ? drawer.textBlocks.some((block) => block.content.trim().length > 0) : true;
  });
}

function computeAnchorCoverage(facts: DocumentFact[]): DocumentIntelligenceViewModel['anchorCoverage'] {
  let factsWithAtLeastOneAnchor = 0;
  let factsWithValueButNoAnchor = 0;
  let pipelineFactsPrimaryResolution = 0;
  let pipelineFactsValueFallbackResolution = 0;
  let adapterFactsValueFallback = 0;
  let anchorsTotal = 0;
  let anchorsWithGeometry = 0;
  let anchorsPageOnly = 0;
  const seenAnchorIds = new Set<string>();

  for (const fact of facts) {
    if (fact.evidenceCount > 0) factsWithAtLeastOneAnchor += 1;
    if (
      fact.reviewState !== 'missing' &&
      fact.evidenceCount === 0 &&
      hasInspectableValue(fact.normalizedValue)
    ) {
      factsWithValueButNoAnchor += 1;
    }
    if (fact.pipelineEvidenceResolution === 'primary') pipelineFactsPrimaryResolution += 1;
    if (fact.pipelineEvidenceResolution === 'value_fallback') pipelineFactsValueFallbackResolution += 1;
    if (fact.derivationKind === 'adapter_value_fallback') adapterFactsValueFallback += 1;

    for (const anchor of fact.anchors) {
      if (seenAnchorIds.has(anchor.id)) continue;
      seenAnchorIds.add(anchor.id);
      anchorsTotal += 1;
      if (anchor.geometry != null) {
        anchorsWithGeometry += 1;
      } else if (anchor.pageNumber != null) {
        anchorsPageOnly += 1;
      }
    }
  }

  return {
    totalFacts: facts.length,
    factsWithAtLeastOneAnchor,
    factsWithValueButNoAnchor,
    pipelineFactsPrimaryResolution,
    pipelineFactsValueFallbackResolution,
    adapterFactsValueFallback,
    anchorsTotal,
    anchorsWithGeometry,
    anchorsPageOnly,
  };
}

function readLooseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** US short date like InvoiceSurface extraction (`Feb 22, 2026`). */
export function formatInvoicePeriodEndpointForDisplay(raw: unknown): string {
  if (raw == null) return '';
  const s = typeof raw === 'string' ? raw.trim() : String(raw);
  if (!s || s === 'Missing' || s === 'Unavailable') return '';
  const isoDateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateOnly) {
    const dt = new Date(
      Number.parseInt(isoDateOnly[1], 10),
      Number.parseInt(isoDateOnly[2], 10) - 1,
      Number.parseInt(isoDateOnly[3], 10),
    );
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  const isoTry = new Date(s);
  if (!Number.isNaN(isoTry.getTime())) {
    return isoTry.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slash) {
    const y = Number.parseInt(slash[3], 10);
    const fullYear = y < 100 ? 2000 + y : y;
    const dt = new Date(fullYear, Number.parseInt(slash[1], 10) - 1, Number.parseInt(slash[2], 10));
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  return s;
}

export function formatInvoiceServicePeriodRangeFromEndpoints(startRaw: unknown, endRaw: unknown): string {
  const left = formatInvoicePeriodEndpointForDisplay(startRaw);
  const right = formatInvoicePeriodEndpointForDisplay(endRaw);
  if (left && right) return `${left} → ${right}`;
  return left || right || '';
}

/** Max length for an embedded alphanumeric invoice rate token (e.g. 1A, 10AB). */
export const MAX_EMBEDDED_INVOICE_RATE_CODE_LEN = 12;

/** Reject ordinal-looking tokens misread as rate codes ("1st", "2024th"). */
const EMBEDDED_INVOICE_RATE_ORDINAL_RE = /^\d{1,6}(?:st|nd|rd|th)$/i;

/**
 * Validates a leading substring as an invoice-style rate token: digits then letters only,
 * at least one letter, bounded length — never a plain quantity ("43894", "43,894.00").
 */
export function isPlausibleEmbeddedInvoiceRateCode(candidate: string | null | undefined): boolean {
  if (candidate == null || typeof candidate !== 'string') return false;
  const code = candidate.trim();
  if (code.length === 0 || code.length > MAX_EMBEDDED_INVOICE_RATE_CODE_LEN) return false;
  if (!/^\d+[A-Za-z]+$/.test(code)) return false;
  if (EMBEDDED_INVOICE_RATE_ORDINAL_RE.test(code)) return false;
  return true;
}

/** Extract leading rate-table code from "1A Vegetative …", "1A- Vegetative …", "1A - …", "1A: …". */
export function splitEmbeddedInvoiceRateCode(description: string | null | undefined): {
  rateCode: string | null;
  remainder: string;
} {
  if (typeof description !== 'string') return { rateCode: null, remainder: '' };
  const trimmed = description.trim();
  if (!trimmed) return { rateCode: null, remainder: trimmed };

  const punct = trimmed.match(/^(\d+[A-Za-z]+)\s*[-–—\u2013\u2014:]\s*(.+)$/);
  if (
    punct
    && isPlausibleEmbeddedInvoiceRateCode(punct[1])
  ) {
    const remainder = punct[2].trim();
    return {
      rateCode: punct[1],
      remainder: remainder.length > 0 ? remainder : trimmed,
    };
  }

  const spaced = trimmed.match(/^(\d+[A-Za-z]+)\s+([A-Za-z].*)$/);
  if (
    spaced
    && isPlausibleEmbeddedInvoiceRateCode(spaced[1])
  ) {
    return { rateCode: spaced[1], remainder: spaced[2].trim() };
  }

  return { rateCode: null, remainder: trimmed };
}

function invoiceLedgerRegexEscape(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * First plausible invoice-style rate token anywhere in the line (digit + letters), left-to-right.
 * Excludes plain quantities (no letters) via isPlausibleEmbeddedInvoiceRateCode.
 */
function findFirstPlausibleEmbeddedInvoiceRateCodeToken(text: string): string | null {
  const re = /\b(\d{1,4}[A-Za-z]{1,12})\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const cand = match[1] ?? '';
    if (isPlausibleEmbeddedInvoiceRateCode(cand)) return cand;
  }
  return null;
}

function stripFirstEmbeddedInvoiceRateCodeFromText(text: string, code: string): string {
  const esc = invoiceLedgerRegexEscape(code);
  const leadHyphen = new RegExp(`^\\s*${esc}(?:\\s*[-–—\u2013\u2014:]\\s*)`, 'i');
  const leadSpace = new RegExp(`^\\s*${esc}\\s+`, 'i');
  if (leadHyphen.test(text)) return text.replace(leadHyphen, '').trim();
  if (leadSpace.test(text)) return text.replace(leadSpace, '').trim();
  const once = new RegExp(`\\b${esc}\\b`, 'i');
  return text.replace(once, ' ').replace(/\s{2,}/g, ' ').trim();
}

function embeddedRateSplitFromSingleField(trimmed: string): { rateCode: string; remainder: string } | null {
  const leading = splitEmbeddedInvoiceRateCode(trimmed);
  if (leading.rateCode) {
    return { rateCode: leading.rateCode, remainder: leading.remainder };
  }
  const token = findFirstPlausibleEmbeddedInvoiceRateCodeToken(trimmed);
  if (!token) return null;
  return {
    rateCode: token,
    remainder: stripFirstEmbeddedInvoiceRateCodeFromText(trimmed, token),
  };
}

/** When the richest description cell still echoes the extracted rate (`1A- …`), drop that prefix so Rate Code owns the token. */
function stripMatchedLeadingRatePrefixFromInvoiceDescription(
  resolvedRateTokenForDisplay: string | undefined | null,
  unifiedDescriptionColumn: string,
): string {
  const d = unifiedDescriptionColumn.trim();
  if (!d.length) return d;
  const r = resolvedRateTokenForDisplay?.trim();
  if (!r || !isPlausibleEmbeddedInvoiceRateCode(r)) return d;

  const parsed = splitEmbeddedInvoiceRateCode(unifiedDescriptionColumn);
  if (parsed.rateCode && parsed.rateCode.toLowerCase() === r.toLowerCase()) {
    const out = parsed.remainder.trim();
    /** Odd punctuation-only remainders shouldn't blank the user's cell. */
    return out.length > 0 ? out : d;
  }
  return d;
}

/** Fields that carry joined / OCR row text (not the human description column). */
const INVOICE_LEDGER_RAW_ROW_TEXT_KEYS = new Set<string>([
  'raw_text_for_display',
  'rawTextForDisplay',
  'full_row_text',
  'fullRowText',
  'raw_text',
  'rawText',
  'line_text',
  'lineText',
  'text',
]);

function invoiceLedgerFieldIsRawRowSource(key: string): boolean {
  return INVOICE_LEDGER_RAW_ROW_TEXT_KEYS.has(key);
}

/**
 * Parse embedded rate codes in **most-complete row text first** (full OCR/joined line), then fall back to
 * description columns. Per field: leading code, then mid-string token scan (`findFirstPlausible…`).
 */
function invoiceLedgerEmbeddedRateSplit(
  record: Record<string, unknown>,
  descFallback: string,
): { rateCode: string | null; remainder: string; matchedKey: string | null } {
  const keys = [
    'raw_text_for_display',
    'rawTextForDisplay',
    'full_row_text',
    'fullRowText',
    'raw_text',
    'rawText',
    'line_text',
    'lineText',
    'text',
    'line_description',
    'lineDescription',
    'description',
    'desc',
  ] as const;
  for (const key of keys) {
    const v = record[key];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const embedded = embeddedRateSplitFromSingleField(trimmed);
    if (embedded) return { ...embedded, matchedKey: key };
  }
  return { rateCode: null, remainder: descFallback, matchedKey: null };
}

/**
 * Prefer explicit structured invoice rate codes (`line_code`) when they look real (digits + letters, not qty leak).
 * Embeddings / OCR row scans are skipped for code when this returns a value.
 */
function pickStructuredPlausibleInvoiceLineCode(code: string | null | undefined, quantity: unknown): string | undefined {
  if (!code) return undefined;
  const t = code.trim();
  if (!t || !isPlausibleEmbeddedInvoiceRateCode(t)) return undefined;
  if (lineCodeLooksLikeQuantityLeak(t, quantity)) return undefined;
  return t;
}

function cloneFullPersistedInvoiceLineRecordForDebug(record: Record<string, unknown>): Record<string, unknown> {
  /** Shallow copy so logs show every persisted key without masking undefined vs missing. */
  return { ...record };
}

/**
 * Persisted rows often split work across `line_description` vs `description` / `desc` (one truncated, one full).
 * Pick the longest non-trivial candidate so vegetative lines don't lose "0 to 15" / "16 to 30" tails that still
 * live in a secondary column (Tree lines like 5A often work because only one column is populated).
 */
const UNIFIED_INVOICE_DESCRIPTION_STRUCTURED_KEYS = [
  'line_description',
  'lineDescription',
  'description',
  'desc',
] as const;

function isUsdScalarOrNumericOnlyStub(text: string): boolean {
  const t = text.trim();
  if (!t.length) return true;
  const noComma = t.replace(/,/g, '');
  /** "$6.90" or "534757.10" with no prose */
  if (/^\$[\d.]+$/.test(t.replace(/\s/g, ''))) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(noComma) && !/[A-Za-z]/.test(t)) return true;
  return false;
}

function pickUnifiedInvoiceStructuredDescription(record: Record<string, unknown>): string {
  const candidates: string[] = [];
  for (const key of UNIFIED_INVOICE_DESCRIPTION_STRUCTURED_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v.length) continue;
    if (isUsdScalarOrNumericOnlyStub(v)) continue;
    candidates.push(v);
  }
  if (!candidates.length) return '';
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? '';
}

function snapshotInvoiceLineRecordForDebug(record: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'lineCode',
    'line_code',
    'lineDescription',
    'line_description',
    'description',
    'desc',
    'raw_text_for_display',
    'rawTextForDisplay',
    'full_row_text',
    'fullRowText',
    'raw_text',
    'rawText',
    'line_text',
    'lineText',
    'text',
    'billing_rate_key',
    'billingRateKey',
    'quantity',
    'qty',
    'unitPrice',
    'unit_price',
    'lineTotal',
    'line_total',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (record[k] !== undefined) out[k] = record[k];
  }
  return out;
}

function isInvoiceLineDebugEnabled(): boolean {
  return typeof process !== 'undefined' && process.env.NEXT_PUBLIC_EIGHTFORGE_INVOICE_LINE_DEBUG === '1';
}

export function logInvoiceLineDebug(
  stage: string,
  params: {
    index?: number;
    record: Record<string, unknown>;
    row?: Partial<InvoiceLedgerLineDisplayRow>;
    extra?: Record<string, unknown>;
  },
): void {
  if (!isInvoiceLineDebugEnabled()) return;
  const r = params.record;
  console.info(`[EightForge invoice line ${stage}]`, {
    stage,
    index: params.index,
    line_code: r.line_code,
    lineCode: r.lineCode,
    description: r.description,
    desc: r.desc,
    line_description: r.line_description,
    lineDescription: r.lineDescription,
    raw_text: r.raw_text,
    rawText: r.rawText,
    raw_text_for_display: r.raw_text_for_display,
    rawTextForDisplay: r.rawTextForDisplay,
    full_row_text: r.full_row_text,
    fullRowText: r.fullRowText,
    text: r.text,
    line_text: r.line_text,
    lineText: r.lineText,
    quantity: r.quantity,
    qty: r.qty,
    unit_price: r.unit_price,
    unitPrice: r.unitPrice,
    line_total: r.line_total,
    lineTotal: r.lineTotal,
    billing_rate_key: r.billing_rate_key,
    billingRateKey: r.billingRateKey,
    resolvedRateCode: params.row?.rateCode,
    resolvedDescription: params.row?.description,
    resolvedUnitPrice: params.row?.unitPrice,
    ...(params.extra ?? {}),
  });
}

export type InvoiceLedgerLineDisplayRow = {
  rateCode: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

function invoiceLedgerPick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  return null;
}

function invoiceLedgerScalarText(value: unknown): string {
  if (value == null) return 'Unavailable';
  if (typeof value === 'string') return value.trim() || 'Unavailable';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return 'Unavailable';
}

function invoiceLedgerSanitizeLineText(value: string): string {
  if (value === '[object Object]') return 'Unavailable';
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return 'Unavailable';
  return value;
}

function invoiceLedgerFirstRawLineText(record: Record<string, unknown>): string | null {
  for (const key of ['raw_text', 'rawText', 'line_text', 'lineText', 'text'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function invoiceLedgerFormatQuantity(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
  }
  return invoiceLedgerScalarText(value);
}

function invoiceLedgerFormatMoney(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  }
  if (typeof value === 'string' && value.trim()) return value;
  return 'Unavailable';
}

/**
 * Operator-facing row for invoice Fact Ledger / Evidence workspace line tables.
 * Prefer embedded description rate codes; never show quantity as code; suppress competing billing_rate_key tokens.
 */
export function buildInvoiceLedgerLineDisplay(record: Record<string, unknown>): InvoiceLedgerLineDisplayRow {
  const columnDescTrim = pickUnifiedInvoiceStructuredDescription(record);
  const rawDescFallback = invoiceLedgerPick(record, ['lineDescription', 'line_description', 'description', 'desc']);
  const split = invoiceLedgerEmbeddedRateSplit(record, columnDescTrim);
  const lineCodeField = invoiceLedgerPick(record, ['lineCode', 'line_code', 'code', 'rate_code']);
  const lineCodeRawString =
    lineCodeField == null
      ? null
      : typeof lineCodeField === 'string'
        ? lineCodeField
        : typeof lineCodeField === 'number' && Number.isFinite(lineCodeField)
          ? String(lineCodeField)
          : null;
  const billingKeyRaw = invoiceLedgerPick(record, ['billing_rate_key', 'billingRateKey']);
  let codeRaw = invoiceLedgerScalarText(lineCodeField);
  let description =
    columnDescTrim.length > 0 ? columnDescTrim : invoiceLedgerScalarText(rawDescFallback);
  const qtyPick = invoiceLedgerPick(record, ['quantity', 'qty']);
  const quantity = invoiceLedgerFormatQuantity(qtyPick);
  const looksNumericCode = /^[\d,]+(?:\.\d+)?$/.test((codeRaw === 'Unavailable' ? '' : codeRaw).trim());
  const qtyMatchesCode =
    looksNumericCode
    && typeof qtyPick === 'number'
    && Number.isFinite(qtyPick)
    && Math.abs(Number.parseFloat(String(codeRaw).replace(/,/g, '')) - qtyPick) < 0.000_001;

  const structuredResolved = pickStructuredPlausibleInvoiceLineCode(lineCodeRawString, qtyPick);

  if (structuredResolved) {
    codeRaw = structuredResolved;
  } else if (split.rateCode) {
    codeRaw = split.rateCode;
    const rem = split.remainder.trim();
    const pref = columnDescTrim;
    const parsedFromRawRow =
      split.matchedKey != null && invoiceLedgerFieldIsRawRowSource(split.matchedKey);

    if (!pref.length && rem.length > 0) {
      /** No clean description column — use fuller row-derived text when OCR joined code + qty + money into one blob. */
      if (!parsedFromRawRow) {
        description = rem;
      } else {
        description = rem;
      }
    }
  } else {
    const bk = billingKeyRaw != null ? String(billingKeyRaw).trim() : '';
    const billingLooksLikeRateToken = /^\d+[A-Za-z]+$/.test(bk);
    if (
      (codeRaw === 'Unavailable' || qtyMatchesCode || looksNumericCode)
      && billingLooksLikeRateToken
    ) {
      codeRaw = bk;
    } else if (qtyMatchesCode || looksNumericCode) {
      codeRaw = 'Unavailable';
    }
  }

  if (columnDescTrim.length > 0) {
    /** Unified column wins — strip echoed rate prefix when Rate Code duplicates it. */
    const rateTokForStrip = codeRaw !== 'Unavailable' && codeRaw.trim() ? codeRaw.trim() : '';
    description = stripMatchedLeadingRatePrefixFromInvoiceDescription(rateTokForStrip, columnDescTrim);
  }

  description = invoiceLedgerSanitizeLineText(description);
  codeRaw = invoiceLedgerSanitizeLineText(codeRaw);

  const lineTotalPick = invoiceLedgerPick(record, ['lineTotal', 'line_total', 'total', 'amount']);
  const structuredUnitPick = invoiceLedgerPick(record, ['unitPrice', 'unit_price', 'price', 'unitRate', 'unit_rate']);
  const resolvedUnitPrice = resolveInvoiceLineUnitPrice({
    structuredUnitPrice: asLooseNumber(structuredUnitPick),
    quantity: asLooseNumber(qtyPick),
    lineTotal: asLooseNumber(lineTotalPick),
    rawText: invoiceLedgerFirstRawLineText(record),
  });

  const row: InvoiceLedgerLineDisplayRow = {
    rateCode: codeRaw,
    description,
    quantity,
    unitPrice: invoiceLedgerFormatMoney(resolvedUnitPrice),
    lineTotal: invoiceLedgerFormatMoney(lineTotalPick),
  };

  if (isInvoiceLineDebugEnabled()) {
    logInvoiceLineDebug('buildInvoiceLedgerLineDisplay', {
      record,
      row,
      extra: {
        recordIn: snapshotInvoiceLineRecordForDebug(record),
        lineTotalPick,
        resolvedUnitPrice,
        unitPriceDisplayed: row.unitPrice,
      },
    });
  }

  return row;
}

/** Same mapping as InvoiceSurface billed-line table inputs to `buildInvoiceLedgerLineDisplay` (single source for tests/UI). */
export function invoiceSurfaceLineItemToLedgerRecord(item: Record<string, unknown>): Record<string, unknown> {
  const r = item;
  return {
    lineCode: r.lineCode ?? r.line_code,
    lineDescription: r.lineDescription ?? r.line_description,
    line_description: r.line_description ?? r.lineDescription,
    /** Explicit secondary columns — `buildInvoiceLedgerLineDisplay` unions these via `pickUnifiedInvoiceStructuredDescription`. */
    description: r.description,
    desc: r.desc,
    quantity: r.quantity ?? r.qty,
    unit_price: r.unitPrice ?? r.unit_price,
    line_total: r.lineTotal ?? r.line_total,
    billing_rate_key: r.billingRateKey ?? r.billing_rate_key,
    raw_text: r.raw_text ?? r.rawText,
    raw_text_for_display: r.raw_text_for_display ?? r.rawTextForDisplay,
    full_row_text: r.full_row_text ?? r.fullRowText,
    line_text: r.line_text ?? r.lineText,
    text: r.text,
  };
}

function compactNumberishToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.replace(/,/g, '').replace(/\s+/g, '').trim() || null;
}

function lineCodeLooksLikeQuantityLeak(code: string | null | undefined, quantity: unknown): boolean {
  if (!code) return true;
  const codeToken = compactNumberishToken(code.replace(/,/g, ''));
  const qtyToken = compactNumberishToken(quantity);
  if (!codeToken || !qtyToken) return /^\d[\d,]*(?:\.\d+)?$/.test(code.trim());
  return codeToken === qtyToken;
}

/** Preserve raw row strings for downstream `invoiceLedgerEmbeddedRateSplit` (typed payloads often omit code in description only). */
function passthroughInvoiceLineTextField(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' ? v : undefined;
}

function passthroughInvoiceLineTextFields(record: Record<string, unknown>): Partial<Record<string, string>> {
  const keys = ['raw_text', 'rawText', 'line_text', 'lineText', 'text'] as const;
  const out: Partial<Record<string, string>> = {};
  for (const key of keys) {
    const s = passthroughInvoiceLineTextField(record, key);
    if (s !== undefined) (out as Record<string, string>)[key] = s;
  }
  return out;
}

function passthroughInvoiceLineFullRowDisplayFields(record: Record<string, unknown>): Partial<Record<string, string>> {
  const keys = ['raw_text_for_display', 'rawTextForDisplay', 'full_row_text', 'fullRowText'] as const;
  const out: Partial<Record<string, string>> = {};
  for (const key of keys) {
    const s = passthroughInvoiceLineTextField(record, key);
    if (s !== undefined) (out as Record<string, string>)[key] = s;
  }
  return out;
}

function normalizeInvoiceSurfaceLineItem(
  value: unknown,
  index?: number,
): NonNullable<InvoiceExtraction['lineItems']>[number] | null {
  const record = asRecord(value);
  if (!record) return null;

  logInvoiceLineDebug('normalizeInvoiceSurfaceLineItem input', {
    index,
    record: record as Record<string, unknown>,
    extra: {
      fullPersistedRow: cloneFullPersistedInvoiceLineRecordForDebug(record as Record<string, unknown>),
      unifiedDescriptionPick: pickUnifiedInvoiceStructuredDescription(record as Record<string, unknown>),
    },
  });

  const lineCode =
    readLooseString(record.line_code)
    ?? readLooseString(record.lineCode)
    ?? readLooseString(record.code)
    ?? readLooseString(record.rate_code);
  const quantity = asLooseNumber(record.quantity ?? record.qty);
  const unit = readLooseString(record.unit);
  const lineTotal = asLooseNumber(record.line_total ?? record.lineTotal ?? record.total ?? record.amount);
  const structuredUnitPrice = asLooseNumber(
    record.unit_price
    ?? record.unitPrice
    ?? record.price
    ?? record.unitRate
    ?? record.unit_rate,
  );
  const rawMerged =
    passthroughInvoiceLineTextField(record, 'raw_text')
    ?? passthroughInvoiceLineTextField(record, 'rawText')
    ?? passthroughInvoiceLineTextField(record, 'line_text')
    ?? passthroughInvoiceLineTextField(record, 'lineText')
    ?? passthroughInvoiceLineTextField(record, 'text');
  const unitPrice = resolveInvoiceLineUnitPrice({
    structuredUnitPrice,
    quantity,
    lineTotal,
    rawText: rawMerged,
  });
  const billingRateKey =
    readLooseString(record.billing_rate_key)
    ?? readLooseString(record.billingRateKey);
  const descriptionMatchKey =
    readLooseString(record.description_match_key)
    ?? readLooseString(record.descriptionMatchKey);

  const unifiedDescTrim = pickUnifiedInvoiceStructuredDescription(record as Record<string, unknown>);
  const embedded = invoiceLedgerEmbeddedRateSplit(record as Record<string, unknown>, unifiedDescTrim);
  const codeCapturedAsQty = lineCodeLooksLikeQuantityLeak(lineCode, quantity);
  const structuredResolved = pickStructuredPlausibleInvoiceLineCode(lineCode, quantity);

  let resolvedCode: string | undefined;
  let lineDescriptionOut = unifiedDescTrim;

  if (structuredResolved) {
    resolvedCode = structuredResolved;
  } else if (embedded.rateCode) {
    resolvedCode = embedded.rateCode;
    if (!unifiedDescTrim.length) {
      const rem = embedded.remainder.trim();
      /** No structured prose cells — OCR remainder is the best available narrative text. */
      if (rem.length > 0) lineDescriptionOut = rem;
    }
  } else if (codeCapturedAsQty) {
    resolvedCode = undefined;
  } else if (lineCode?.trim()) {
    const lc = lineCode.trim();
    if (!codeCapturedAsQty && isPlausibleEmbeddedInvoiceRateCode(lc)) resolvedCode = lc;
  }

  if (
    !lineDescriptionOut
    && !resolvedCode
    && quantity == null
    && unitPrice == null
    && lineTotal == null
  ) {
    return null;
  }

  let outboundBillingRateKey = billingRateKey ?? undefined;
  const suppressBillingAgainst = resolvedCode;
  if (suppressBillingAgainst && outboundBillingRateKey) {
    const bk = outboundBillingRateKey.trim();
    if (/^\d+[A-Za-z]+$/.test(bk)) {
      outboundBillingRateKey = undefined;
    } else if (bk.toLowerCase() === suppressBillingAgainst.toLowerCase()) {
      outboundBillingRateKey = undefined;
    }
  }

  const rateForStrip = resolvedCode && resolvedCode.trim() ? resolvedCode.trim() : '';
  lineDescriptionOut = stripMatchedLeadingRatePrefixFromInvoiceDescription(rateForStrip, lineDescriptionOut);

  const out: NonNullable<InvoiceExtraction['lineItems']>[number] = {
    lineCode: resolvedCode,
    lineDescription: lineDescriptionOut || undefined,
    quantity: quantity ?? undefined,
    unit: unit ?? undefined,
    unitPrice: unitPrice ?? undefined,
    lineTotal: lineTotal ?? undefined,
    billingRateKey: outboundBillingRateKey ?? undefined,
    descriptionMatchKey: descriptionMatchKey ?? undefined,
    ...passthroughInvoiceLineTextFields(record),
    ...passthroughInvoiceLineFullRowDisplayFields(record),
  };

  logInvoiceLineDebug('normalized invoice extraction lineItems', {
    index,
    record: out as Record<string, unknown>,
    row: {
      rateCode: out.lineCode ?? 'Unavailable',
      description: out.lineDescription ?? 'Unavailable',
      unitPrice: out.unitPrice != null ? invoiceLedgerFormatMoney(out.unitPrice) : undefined,
    },
    extra: {
      recordIn: snapshotInvoiceLineRecordForDebug(record as Record<string, unknown>),
      normalizedOut: { ...out },
    },
  });

  return out;
}

function effectiveInvoiceFactValue(
  facts: readonly DocumentFact[] | null | undefined,
  family: DocumentFamily,
  keys: readonly string[],
): unknown {
  if (!facts || facts.length === 0) return null;
  const wanted = new Set(keys.map((key) => canonicalFieldKey(key, family)));
  const fact = facts.find((candidate) =>
    wanted.has(canonicalFieldKey(candidate.fieldKey, family)),
  );
  if (!fact) return null;
  return fact.humanValue ?? fact.normalizedValue ?? fact.valueText ?? null;
}

function effectiveInvoiceFactString(
  facts: readonly DocumentFact[] | null | undefined,
  family: DocumentFamily,
  keys: readonly string[],
): string | null {
  const value = effectiveInvoiceFactValue(facts, family, keys);
  return readLooseString(value);
}

function effectiveInvoiceFactNumber(
  facts: readonly DocumentFact[] | null | undefined,
  family: DocumentFamily,
  keys: readonly string[],
): number | null {
  const value = effectiveInvoiceFactValue(facts, family, keys);
  return asLooseNumber(value);
}

function effectiveInvoiceFactArray(
  facts: readonly DocumentFact[] | null | undefined,
  family: DocumentFamily,
  keys: readonly string[],
): unknown[] | null {
  if (!facts || facts.length === 0) return null;
  const wanted = new Set(keys.map((key) => canonicalFieldKey(key, family)));
  const fact = facts.find((candidate) =>
    wanted.has(canonicalFieldKey(candidate.fieldKey, family)) &&
    (candidate.reviewState === 'reviewed' || candidate.reviewState === 'overridden'),
  );
  if (!fact) return null;
  const value = fact.humanValue ?? fact.normalizedValue;
  return Array.isArray(value) ? value : null;
}

function toInvoiceSurfaceExtraction(params: {
  typedFields: Record<string, unknown>;
  extracted: Record<string, unknown>;
  extractionData?: Record<string, unknown> | null;
  effectiveFacts?: readonly DocumentFact[];
  family?: DocumentFamily;
}): InvoiceExtraction | null {
  const source = {
    ...params.extracted,
    ...params.typedFields,
  };
  const family = params.family ?? 'invoice';

  const invoiceNumberRaw =
    effectiveInvoiceFactString(params.effectiveFacts, family, ['invoice_number'])
    ?? readLooseString(source.invoice_number_raw)
    ?? readLooseString(source.invoice_number)
    ?? readLooseString(source.invoiceNumber);
  const invoiceNumber =
    normalizeCanonicalInvoiceNumber(invoiceNumberRaw)
    ?? invoiceNumberRaw;
  const invoiceStatus =
    readLooseString(source.invoice_status)
    ?? readLooseString(source.invoiceStatus);
  const invoiceDate =
    readLooseString(source.invoice_date)
    ?? readLooseString(source.invoiceDate);
  const periodFrom =
    effectiveInvoiceFactString(params.effectiveFacts, family, ['period_start', 'service_period_start'])
    ?? readLooseString(source.service_period_start)
    ?? readLooseString(source.period_start)
    ?? readLooseString(source.periodFrom);
  const periodTo =
    effectiveInvoiceFactString(params.effectiveFacts, family, ['period_end', 'service_period_end'])
    ?? readLooseString(source.service_period_end)
    ?? readLooseString(source.period_end)
    ?? readLooseString(source.periodTo);
  const periodThrough =
    readLooseString(source.period_through)
    ?? readLooseString(source.periodThrough);
  const vendorNameRaw =
    effectiveInvoiceFactString(params.effectiveFacts, family, ['contractor_name', 'vendor_name'])
    ?? readLooseString(source.vendor_name)
    ?? readLooseString(source.contractorName);
  const vendorName = normalizeInvoiceContractorDisplay(vendorNameRaw) ?? vendorNameRaw ?? null;
  const clientName =
    effectiveInvoiceFactString(params.effectiveFacts, family, ['client_name', 'owner_name', 'bill_to_name'])
    ?? readLooseString(source.client_name)
    ?? readLooseString(source.clientName)
    ?? readLooseString(source.ownerName)
    ?? readLooseString(source.bill_to_name);
  const subtotalAmount =
    asLooseNumber(source.subtotal_amount)
    ?? asLooseNumber(source.subtotalAmount);
  const totalAmount =
    effectiveInvoiceFactNumber(params.effectiveFacts, family, ['billed_amount', 'total_amount', 'invoice_total'])
    ?? asLooseNumber(source.total_amount)
    ?? asLooseNumber(source.totalAmount)
    ?? asLooseNumber(source.billed_amount)
    ?? asLooseNumber(source.current_amount_due)
    ?? asLooseNumber(source.currentPaymentDue);
  const currentPaymentDue =
    asLooseNumber(source.current_amount_due)
    ?? asLooseNumber(source.currentPaymentDue)
    ?? totalAmount;

  const persistedLineItems =
    effectiveInvoiceFactArray(params.effectiveFacts, family, ['invoice_line_items', 'line_items'])
    ?? asArray<unknown>(source.line_items ?? source.lineItems);
  persistedLineItems.forEach((line, index) => {
    const record = asRecord(line);
    if (!record) return;
    logInvoiceLineDebug('document_extractions.data.fields.typed_fields.line_items', {
      index,
      record: record as Record<string, unknown>,
      extra: {
        fullPersistedRow: cloneFullPersistedInvoiceLineRecordForDebug(record as Record<string, unknown>),
      },
    });
  });

  const lineItemSource = recoverInvoiceLineItemsFromExtractionData({
    lineItems: persistedLineItems,
    extractionData: params.extractionData,
  });
  const lineItems = lineItemSource
    .map((line, index) => normalizeInvoiceSurfaceLineItem(line, index))
    .filter((line): line is NonNullable<InvoiceExtraction['lineItems']>[number] => line != null);
  const lineItemCount =
    asLooseNumber(source.line_item_count)
    ?? asLooseNumber(source.lineItemCount)
    ?? (lineItems.length > 0 ? lineItems.length : null);

  if (
    !invoiceNumber
    && !vendorName
    && !clientName
    && invoiceDate == null
    && totalAmount == null
    && lineItems.length === 0
  ) {
    return null;
  }

  return {
    invoiceNumber: invoiceNumber ?? undefined,
    invoice_number: invoiceNumber ?? null,
    invoice_number_raw: invoiceNumberRaw ?? null,
    invoice_number_normalized: invoiceNumber ?? null,
    contractorName: vendorName ?? undefined,
    vendor_name: vendorName ?? null,
    ownerName: clientName ?? undefined,
    clientName: clientName ?? undefined,
    client_name: clientName ?? null,
    invoiceStatus: invoiceStatus ?? undefined,
    invoice_status: invoiceStatus ?? null,
    invoiceDate: invoiceDate ?? undefined,
    invoice_date: invoiceDate ?? null,
    periodFrom: periodFrom ?? undefined,
    periodTo: periodTo ?? undefined,
    periodThrough: periodThrough ?? undefined,
    period_start: periodFrom ?? null,
    period_end: periodTo ?? null,
    period_through: periodThrough ?? null,
    service_period_start: periodFrom ?? null,
    service_period_end: (periodTo ?? periodThrough) ?? null,
    subtotalAmount: subtotalAmount ?? undefined,
    subtotal_amount: subtotalAmount ?? null,
    totalAmount: totalAmount ?? undefined,
    total_amount: totalAmount ?? null,
    currentPaymentDue: currentPaymentDue ?? undefined,
    current_amount_due: currentPaymentDue ?? null,
    lineItemCount: lineItemCount ?? undefined,
    line_item_count: lineItemCount ?? null,
    lineItems,
    line_items: lineItems.map((line) => {
      const l = line as Record<string, unknown>;
      return {
        line_code: line.lineCode ?? null,
        line_description: line.lineDescription ?? null,
        quantity: line.quantity ?? null,
        unit: line.unit ?? null,
        unit_price: line.unitPrice ?? null,
        line_total: line.lineTotal ?? null,
        billing_rate_key: line.billingRateKey ?? null,
        description_match_key: line.descriptionMatchKey ?? null,
        raw_text: passthroughInvoiceLineTextField(l, 'raw_text') ?? passthroughInvoiceLineTextField(l, 'rawText') ?? null,
        raw_text_for_display:
          passthroughInvoiceLineTextField(l, 'raw_text_for_display')
          ?? passthroughInvoiceLineTextField(l, 'rawTextForDisplay')
          ?? null,
        full_row_text:
          passthroughInvoiceLineTextField(l, 'full_row_text')
          ?? passthroughInvoiceLineTextField(l, 'fullRowText')
          ?? null,
        line_text: passthroughInvoiceLineTextField(l, 'line_text') ?? passthroughInvoiceLineTextField(l, 'lineText') ?? null,
        text: passthroughInvoiceLineTextField(l, 'text') ?? null,
      };
    }),
  };
}

function dedupePipelineAliasFacts<T extends { fieldKey: string }>(
  facts: readonly T[],
  family: DocumentFamily,
): T[] {
  const canonicalCounts = facts.reduce((map, fact) => {
    const key = canonicalFieldKey(fact.fieldKey, family);
    map.set(key, (map.get(key) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  return facts.filter((fact) => {
    const key = canonicalFieldKey(fact.fieldKey, family);
    return fact.fieldKey === key || (canonicalCounts.get(key) ?? 0) === 1;
  });
}

export function buildDocumentIntelligenceViewModel(params: BuildParams): DocumentIntelligenceViewModel {
  const extractionData = params.preferredExtraction?.data ?? null;
  const extraction = asRecord(extractionData?.extraction);
  const typedFields = asRecord(asRecord(extractionData?.fields)?.typed_fields) ?? {};
  const structuredFields = asRecord(asRecord(extraction?.evidence_v1)?.structured_fields) ?? {};
  const sectionSignals = asRecord(asRecord(extraction?.evidence_v1)?.section_signals) ?? {};
  const traceFacts = params.executionTrace?.facts ?? {};
  const traceExtracted = params.executionTrace?.extracted ?? {};
  const extractionVersion =
    params.executionTrace?.engine_version ??
    (typeof asRecord(extraction?.evidence_v1)?.parser_version === 'string'
      ? String(asRecord(extraction?.evidence_v1)?.parser_version)
      : null);

  const reviewedDecisionIds = new Set(params.reviewedDecisionIds ?? []);
  const extractedNode = extractNode({
    documentId: params.documentId,
    documentType: params.documentType,
    documentName: params.documentName,
    documentTitle: params.documentTitle,
    projectName: params.projectName,
    extractionData,
    relatedDocs: params.relatedDocs,
  });
  const normalizedNode = normalizeNode(extractedNode);
  const extracted = {
    ...normalizedNode.extracted,
    ...traceExtracted,
  };
  const primaryDocument = applyContractorIdentityResolutionToNormalizedDocument(normalizedNode.primaryDocument);
  const relatedDocuments = normalizedNode.relatedDocuments.map(applyContractorIdentityResolutionToNormalizedDocument);
  const normalizedNodeForFacts = {
    ...normalizedNode,
    primaryDocument,
    relatedDocuments,
  };
  const family = primaryDocument.family;
  // Row-backed canonical transaction summary — the same source the Spreadsheet Review
  // surface and Forge consume. The Fact Ledger's spreadsheet facts are re-pointed at
  // this (instead of the extraction blob) further below.
  const rowBackedCanonicalTransactionSummary =
    family === 'spreadsheet' && (params.transactionRows?.length ?? 0) > 0
      ? buildCanonicalTransactionSummaryFromRows(
          (params.transactionRows ?? []) as unknown as CanonicalProjectTransactionRowInput[],
        )
      : null;
  const rawValueMap = buildRawSourceMap({
    typedFields,
    structuredFields,
    sectionSignals,
    traceFacts,
    extracted,
  });
  const { byId: geometryById, byPage: geometryByPage } = buildGeometryCandidates(extractionData);
  const decisionMeta = buildDecisionMeta(family, params.normalizedDecisions);
  const reviewsByField = groupFactReviews(params.factReviews ?? [], family);
  const overridesByField = groupFactOverrides(params.factOverrides ?? [], family);
  const persistedAnchorsByField = groupFactAnchors(params.factAnchors ?? [], family);
  const humanRateScheduleAnchorRecord =
    (persistedAnchorsByField.get(RATE_SCHEDULE_CONTROL_FIELD_KEY) ?? []).find(
      isRateScheduleControlAnchorRecord,
    ) ?? null;
  const evidenceById = new Map(normalizedNodeForFacts.evidence.map((evidence) => [evidence.id, evidence] as const));

  const pipelineFacts = dedupePipelineAliasFacts(primaryDocument.facts.map((fact) => {
    const anchors = dedupeAnchors(
      fact.evidence_refs
        .map((ref) => evidenceById.get(ref) ?? null)
        .filter((evidence): evidence is EvidenceObject => evidence != null)
        .map((evidence) =>
          buildAnchorFromEvidence({
            factId: fact.id,
            evidence,
            extractionVersion,
            geometryById,
            geometryByPage,
          }),
        ),
    );
    const decision = decisionMeta.get(canonicalFieldKey(fact.key, family));
    const rawValue = resolveRawValue(fact.key, rawValueMap);
    const valueType = inferValueType(fact.key, fact.value);
    const ratePriceNoOverallCeiling = isContractCeilingRatePriceNoOverallCap(fact);
    let normalizedDisplay = formatFactValue(fact.value, valueType);
    if (ratePriceNoOverallCeiling) {
      normalizedDisplay = contractCeilingSummary('rate_based');
    } else if (family === 'invoice') {
      const canon = canonicalFieldKey(fact.key, family);
      if (canon === 'contractor_name' || fact.key === 'vendor_name') {
        const coerced = normalizeInvoiceContractorDisplay(
          typeof fact.value === 'string'
            ? fact.value
            : fact.value != null
              ? scalarToString(fact.value)
              : null,
        );
        if (coerced) normalizedDisplay = coerced;
      }
    }
    const notes: string[] = [];
    if (rawValue && rawValue !== normalizedDisplay) notes.push(`Raw source: ${rawValue}`);
    if (fact.missing_source_context.length > 0) notes.push(...fact.missing_source_context);
    if (ratePriceNoOverallCeiling) {
      notes.push(CONTRACT_CEILING_RATE_PRICE_LEDGER_NOTE);
    }
    const group = resolveSchemaGroup(family, fact.key);
    const state = factState({
      fact,
      decisionMeta: decision,
      reviewedDecisionIds,
      anchors,
      value: fact.value,
    });
    const statusLabel =
      ratePriceNoOverallCeiling ? 'rate based ceiling' : factStatusLabel(state);

    const baseFact = withDisplayMetadata({
      id: fact.id,
      documentId: params.documentId,
      fieldKey: fact.key,
      fieldLabel: fact.label,
      schemaGroup: group.key,
      schemaGroupLabel: group.label,
      valueType,
      valueText: typeof fact.value === 'string' ? fact.value : scalarToString(fact.value),
      valueNumber: typeof fact.value === 'number' ? fact.value : null,
      valueDate: valueType === 'date' ? formatFactValue(fact.value, 'date') : null,
      valueBoolean: typeof fact.value === 'boolean' ? fact.value : null,
      normalizedValue: fact.value,
      normalizedDisplay,
      rawValue,
      rawDisplay: rawValue,
      confidence: fact.confidence,
      confidenceLabel: confidenceLabel(fact.confidence),
      confidenceReason: confidenceReason({ fact, anchors, decisionMeta: decision }),
      reviewState: state,
      statusLabel,
      machineClassification: fact.machine_classification ?? null,
      evidenceCount: anchors.length,
      primaryPage: anchors[0]?.pageNumber ?? null,
      anchors,
      normalizationNotes: notes,
      missingSourceContext: fact.missing_source_context,
      derivationKind:
        anchors.length === 0
          ? 'derived'
          : fact.evidence_resolution === 'value_fallback'
            ? 'pipeline_value_fallback'
            : 'direct',
      pipelineEvidenceResolution: fact.evidence_resolution ?? 'none',
      relatedDecisionIds: decision?.ids ?? [],
      relatedDecisionTitles: decision?.titles ?? [],
    });

    const machineSource = fact.identity_resolution_source_value;
    if (typeof machineSource === 'string' && machineSource.trim().length > 0) {
      let machineDisplay = formatFactValue(machineSource, valueType);
      if (family === 'invoice') {
        const canon = canonicalFieldKey(fact.key, family);
        if (canon === 'contractor_name' || fact.key === 'vendor_name') {
          const display = normalizeInvoiceContractorDisplay(machineSource);
          if (display) machineDisplay = display;
        }
      }
      return {
        ...baseFact,
        machineValue: machineSource,
        machineDisplay,
      };
    }

    return baseFact;
  }), family);

  const existingKeys = new Set(pipelineFacts.map((fact) => canonicalFieldKey(fact.fieldKey, family)));
  const additionalFacts = buildAdditionalFacts({
    existingKeys,
    typedFields,
    structuredFields,
    sectionSignals,
    traceFacts,
    extracted,
    evidence: normalizedNodeForFacts.evidence,
    rawValueMap,
    family,
    extractionVersion,
    geometryById,
    geometryByPage,
    decisionMeta,
    reviewedDecisionIds,
    documentId: params.documentId,
  });

  const syntheticFacts = buildSyntheticMissingFacts({
    existingKeys: new Set([...existingKeys, ...additionalFacts.map((fact) => fact.fieldKey)]),
    decisions: params.normalizedDecisions,
    documentId: params.documentId,
    extractionVersion,
    geometryById,
    geometryByPage,
    family,
  });

  const overrideOnlyFacts = buildOverrideOnlyFacts({
    overridesByField,
    existingKeys: new Set([
      ...existingKeys,
      ...additionalFacts.map((fact) => canonicalFieldKey(fact.fieldKey, family)),
      ...syntheticFacts.map((fact) => canonicalFieldKey(fact.fieldKey, family)),
    ]),
    documentId: params.documentId,
    family,
  });

  const factsWithAnchors = [...pipelineFacts, ...additionalFacts, ...syntheticFacts, ...overrideOnlyFacts]
    .map((fact) =>
      applyFactReviews(
        fact,
        reviewsByField.get(canonicalFieldKey(fact.fieldKey, family)) ?? [],
      ),
    )
    .map((fact) =>
      applyFactOverrides(
        fact,
        overridesByField.get(canonicalFieldKey(fact.fieldKey, family)) ?? [],
      ),
    )
    .map((fact) =>
      applyPersistedFactAnchors(
        fact,
        persistedAnchorsByField.get(canonicalFieldKey(fact.fieldKey, family)) ?? [],
      ),
    );

  const rateScheduleOverlay = applyHumanRateScheduleDefinition({
    facts: factsWithAnchors,
    family,
    documentId: params.documentId,
    anchorRecord: humanRateScheduleAnchorRecord,
  });

  const facts = applyRowBackedSpreadsheetFacts({
    facts: filterDisplayFactsForFamily(rateScheduleOverlay.facts, family),
    family,
    rowBackedSummary: rowBackedCanonicalTransactionSummary,
    documentId: params.documentId,
  }).sort((left, right) => {
    const leftGroup = resolveSchemaGroup(family, left.fieldKey);
    const rightGroup = resolveSchemaGroup(family, right.fieldKey);
    if (leftGroup.order !== rightGroup.order) return leftGroup.order - rightGroup.order;
    const leftRank = factSortRank(left, family);
    const rightRank = factSortRank(right, family);
    if (leftRank[0] !== rightRank[0]) return leftRank[0] - rightRank[0];
    if (leftRank[1] !== rightRank[1]) return leftRank[1] - rightRank[1];
    if (leftRank[2] !== rightRank[2]) return leftRank[2] - rightRank[2];
      return left.fieldLabel.localeCompare(right.fieldLabel);
    });

  const groups = Array.from(
    facts.reduce((map, fact) => {
      const current = map.get(fact.schemaGroup) ?? {
        key: fact.schemaGroup,
        label: fact.schemaGroupLabel,
        order: resolveSchemaGroup(family, fact.fieldKey).order,
        facts: [],
        factCount: 0,
        missingCount: 0,
        conflictedCount: 0,
      };
      current.facts.push(fact);
      current.factCount += 1;
      if (fact.reviewState === 'missing') current.missingCount += 1;
      if (fact.reviewState === 'conflicted') current.conflictedCount += 1;
      map.set(fact.schemaGroup, current);
      return map;
    }, new Map<string, DocumentFactGroup>()),
  )
    .map(([, group]) => group)
    .sort((left, right) => left.order - right.order);

  const counts = {
    totalFacts: facts.length,
    lowConfidenceFacts: facts.filter((fact) => shouldCountLowConfidence(fact)).length,
    missingEvidenceFacts: facts.filter((fact) => shouldShowMissingEvidenceBadge(fact)).length,
    conflictingFacts: facts.filter((fact) => fact.reviewState === 'conflicted').length,
    missingFacts: facts.filter((fact) => fact.reviewState === 'missing').length,
  };

  const pageMarkerCounts: Record<number, number> = {};
  const seenMarkerAnchors = new Set<string>();
  for (const fact of facts) {
    for (const anchor of fact.anchors) {
      if (seenMarkerAnchors.has(anchor.id)) continue;
      seenMarkerAnchors.add(anchor.id);
      const startPage = anchor.startPage ?? anchor.pageNumber;
      const endPage = anchor.endPage ?? anchor.pageNumber;
      if (startPage == null || endPage == null) continue;
      for (let page = startPage; page <= endPage; page += 1) {
        pageMarkerCounts[page] = (pageMarkerCounts[page] ?? 0) + 1;
      }
    }
  }

  const sourceMode = sourceModeLabel(extractionData);
  const parser = parserStatus({
    extractionData,
    extractionGaps: params.extractionGaps,
    facts,
  });
  const schema = schemaStatus(facts);
  const sourceTextPages = buildSourceTextPages(extractionData);

  const anchorCoverage = computeAnchorCoverage(facts);

  const hasExtractedKeys = Object.keys(extracted).length > 0;
  const isTransactionDataType = (params.documentType ?? '').toLowerCase().includes('transaction_data');
  const invoiceExtraction: InvoiceExtraction | null =
    family === 'invoice'
      ? toInvoiceSurfaceExtraction({
          typedFields,
          extracted,
          extractionData,
          effectiveFacts: factsWithAnchors,
          family,
        })
      : null;
  const preferredTransactionDataExtraction: TransactionDataExtraction | null =
    family === 'spreadsheet' && isTransactionDataType
      ? asTransactionDataExtraction(normalizedNode.extracted)
      : null;
  const traceTransactionDataExtraction: TransactionDataExtraction | null =
    family === 'spreadsheet' && isTransactionDataType && hasExtractedKeys
      ? asTransactionDataExtraction(extracted)
      : null;
  const transactionDataExtraction: TransactionDataExtraction | null =
    preferredTransactionDataExtraction
    ?? traceTransactionDataExtraction;
  const contractRateRows =
    family === 'contract'
      ? toDocumentContractRateRows(params.executionTrace?.contract_analysis?.rate_schedule_rows)
      : [];
  const contractPricingAssemblyRows =
    family === 'contract'
      ? assembleContractPricingRows(params.executionTrace?.contract_analysis?.rate_schedule_rows, {
          canonicalRows: asArray(
            asRecord(extracted.canonicalContractRateScheduleAssembly)?.rows,
          ),
          typedRows: asArray(typedFields.rate_table),
        })
      : [];
  const spreadsheetReviewDataset = toSpreadsheetReviewDataset(transactionDataExtraction, {
    projectValidationSummary: params.projectValidationSummary ?? null,
    projectValidationStatus: params.projectValidationStatus ?? null,
    projectValidationFindings: params.projectValidationFindings,
    transactionDatasets: params.transactionDatasets ?? [],
    transactionRows: params.transactionRows ?? [],
  });

  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_EIGHTFORGE_ANCHOR_COVERAGE_LOG === '1') {
    console.info('[EightForge anchor coverage]', {
      documentId: params.documentId,
      ...anchorCoverage,
    });
  }

  return {
    family,
    facts,
    groups,
    factById: new Map(facts.map((fact) => [fact.id, fact] as const)),
    defaultFactId: facts[0]?.id ?? null,
    strip: buildStrip({
      sourceModeLabel: sourceMode,
      parserStatus: parser,
      schemaStatus: schema,
      totalFacts: counts.totalFacts,
      lowConfidenceFacts: counts.lowConfidenceFacts,
      missingEvidenceFacts: counts.missingEvidenceFacts,
      conflictingFacts: counts.conflictingFacts,
      extractionVersion,
      extractionTimestamp: params.preferredExtraction?.created_at ?? params.executionTrace?.generated_at ?? null,
    }),
    extractionVersion,
    extractionTimestamp: params.preferredExtraction?.created_at ?? params.executionTrace?.generated_at ?? null,
    parserStatus: parser,
    schemaMappingStatus: schema,
    sourceModeLabel: sourceMode,
    sourceTextPages,
    rateScheduleSource: rateScheduleOverlay.rateScheduleSource,
    rateSchedulePages: rateScheduleOverlay.rateSchedulePages,
    rateScheduleAnchor: rateScheduleOverlay.rateScheduleAnchor,
    humanDefinedSchedule: rateScheduleOverlay.humanDefinedSchedule,
    pageMarkerCounts,
    counts,
    anchorCoverage,
    diagnostics: buildDiagnostics({
      extractionData,
      extractionHistory: params.extractionHistory,
      executionTrace: params.executionTrace,
      extracted,
      groups,
      facts,
      auditNotes: params.auditNotes,
      nodeTraces: params.nodeTraces,
    }),
    invoiceExtraction,
    transactionDataExtraction,
    spreadsheetReviewDataset,
    contractRateRows,
    contractPricingAssemblyRows,
  };
}

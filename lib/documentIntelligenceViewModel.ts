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
import type { PipelineFact } from '@/lib/pipeline/types';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  AuditNote,
  DocumentExecutionTrace,
  DocumentFamily,
  NormalizedDecision,
  PipelineTraceNode,
} from '@/lib/types/documentIntelligence';

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
};

type SupportedScalar = string | number | boolean | null;

type FlattenedField = {
  key: string;
  label: string;
  value: SupportedScalar | SupportedScalar[];
  source: 'typed_fields' | 'structured_fields' | 'section_signals' | 'trace_facts' | 'extracted';
};

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
  reviewedDecisionIds?: Iterable<string>;
};

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
  | 'humanDefinedSchedule'
  | 'overrideHistory'
  | 'anchorCount'
  | 'primaryAnchor'
>;

const CONTRACT_CEILING_RATE_PRICE_LEDGER_NOTE =
  'Rate- or price-based agreement: no explicit overall contract ceiling cited. Supporting anchors reflect the rate schedule context.';

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
    rate_items_detected: 'rate_row_count',
  },
  invoice: {
    vendor_name: 'contractor_name',
    current_amount_due: 'billed_amount',
    current_payment_due: 'billed_amount',
    total_amount: 'billed_amount',
    amount_due: 'billed_amount',
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
  spreadsheet: {},
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
    'rate_schedule_pages',
    'rate_row_count',
    'time_and_materials_present',
  ],
  invoice: [
    'invoice_number',
    'contractor_name',
    'invoice_date',
    'billed_amount',
    'billing_period',
    'line_item_support_present',
    'line_item_count',
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
    'sheet_count',
    'sheet_names',
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
      key: 'vendor_payee',
      label: 'Vendor And Payee',
      order: 10,
      patterns: [/vendor/i, /payee/i, /contractor/i, /owner/i, /applicant/i],
    },
    {
      key: 'invoice_identifiers',
      label: 'Invoice Identifiers',
      order: 20,
      patterns: [/invoice/i, /reference/i, /report/i, /po_/i, /purchase_order/i, /contract_number/i],
    },
    {
      key: 'billing_period',
      label: 'Billing Period',
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
      key: 'document_identity',
      label: 'Document Identity',
      order: 10,
      patterns: [/sheet/i, /workbook/i, /document/i],
    },
    {
      key: 'structured_rows',
      label: 'Structured Rows',
      order: 20,
      patterns: [/row/i, /quantity/i, /rate/i, /invoice/i, /ticket/i],
    },
    {
      key: 'quality_signals',
      label: 'Quality Signals',
      order: 30,
      patterns: [/missing/i, /confidence/i, /error/i],
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

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
    return value.map((item) => scalarToString(item) ?? String(item)).join(', ');
  }
  return String(value);
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

function applyFactReviews(
  fact: DocumentFact,
  reviews: DocumentFactReviewRecord[],
): DocumentFact {
  if (reviews.length === 0) return fact;

  const latest = reviews[0];
  const note = latest.notes && latest.notes.trim().length > 0
    ? `Fact review: ${latest.notes.trim()}`
    : `Fact review status: ${reviewStatusLabel(latest.reviewStatus)}.`;
  const reviewedBase: DocumentFact = {
    ...fact,
    reviewStatus: latest.reviewStatus,
    reviewedBy: latest.reviewedBy,
    reviewedAt: latest.reviewedAt,
    reviewNotes: latest.notes,
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
    fieldLabel: titleize(fieldKey),
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
  return fact?.key === 'contract_ceiling' && fact.machine_classification === 'rate_price_no_ceiling';
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
    const normalizedDisplay = formatFactValue(fieldValue, valueType);
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
        fieldLabel: titleize(fieldKey),
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
        fieldLabel: titleize(fieldKey),
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

function buildDiagnostics(params: {
  extractionData: Record<string, unknown> | null;
  extractionHistory: Array<{ id: string; created_at: string; data: Record<string, unknown> }>;
  executionTrace: DocumentExecutionTrace | null;
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

  return [
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
        data: row.data,
      })),
    },
  ].filter((drawer) => {
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

export function buildDocumentIntelligenceViewModel(params: BuildParams): DocumentIntelligenceViewModel {
  const extractionData = params.preferredExtraction?.data ?? null;
  const extraction = asRecord(extractionData?.extraction);
  const typedFields = asRecord(asRecord(extractionData?.fields)?.typed_fields) ?? {};
  const structuredFields = asRecord(asRecord(extraction?.evidence_v1)?.structured_fields) ?? {};
  const sectionSignals = asRecord(asRecord(extraction?.evidence_v1)?.section_signals) ?? {};
  const traceFacts = params.executionTrace?.facts ?? {};
  const extracted = params.executionTrace?.extracted ?? {};
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
  const family = normalizedNode.primaryDocument.family;
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
  const evidenceById = new Map(normalizedNode.evidence.map((evidence) => [evidence.id, evidence] as const));

  const pipelineFacts = normalizedNode.primaryDocument.facts.map((fact) => {
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
      normalizedDisplay = 'No explicit ceiling';
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
      ratePriceNoOverallCeiling ? 'rate/price (no overall cap)' : factStatusLabel(state);

    return withDisplayMetadata({
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
  });

  const existingKeys = new Set(pipelineFacts.map((fact) => canonicalFieldKey(fact.fieldKey, family)));
  const additionalFacts = buildAdditionalFacts({
    existingKeys,
    typedFields,
    structuredFields,
    sectionSignals,
    traceFacts,
    extracted,
    evidence: normalizedNode.evidence,
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

  const facts = rateScheduleOverlay.facts.sort((left, right) => {
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

  const anchorCoverage = computeAnchorCoverage(facts);

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
      groups,
      facts,
      auditNotes: params.auditNotes,
      nodeTraces: params.nodeTraces,
    }),
  };
}

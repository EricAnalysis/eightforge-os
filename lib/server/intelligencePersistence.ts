import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildDocumentIntelligence,
  type BuildIntelligenceParams,
  type RelatedDocInput,
} from '@/lib/documentIntelligence';
import {
  pipelineResultToIntelligence,
  runDocumentPipeline,
} from '@/lib/pipeline/documentPipeline';
import { loadDocumentFactReviews } from '@/lib/validator/projectValidator';
import {
  loadContractUploadGuidanceForDocument,
  rateSchedulePageHintsFromGuidance,
} from '@/lib/contracts/contractUploadGuidance';
import {
  isContractInvoicePrimaryDocumentType,
  isContractInvoicePrimaryFamily,
} from '@/lib/contractInvoicePrimary';
import {
  pickPreferredExtractionBlob,
} from '@/lib/blobExtractionSelection';
import type {
  DocumentExecutionTrace,
  DocumentFamily,
  DocumentIntelligenceOutput,
} from '@/lib/types/documentIntelligence';
import { supportsCanonicalIntelligencePersistence } from '@/lib/canonicalIntelligenceFamilies';
import {
  INTELLIGENCE_PERSISTENCE_GENERATOR,
  INTELLIGENCE_PERSISTENCE_VERSION,
  materializePersistedExecutionTrace,
  mapIntelligenceToPersistenceRows,
  type IntelligenceDecisionInsert,
  type IntelligenceTaskInsert,
} from '@/lib/server/intelligenceAdapter';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import {
  persistTransactionDataForDocument,
  type PersistTransactionDataResult,
} from '@/lib/server/transactionDataPersistence';
import { persistCanonicalSupportForDocument } from '@/lib/server/supportTicketPersistence';
import { withStageTimeout } from '@/lib/server/stageTimeout';
import {
  buildCanonicalOperationalRateDiff,
} from '@/lib/operationalTables/canonicalOperationalRateDiff';
import type {
  CanonicalOperationalTableRow,
} from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';

const EXECUTION_TRACE_PERSIST_TIMEOUT_MS = 60_000;
const TRANSACTION_DATA_PERSIST_TIMEOUT_MS = 180_000;
const SUPPORT_PERSIST_TIMEOUT_MS = 60_000;

type DocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  project_id: string | null;
  projects: { name?: string | null } | Array<{ name?: string | null }> | null;
};

type ExistingDecisionRow = {
  id: string;
  decision_type: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
};

type ExistingTaskRow = {
  id: string;
  task_type: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
};

type ExistingGeneratedDecisionRow = ExistingDecisionRow & {
  source: string | null;
};

type ExistingGeneratedTaskRow = ExistingTaskRow & {
  source: string | null;
};

type PreferredBlobExtraction = {
  id: string;
  data: Record<string, unknown> | null;
};

type ResolvedBuildContext = {
  buildParams: BuildIntelligenceParams;
  extractionSnapshotId?: string;
};

export type PersistCanonicalIntelligenceResult = {
  handled: boolean;
  family: DocumentFamily | null;
  intelligence: DocumentIntelligenceOutput | null;
  execution_trace_persisted: boolean;
  transaction_data_persisted: boolean | null;
  canonical_persistence_error: string | null;
  decisions_created: number;
  decisions_updated: number;
  decisions_deleted: number;
  decisions_preserved: number;
  tasks_created: number;
  tasks_updated: number;
  tasks_deleted: number;
  tasks_preserved: number;
  legacy_decisions_suppressed: number;
  legacy_tasks_cancelled: number;
};

const HEAVY_SPREADSHEET_FACT_KEYS = new Set([
  'transaction_data_records',
  'grouped_by_rate_code',
  'grouped_by_invoice',
  'grouped_by_site_material',
  'grouped_by_service_item',
  'grouped_by_material',
  'grouped_by_site_type',
  'grouped_by_disposal_site',
  'outlier_rows',
]);

const HEAVY_SPREADSHEET_SUMMARY_KEYS = new Set([
  'grouped_by_rate_code',
  'grouped_by_invoice',
  'grouped_by_site_material',
  'grouped_by_service_item',
  'grouped_by_material',
  'grouped_by_site_type',
  'grouped_by_disposal_site',
  'outlier_rows',
]);

const HEAVY_SPREADSHEET_ROLLUP_KEYS = new Set([
  'groupedByRateCode',
  'groupedByInvoice',
  'groupedBySiteMaterial',
  'groupedByServiceItem',
  'groupedByMaterial',
  'groupedBySiteType',
  'groupedByDisposalSite',
  'outlierRows',
  'grouped_by_rate_code',
  'grouped_by_invoice',
  'grouped_by_site_material',
  'grouped_by_service_item',
  'grouped_by_material',
  'grouped_by_site_type',
  'grouped_by_disposal_site',
  'outlier_rows',
]);

const HEAVY_SPREADSHEET_EXTRACTED_KEYS = new Set([
  'records',
  'groupedByServiceItem',
  'groupedByMaterial',
  'groupedBySiteType',
  'groupedByDisposalSite',
  'outlierRows',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isTransactionDataExtracted(value: unknown): boolean {
  const extracted = asRecord(value);
  if (!extracted) return false;
  const sourceType = asString(extracted.sourceType) ?? asString(extracted.source_type);
  return sourceType === 'transaction_data';
}

function isInvoiceDocumentType(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'invoice';
}

function canonicalInspectionSnapshotsFromExtracted(
  extracted: unknown,
): Record<string, unknown> | null {
  const record = asRecord(extracted);
  if (!record) return null;
  const snapshots: Record<string, unknown> = {};
  if (record.canonicalContractRateScheduleAssembly != null) {
    snapshots.canonicalContractRateScheduleAssembly = record.canonicalContractRateScheduleAssembly;
  }
  if (record.canonicalOperationalTableRowAssembly != null) {
    snapshots.canonicalOperationalTableRowAssembly = record.canonicalOperationalTableRowAssembly;
  }
  if (record.canonicalOperationalRateDiff != null) {
    snapshots.canonicalOperationalRateDiff = record.canonicalOperationalRateDiff;
  }
  return Object.keys(snapshots).length > 0 ? snapshots : null;
}

function diagnosticsFromExtractionData(
  extractionData: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return asRecord(asRecord(extractionData?.extraction)?.diagnostics);
}

function canonicalAssemblyRowsFromExtractionData(
  extractionData: Record<string, unknown> | null | undefined,
  key: 'canonicalOperationalTableRowAssembly' | 'canonicalContractRateScheduleAssembly',
): CanonicalOperationalTableRow[] {
  const diagnostics = diagnosticsFromExtractionData(extractionData);
  const assembly = asRecord(diagnostics?.[key]);
  const rows = assembly?.rows;
  return Array.isArray(rows) ? rows as CanonicalOperationalTableRow[] : [];
}

async function loadLatestExtractionSnapshot(
  admin: SupabaseClient,
  documentId: string,
): Promise<{ id: string; data: Record<string, unknown> | null } | null> {
  const { data, error } = await admin
    .from('document_extractions')
    .select('id, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: typeof data.id === 'string' ? data.id : '',
    data: asRecord(data.data),
  };
}

async function persistExtractionDiagnostics(
  admin: SupabaseClient,
  params: {
    extractionSnapshotId: string;
    extractionData: Record<string, unknown> | null;
    diagnosticsPatch: Record<string, unknown>;
    logLabel: string;
  },
): Promise<void> {
  if (!params.extractionSnapshotId) return;

  const root = params.extractionData ?? {};
  const extraction = asRecord(root.extraction) ?? {};
  const diagnostics = asRecord(extraction.diagnostics) ?? {};
  const nextData = {
    ...root,
    extraction: {
      ...extraction,
      diagnostics: {
        ...diagnostics,
        ...params.diagnosticsPatch,
        inspection_snapshot_shape: 'canonical_shadow_assembly_v1',
      },
    },
  };

  const { error } = await admin
    .from('document_extractions')
    .update({ data: nextData })
    .eq('id', params.extractionSnapshotId);

  if (error) {
    console.error(`[generateAndPersistCanonicalIntelligence] failed to persist ${params.logLabel}`, {
      extractionSnapshotId: params.extractionSnapshotId,
      message: error.message,
    });
  }
}

async function persistExtractionInspectionSnapshots(
  admin: SupabaseClient,
  params: {
    documentId: string;
    extractionSnapshotId?: string;
    extractionData: Record<string, unknown> | null;
    extracted: unknown;
  },
): Promise<void> {
  const snapshots = canonicalInspectionSnapshotsFromExtracted(params.extracted);
  if (!snapshots) return;

  let extractionSnapshotId = params.extractionSnapshotId;
  let root = params.extractionData ?? {};
  if (!extractionSnapshotId) {
    const { data, error } = await admin
      .from('document_extractions')
      .select('id, data')
      .eq('document_id', params.documentId)
      .is('field_key', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return;
    extractionSnapshotId = typeof data.id === 'string' ? data.id : undefined;
    root = asRecord(data.data) ?? root;
  }
  if (!extractionSnapshotId) return;

  await persistExtractionDiagnostics(admin, {
    extractionSnapshotId,
    extractionData: root,
    diagnosticsPatch: snapshots,
    logLabel: 'inspection snapshots',
  });
}

async function persistOperationalRateDiffFromInspectionSnapshots(
  admin: SupabaseClient,
  params: {
    documentId: string;
    projectId?: string | null;
    relatedDocs: RelatedDocInput[];
    extracted: unknown;
  },
): Promise<{
  diff: ReturnType<typeof buildCanonicalOperationalRateDiff> | null;
  warnings: string[];
}> {
  const extractedRecord = asRecord(params.extracted);
  if (extractedRecord?.canonicalOperationalTableRowAssembly == null) {
    return { diff: null, warnings: [] };
  }

  const latestInvoiceSnapshot = await loadLatestExtractionSnapshot(admin, params.documentId);
  const invoiceRows = canonicalAssemblyRowsFromExtractionData(
    latestInvoiceSnapshot?.data,
    'canonicalOperationalTableRowAssembly',
  );
  const warnings: string[] = [];
  if (invoiceRows.length === 0) {
    warnings.push('canonicalOperationalRateDiff skipped: invoice assembly snapshot missing');
  }

  const contract = params.relatedDocs
    .filter((document) => (document.document_type ?? '').toLowerCase().includes('contract'))
    .map((document) => ({
      document,
      rows: canonicalAssemblyRowsFromExtractionData(
        document.extraction,
        'canonicalContractRateScheduleAssembly',
      ),
    }))
    .filter((entry) => entry.rows.length > 0)
    .sort((left, right) => {
      const leftGoverning = left.document.is_governing ? 0 : 1;
      const rightGoverning = right.document.is_governing ? 0 : 1;
      if (leftGoverning !== rightGoverning) return leftGoverning - rightGoverning;
      return left.document.id.localeCompare(right.document.id);
    })[0] ?? null;

  if (!contract) {
    warnings.push('canonicalOperationalRateDiff skipped: contract assembly snapshot missing');
  }

  if (!latestInvoiceSnapshot?.id) {
    return { diff: null, warnings };
  }

  if (warnings.length > 0 || !contract) {
    await persistExtractionDiagnostics(admin, {
      extractionSnapshotId: latestInvoiceSnapshot.id,
      extractionData: latestInvoiceSnapshot.data,
      diagnosticsPatch: {
        canonicalOperationalRateDiffWarnings: warnings,
      },
      logLabel: 'rate diff warnings',
    });
    return { diff: null, warnings };
  }

  const diff = buildCanonicalOperationalRateDiff({
    project_id: params.projectId ?? null,
    invoice_document_id: params.documentId,
    contract_document_id: contract.document.id,
    invoice_rows: invoiceRows,
    contract_rows: contract.rows,
  });

  await persistExtractionDiagnostics(admin, {
    extractionSnapshotId: latestInvoiceSnapshot.id,
    extractionData: latestInvoiceSnapshot.data,
    diagnosticsPatch: {
      canonicalOperationalRateDiff: diff,
      canonicalOperationalRateDiffWarnings: [],
    },
    logLabel: 'rate diff snapshot',
  });

  return { diff, warnings: [] };
}

function hasSupportTicketRowsInExtractionData(
  value: Record<string, unknown> | null | undefined,
): boolean {
  const extraction = asRecord(value?.extraction);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  const spreadsheet = asRecord(contentLayers?.spreadsheet);
  const normalizedTicketExport = asRecord(spreadsheet?.normalized_ticket_export);
  return Array.isArray(normalizedTicketExport?.rows) && normalizedTicketExport.rows.length > 0;
}

function isTicketLikeExtractedPayload(value: unknown): boolean {
  const extracted = asRecord(value);
  if (!extracted) return false;

  return (
    asString(extracted.ticketId) != null ||
    asString(extracted.ticket_id) != null ||
    typeof extracted.quantityCY === 'number' ||
    typeof extracted.quantity_cy === 'number' ||
    asString(extracted.disposalSite) != null ||
    asString(extracted.disposal_site) != null ||
    asString(extracted.material) != null ||
    asString(extracted.contractor) != null
  );
}

function shouldPersistCanonicalSupport(params: {
  extractionData: Record<string, unknown> | null | undefined;
  extracted: unknown;
}): boolean {
  return (
    hasSupportTicketRowsInExtractionData(params.extractionData) ||
    isTicketLikeExtractedPayload(params.extracted)
  );
}

function omitRecordKeys(
  value: Record<string, unknown> | null | undefined,
  keys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!value) return undefined;

  const next = { ...value };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function jsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function isSpreadsheetTransactionDataExecutionTrace(trace: DocumentExecutionTrace): boolean {
  return trace.classification?.family === 'spreadsheet' && isTransactionDataExtracted(trace.extracted);
}

function compactSpreadsheetTransactionDataTrace(
  executionTrace: DocumentExecutionTrace,
): DocumentExecutionTrace {
  const compactedFacts = omitRecordKeys(executionTrace.facts, HEAVY_SPREADSHEET_FACT_KEYS)
    ?? executionTrace.facts;
  const extracted = asRecord(executionTrace.extracted);

  if (!extracted) {
    return {
      ...executionTrace,
      facts: compactedFacts,
      evidence: (executionTrace.evidence ?? []).filter((entry) => entry.kind === 'sheet'),
    };
  }

  const compactedExtracted = omitRecordKeys(extracted, HEAVY_SPREADSHEET_EXTRACTED_KEYS) ?? { ...extracted };
  const compactedSummary = omitRecordKeys(
    asRecord(extracted.summary),
    HEAVY_SPREADSHEET_SUMMARY_KEYS,
  );
  const compactedRollups = omitRecordKeys(
    asRecord(extracted.rollups),
    HEAVY_SPREADSHEET_ROLLUP_KEYS,
  );

  if (compactedSummary) {
    compactedExtracted.summary = compactedSummary;
  }
  if (compactedRollups) {
    compactedExtracted.rollups = compactedRollups;
  }

  return {
    ...executionTrace,
    facts: compactedFacts,
    extracted: compactedExtracted,
    evidence: (executionTrace.evidence ?? []).filter((entry) => entry.kind === 'sheet'),
  };
}

function prepareExecutionTraceForPersistence(
  executionTrace: DocumentExecutionTrace,
): {
  executionTrace: DocumentExecutionTrace;
  compacted: boolean;
  beforeBytes: number | null;
  afterBytes: number | null;
} {
  if (!isSpreadsheetTransactionDataExecutionTrace(executionTrace)) {
    const bytes = jsonByteLength(executionTrace);
    return {
      executionTrace,
      compacted: false,
      beforeBytes: bytes,
      afterBytes: bytes,
    };
  }

  const compactedTrace = compactSpreadsheetTransactionDataTrace(executionTrace);
  return {
    executionTrace: compactedTrace,
    compacted: true,
    beforeBytes: jsonByteLength(executionTrace),
    afterBytes: jsonByteLength(compactedTrace),
  };
}

function formatSupportPersistenceError(
  documentId: string,
  result: {
    reason?: 'missing_admin' | 'missing_project_id' | 'no_support_rows' | 'missing_table' | 'schema_mismatch';
  },
): string {
  return `Support persistence failed for ${documentId}: ${result.reason ?? 'unknown'}.`;
}

function shouldReportSupportPersistenceFailure(result: {
  persisted: boolean;
  reason?: 'missing_admin' | 'missing_project_id' | 'no_support_rows' | 'missing_table' | 'schema_mismatch';
}): boolean {
  return result.persisted !== true && result.reason !== 'no_support_rows';
}

function formatTransactionDataPersistenceError(
  documentId: string,
  result: PersistTransactionDataResult,
): string {
  if (result.reason) {
    return `Transaction data persistence failed for ${documentId}: ${result.reason}.`;
  }
  return `Transaction data persistence failed for ${documentId}.`;
}

function resolveProjectName(
  raw: DocumentRow['projects'],
): string | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0]?.name ?? null;
  return raw.name ?? null;
}

function isOperatorManagedDecision(row: ExistingDecisionRow): boolean {
  return row.status !== 'open' ||
    row.assigned_to != null ||
    row.assigned_at != null ||
    row.due_at != null;
}

function isOperatorManagedTask(row: ExistingTaskRow): boolean {
  return row.status !== 'open' ||
    row.assigned_to != null ||
    row.assigned_at != null ||
    row.due_at != null;
}

function hasV2DetailsMarker(details: Record<string, unknown> | null | undefined): boolean {
  return details?.intelligence_version === INTELLIGENCE_PERSISTENCE_VERSION &&
    details?.generated_by === INTELLIGENCE_PERSISTENCE_GENERATOR;
}

function hasSupersededMarker(details: Record<string, unknown> | null | undefined): boolean {
  return typeof details?.superseded_at === 'string' && details.superseded_at.length > 0;
}

function getIdentityKey(details: Record<string, unknown> | null | undefined): string | null {
  const identityKey = details?.identity_key;
  return typeof identityKey === 'string' && identityKey.length > 0 ? identityKey : null;
}

function isReusableDecisionRow(row: ExistingDecisionRow): boolean {
  return !hasSupersededMarker(row.details) && ['open', 'in_review'].includes(row.status);
}

function isReusableTaskRow(row: ExistingTaskRow): boolean {
  return !hasSupersededMarker(row.details) && ['open', 'in_progress', 'blocked'].includes(row.status);
}

function withSupersededDetails(
  details: Record<string, unknown> | null | undefined,
  supersededAt: string,
): Record<string, unknown> {
  return {
    ...(details ?? {}),
    superseded_by_generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    superseded_by_intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
    superseded_at: supersededAt,
  };
}

async function loadDocumentRow(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<DocumentRow | null> {
  const { data, error } = await admin
    .from('documents')
    .select('id, title, name, document_type, project_id, projects(name)')
    .eq('id', documentId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as DocumentRow;
}

async function loadPreferredBlobExtraction(
  admin: SupabaseClient,
  documentId: string,
): Promise<PreferredBlobExtraction | null> {
  const { data, error } = await admin
    .from('document_extractions')
    .select('id, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) return null;
  const preferred = pickPreferredExtractionBlob(
    data as Array<{ id: string; data?: Record<string, unknown> | null }>,
  );
  if (!preferred) return null;
  return {
    id: preferred.id as string,
    data: preferred.data ?? null,
  };
}

async function loadRelatedDocs(
  admin: SupabaseClient,
  document: DocumentRow,
  organizationId: string,
): Promise<RelatedDocInput[]> {
  if (!document.project_id) return [];
  return loadPrecedenceAwareRelatedDocs(admin, {
    organizationId,
    projectId: document.project_id,
    currentDocumentId: document.id,
  });
}

async function loadBuildParams(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    extractionData?: Record<string, unknown> | null;
  },
): Promise<ResolvedBuildContext | null> {
  const document = await loadDocumentRow(admin, params.documentId, params.organizationId);
  if (!document) return null;

  const extractionRecord = (() => {
    if (params.extractionData !== undefined) {
      return Promise.resolve<PreferredBlobExtraction | null>({
        id: '',
        data: params.extractionData ?? null,
      });
    }
    return loadPreferredBlobExtraction(admin, params.documentId);
  })();

  const relatedDocs = await loadRelatedDocs(admin, document, params.organizationId);

  const resolvedExtractionRecord = await extractionRecord;

  return {
    buildParams: {
      documentType: document.document_type,
      documentTitle: document.title,
      documentName: document.name,
      projectName: resolveProjectName(document.projects),
      extractionData: resolvedExtractionRecord?.data ?? null,
      relatedDocs,
    },
    extractionSnapshotId: resolvedExtractionRecord?.id || undefined,
  };
}

async function persistDocumentExecutionTrace(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    executionTrace: DocumentExecutionTrace;
  },
): Promise<{ persisted: boolean; error: string | null }> {
  const preparedTrace = prepareExecutionTraceForPersistence(params.executionTrace);

  if (preparedTrace.compacted) {
    console.log('[generateAndPersistCanonicalIntelligence] spreadsheet execution trace payload size before reduction', {
      documentId: params.documentId,
      organizationId: params.organizationId,
      payloadBytes: preparedTrace.beforeBytes,
    });
    console.log('[generateAndPersistCanonicalIntelligence] spreadsheet execution trace payload size after reduction', {
      documentId: params.documentId,
      organizationId: params.organizationId,
      payloadBytes: preparedTrace.afterBytes,
    });
  }

  console.log('[generateAndPersistCanonicalIntelligence] execution trace persistence start', {
    documentId: params.documentId,
    organizationId: params.organizationId,
    payloadBytes: preparedTrace.afterBytes,
  });
  try {
    const { error } = await withStageTimeout(
      admin
        .from('documents')
        .update({
          intelligence_trace: preparedTrace.executionTrace,
        })
        .eq('id', params.documentId)
        .eq('organization_id', params.organizationId),
      'documents.intelligence_trace update',
      EXECUTION_TRACE_PERSIST_TIMEOUT_MS,
    );

    if (error) {
      console.error('[generateAndPersistCanonicalIntelligence] persist execution trace failed', {
        documentId: params.documentId,
        organizationId: params.organizationId,
        error: error.message,
        payloadBytes: preparedTrace.afterBytes,
      });
      return {
        persisted: false,
        error: `Execution trace persistence failed for ${params.documentId}: ${error.message}`,
      };
    }

    console.log('[generateAndPersistCanonicalIntelligence] execution trace persistence complete', {
      documentId: params.documentId,
      organizationId: params.organizationId,
      payloadBytes: preparedTrace.afterBytes,
    });
    return { persisted: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generateAndPersistCanonicalIntelligence] persist execution trace threw', {
      documentId: params.documentId,
      organizationId: params.organizationId,
      error: message,
      payloadBytes: preparedTrace.afterBytes,
    });
    return {
      persisted: false,
      error: `Execution trace persistence failed for ${params.documentId}: ${message}`,
    };
  }
}

async function loadExistingV2Decisions(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<ExistingDecisionRow[]> {
  const { data, error } = await admin
    .from('decisions')
    .select('id, decision_type, status, assigned_to, assigned_at, due_at, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .contains('details', {
      intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
      generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    });

  if (error || !data) return [];
  return data as ExistingDecisionRow[];
}

async function loadExistingV2Tasks(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<ExistingTaskRow[]> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id, task_type, status, assigned_to, assigned_at, due_at, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .contains('details', {
      intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
      generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    });

  if (error || !data) return [];
  return data as ExistingTaskRow[];
}

async function suppressLegacyGeneratedDecisions(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('decisions')
    .select('id, decision_type, status, assigned_to, assigned_at, due_at, source, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .in('source', ['rule_engine', 'deterministic', 'system']);

  if (error || !data) return 0;

  const candidates = (data as ExistingGeneratedDecisionRow[]).filter(
    (row) => !hasV2DetailsMarker(row.details),
  );
  if (candidates.length === 0) return 0;

  const now = new Date().toISOString();
  let suppressed = 0;

  for (const row of candidates) {
    if (isOperatorManagedDecision(row)) continue;

    const { error: updateError } = await admin
      .from('decisions')
      .update({
        status: 'dismissed',
        updated_at: now,
        details: withSupersededDetails(row.details, now),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error('[generateAndPersistCanonicalIntelligence] suppress legacy decision failed', {
        documentId,
        organizationId,
        decisionId: row.id,
        error: updateError.message,
      });
      continue;
    }

    suppressed += 1;
  }

  return suppressed;
}

async function cancelLegacyGeneratedTasks(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id, task_type, status, assigned_to, assigned_at, due_at, source, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .in('source', ['rule_engine', 'decision_engine', 'system']);

  if (error || !data) return 0;

  const candidates = (data as ExistingGeneratedTaskRow[]).filter(
    (row) => !hasV2DetailsMarker(row.details),
  );
  if (candidates.length === 0) return 0;

  const now = new Date().toISOString();
  let cancelled = 0;

  for (const row of candidates) {
    if (isOperatorManagedTask(row)) continue;

    const { error: updateError } = await admin
      .from('workflow_tasks')
      .update({
        status: 'cancelled',
        updated_at: now,
        details: withSupersededDetails(row.details, now),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error('[generateAndPersistCanonicalIntelligence] cancel legacy workflow task failed', {
        documentId,
        organizationId,
        taskId: row.id,
        error: updateError.message,
      });
      continue;
    }

    cancelled += 1;
  }

  return cancelled;
}

async function upsertV2Decisions(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    projectId?: string | null;
    decisions: IntelligenceDecisionInsert[];
    allowLegacyTypeFallback: boolean;
  },
): Promise<{
  decisionIdsByLocalId: Map<string, string>;
  created: number;
  updated: number;
  deleted: number;
  preserved: number;
}> {
  const { documentId, organizationId, projectId, decisions, allowLegacyTypeFallback } = params;
  const now = new Date().toISOString();
  const existing = await loadExistingV2Decisions(admin, documentId, organizationId);
  const reusableExisting = existing.filter((row) => isReusableDecisionRow(row));
  const existingByIdentityKey = new Map(
    reusableExisting
      .map((row) => [getIdentityKey(row.details), row] as const)
      .filter((entry): entry is [string, ExistingDecisionRow] => entry[0] != null),
  );
  const fallbackRowsByType = new Map<string, ExistingDecisionRow[]>();
  for (const row of reusableExisting) {
    if (getIdentityKey(row.details)) continue;
    const rows = fallbackRowsByType.get(row.decision_type) ?? [];
    rows.push(row);
    fallbackRowsByType.set(row.decision_type, rows);
  }
  const incomingCountByType = new Map<string, number>();
  for (const decision of decisions) {
    incomingCountByType.set(
      decision.decision_type,
      (incomingCountByType.get(decision.decision_type) ?? 0) + 1,
    );
  }
  const matchedExistingIds = new Set<string>();
  const decisionIdsByLocalId = new Map<string, string>();

  let created = 0;
  let updated = 0;

  for (const decision of decisions) {
    const fallbackRows = allowLegacyTypeFallback
      ? (fallbackRowsByType.get(decision.decision_type) ?? [])
      : [];
    const existingRow =
      existingByIdentityKey.get(decision.identity_key) ??
      (fallbackRows.length === 1 && (incomingCountByType.get(decision.decision_type) ?? 0) === 1
        ? fallbackRows[0]
        : undefined);

    if (existingRow) {
      const { error } = await admin
        .from('decisions')
        .update({
          title: decision.title,
          summary: decision.summary,
          severity: decision.severity,
          confidence: decision.confidence,
          details: decision.details,
          source: decision.source,
          last_detected_at: now,
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to update v2 decision ${existingRow.id}: ${error.message}`);
      }

      matchedExistingIds.add(existingRow.id);
      decisionIdsByLocalId.set(decision.local_id, existingRow.id);
      updated += 1;
      continue;
    }

    const { data: inserted, error } = await admin
      .from('decisions')
      .insert({
        organization_id: organizationId,
        document_id: documentId,
        project_id: projectId ?? null,
        decision_type: decision.decision_type,
        title: decision.title,
        summary: decision.summary,
        severity: decision.severity,
        status: decision.lifecycle_status,
        confidence: decision.confidence,
        details: decision.details,
        source: decision.source,
        first_detected_at: now,
        last_detected_at: now,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !inserted) {
      throw new Error(`Failed to insert v2 decision ${decision.decision_type}: ${error?.message ?? 'unknown error'}`);
    }

    const insertedId = (inserted as { id: string }).id;
    matchedExistingIds.add(insertedId);
    decisionIdsByLocalId.set(decision.local_id, insertedId);
    created += 1;
  }

  let deleted = 0;
  let preserved = 0;

  for (const existingRow of existing) {
    if (matchedExistingIds.has(existingRow.id)) continue;

    if (hasSupersededMarker(existingRow.details)) {
      preserved += 1;
      continue;
    }

    if (isOperatorManagedDecision(existingRow)) {
      const { error } = await admin
        .from('decisions')
        .update({
          details: withSupersededDetails(existingRow.details, now),
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to preserve stale v2 decision ${existingRow.id}: ${error.message}`);
      }

      preserved += 1;
      continue;
    }

    const { error } = await admin
      .from('decisions')
      .delete()
      .eq('id', existingRow.id);

    if (error) {
      throw new Error(`Failed to delete stale v2 decision ${existingRow.id}: ${error.message}`);
    }

    deleted += 1;
  }

  return { decisionIdsByLocalId, created, updated, deleted, preserved };
}

async function upsertV2Tasks(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    projectId?: string | null;
    tasks: IntelligenceTaskInsert[];
    decisionIdsByLocalId: Map<string, string>;
    allowLegacyTypeFallback: boolean;
  },
): Promise<{
  taskIdsByLocalId: Map<string, string>;
  created: number;
  updated: number;
  deleted: number;
  preserved: number;
}> {
  const { documentId, organizationId, projectId, tasks, decisionIdsByLocalId, allowLegacyTypeFallback } = params;
  const now = new Date().toISOString();
  const existing = await loadExistingV2Tasks(admin, documentId, organizationId);
  const reusableExisting = existing.filter((row) => isReusableTaskRow(row));
  const existingByIdentityKey = new Map(
    reusableExisting
      .map((row) => [getIdentityKey(row.details), row] as const)
      .filter((entry): entry is [string, ExistingTaskRow] => entry[0] != null),
  );
  const fallbackRowsByType = new Map<string, ExistingTaskRow[]>();
  for (const row of reusableExisting) {
    if (getIdentityKey(row.details)) continue;
    const rows = fallbackRowsByType.get(row.task_type) ?? [];
    rows.push(row);
    fallbackRowsByType.set(row.task_type, rows);
  }
  const incomingCountByType = new Map<string, number>();
  for (const task of tasks) {
    incomingCountByType.set(
      task.task_type,
      (incomingCountByType.get(task.task_type) ?? 0) + 1,
    );
  }
  const matchedExistingIds = new Set<string>();
  const taskIdsByLocalId = new Map<string, string>();

  let created = 0;
  let updated = 0;

  for (const task of tasks) {
    const fallbackRows = allowLegacyTypeFallback
      ? (fallbackRowsByType.get(task.task_type) ?? [])
      : [];
    const existingRow =
      existingByIdentityKey.get(task.identity_key) ??
      (fallbackRows.length === 1 && (incomingCountByType.get(task.task_type) ?? 0) === 1
        ? fallbackRows[0]
        : undefined);
    const decisionId = task.related_decision_local_id
      ? decisionIdsByLocalId.get(task.related_decision_local_id) ?? null
      : null;

    if (existingRow) {
      const { error } = await admin
        .from('workflow_tasks')
        .update({
          decision_id: decisionId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          source: task.source,
          source_metadata: task.source_metadata,
          details: task.details,
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to update v2 workflow task ${existingRow.id}: ${error.message}`);
      }

      matchedExistingIds.add(existingRow.id);
      taskIdsByLocalId.set(task.local_id, existingRow.id);
      updated += 1;
      continue;
    }

    const { data: inserted, error } = await admin
      .from('workflow_tasks')
      .insert({
        organization_id: organizationId,
        document_id: documentId,
        project_id: projectId ?? null,
        decision_id: decisionId,
        task_type: task.task_type,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.lifecycle_status,
        source: task.source,
        source_metadata: task.source_metadata,
        details: task.details,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !inserted) {
      throw new Error(`Failed to insert v2 workflow task ${task.task_type}: ${error?.message ?? 'unknown error'}`);
    }

    const insertedId = (inserted as { id: string }).id;
    taskIdsByLocalId.set(task.local_id, insertedId);
    created += 1;
  }

  let deleted = 0;
  let preserved = 0;

  for (const existingRow of existing) {
    if (matchedExistingIds.has(existingRow.id)) continue;

    if (hasSupersededMarker(existingRow.details)) {
      preserved += 1;
      continue;
    }

    if (isOperatorManagedTask(existingRow)) {
      const { error } = await admin
        .from('workflow_tasks')
        .update({
          details: withSupersededDetails(existingRow.details, now),
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to preserve stale v2 workflow task ${existingRow.id}: ${error.message}`);
      }

      preserved += 1;
      continue;
    }

    const { error } = await admin
      .from('workflow_tasks')
      .delete()
      .eq('id', existingRow.id);

    if (error) {
      throw new Error(`Failed to delete stale v2 workflow task ${existingRow.id}: ${error.message}`);
    }

    deleted += 1;
  }

  return { taskIdsByLocalId, created, updated, deleted, preserved };
}

export async function generateAndPersistCanonicalIntelligence(params: {
  admin: SupabaseClient;
  documentId: string;
  organizationId: string;
  projectId?: string | null;
  extractionData?: Record<string, unknown> | null;
}): Promise<PersistCanonicalIntelligenceResult> {
  const buildContext = await loadBuildParams(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    extractionData: params.extractionData,
  });

  if (!buildContext) {
    return {
      handled: false,
      family: null,
      intelligence: null,
      execution_trace_persisted: false,
      transaction_data_persisted: null,
      canonical_persistence_error: null,
      decisions_created: 0,
      decisions_updated: 0,
      decisions_deleted: 0,
      decisions_preserved: 0,
      tasks_created: 0,
      tasks_updated: 0,
      tasks_deleted: 0,
      tasks_preserved: 0,
      legacy_decisions_suppressed: 0,
      legacy_tasks_cancelled: 0,
    };
  }

  // Load operator-confirmed fact reviews so the
  // document intelligence pipeline can suppress
  // findings for facts already confirmed by operators.
  // If the query fails, default to empty array —
  // analysis proceeds without suppression rather
  // than blocking document processing.
  const confirmedFactReviews = await loadDocumentFactReviews(
    [params.documentId],
  ).catch((err) => {
    console.warn(
      '[intelligencePersistence] failed to load fact reviews:',
      err,
    );
    return [] as Awaited<ReturnType<typeof loadDocumentFactReviews>>;
  });

  // Load the operator's upload-time rate schedule page hint, if any.
  // Absent (no row, or table not yet migrated) is identical to today's
  // behavior — the hint is a sort preference only, never a restriction.
  const uploadGuidance = await loadContractUploadGuidanceForDocument(
    params.admin,
    params.documentId,
  ).catch((err) => {
    console.warn(
      '[intelligencePersistence] failed to load contract upload guidance:',
      err,
    );
    return null;
  });

  const pipelineResult = runDocumentPipeline({
    documentId: params.documentId,
    documentType: buildContext.buildParams.documentType,
    documentName: buildContext.buildParams.documentName,
    documentTitle: buildContext.buildParams.documentTitle,
    projectName: buildContext.buildParams.projectName,
    extractionData: buildContext.buildParams.extractionData,
    relatedDocs: buildContext.buildParams.relatedDocs,
    confirmedFactReviews,
    rateSchedulePageHints: rateSchedulePageHintsFromGuidance(uploadGuidance),
  });

  await persistExtractionInspectionSnapshots(params.admin, {
    documentId: params.documentId,
    extractionSnapshotId: buildContext.extractionSnapshotId,
    extractionData: buildContext.buildParams.extractionData,
    extracted: pipelineResult.extracted,
  });

  const transactionDataDocument = isTransactionDataExtracted(pipelineResult.extracted);
  const invoiceDocument = isInvoiceDocumentType(buildContext.buildParams.documentType);
  if (invoiceDocument) {
    const rateDiffResult = await persistOperationalRateDiffFromInspectionSnapshots(params.admin, {
      documentId: params.documentId,
      projectId: params.projectId ?? null,
      relatedDocs: buildContext.buildParams.relatedDocs,
      extracted: pipelineResult.extracted,
    });
    const extractedRecord = asRecord(pipelineResult.extracted);
    if (extractedRecord && rateDiffResult.diff) {
      extractedRecord.canonicalOperationalRateDiff = rateDiffResult.diff;
    }
    if (extractedRecord && rateDiffResult.warnings.length > 0) {
      extractedRecord.canonicalOperationalRateDiffWarnings = rateDiffResult.warnings;
    }
  }
  let transactionDataPersisted: boolean | null = transactionDataDocument ? false : null;
  let canonicalPersistenceError: string | null = null;

  try {
    const transactionDataResult = await withStageTimeout(
      persistTransactionDataForDocument({
        admin: params.admin,
        documentId: params.documentId,
        projectId: params.projectId ?? null,
        organizationId: params.organizationId,
        extracted: pipelineResult.extracted,
      }),
      'persistTransactionDataForDocument',
      TRANSACTION_DATA_PERSIST_TIMEOUT_MS,
    );

    if (transactionDataDocument) {
      transactionDataPersisted = transactionDataResult.persisted === true && transactionDataResult.skipped !== true;
      if (!transactionDataPersisted) {
        canonicalPersistenceError = formatTransactionDataPersistenceError(
          params.documentId,
          transactionDataResult,
        );
        console.error('[generateAndPersistCanonicalIntelligence] transaction data persistence did not complete', {
          documentId: params.documentId,
          projectId: params.projectId ?? null,
          documentType: buildContext.buildParams.documentType,
          reason: transactionDataResult.reason ?? null,
        });
      }
    }
  } catch (error) {
    if (transactionDataDocument) {
      transactionDataPersisted = false;
      canonicalPersistenceError = `Transaction data persistence failed for ${params.documentId}: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.error('[generateAndPersistCanonicalIntelligence] persist transaction data failed', {
      documentId: params.documentId,
      projectId: params.projectId ?? null,
      documentType: buildContext.buildParams.documentType,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (shouldPersistCanonicalSupport({
    extractionData: buildContext.buildParams.extractionData,
    extracted: pipelineResult.extracted,
  })) {
    try {
      const supportResult = await withStageTimeout(
        persistCanonicalSupportForDocument({
          admin: params.admin,
          documentId: params.documentId,
          projectId: params.projectId ?? null,
          organizationId: params.organizationId,
          extractionData: buildContext.buildParams.extractionData,
          extracted: asRecord(pipelineResult.extracted),
        }),
        'persistCanonicalSupportForDocument',
        SUPPORT_PERSIST_TIMEOUT_MS,
      );

      if (shouldReportSupportPersistenceFailure(supportResult)) {
        canonicalPersistenceError = canonicalPersistenceError
          ?? formatSupportPersistenceError(params.documentId, supportResult);
        console.error('[generateAndPersistCanonicalIntelligence] support persistence did not complete', {
          documentId: params.documentId,
          projectId: params.projectId ?? null,
          documentType: buildContext.buildParams.documentType,
          reason: supportResult.reason ?? null,
        });
      }
    } catch (error) {
      canonicalPersistenceError = canonicalPersistenceError
        ?? `Support persistence failed for ${params.documentId}: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[generateAndPersistCanonicalIntelligence] persist support data failed', {
        documentId: params.documentId,
        projectId: params.projectId ?? null,
        documentType: buildContext.buildParams.documentType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const contractInvoicePrimaryMode = isContractInvoicePrimaryDocumentType(
    buildContext.buildParams.documentType,
  );

  if (contractInvoicePrimaryMode && !pipelineResult.handled) {
    throw new Error(
      `Contract/invoice canonical pipeline did not handle document ${params.documentId}.`,
    );
  }

  const intelligence = pipelineResult.handled
    ? pipelineResultToIntelligence(pipelineResult)
    : buildDocumentIntelligence(buildContext.buildParams);
  const family = intelligence.classification.family;
  const mapped = mapIntelligenceToPersistenceRows({
    documentId: params.documentId,
    organizationId: params.organizationId,
    intelligence,
    extractionSnapshotId: buildContext.extractionSnapshotId,
    relatedDocs: buildContext.buildParams.relatedDocs,
  });
  const validatorManagedPrimaryFamily =
    params.projectId != null && isContractInvoicePrimaryFamily(family);

  if (!supportsCanonicalIntelligencePersistence(family)) {
    const executionTraceResult = await persistDocumentExecutionTrace(params.admin, {
      documentId: params.documentId,
      organizationId: params.organizationId,
      executionTrace: mapped.executionTrace,
    });
    return {
      handled: false,
      family,
      intelligence,
      execution_trace_persisted: executionTraceResult.persisted,
      transaction_data_persisted: transactionDataPersisted,
      canonical_persistence_error: canonicalPersistenceError ?? executionTraceResult.error,
      decisions_created: 0,
      decisions_updated: 0,
      decisions_deleted: 0,
      decisions_preserved: 0,
      tasks_created: 0,
      tasks_updated: 0,
      tasks_deleted: 0,
      tasks_preserved: 0,
      legacy_decisions_suppressed: 0,
      legacy_tasks_cancelled: 0,
    };
  }

  const VALIDATOR_MANAGED_DECISION_TYPES = new Set([
    'validator_finding',
    'validator_invoice_approval',
    'validator_project_approval',
  ]);
  const validatorManagedDecisions = mapped.decisions.filter((decision) =>
    VALIDATOR_MANAGED_DECISION_TYPES.has(decision.decision_type),
  );
  const intelligenceOnlyDecisions = mapped.decisions.filter((decision) =>
    !VALIDATOR_MANAGED_DECISION_TYPES.has(decision.decision_type),
  );
  type UpsertV2DecisionsResult = Awaited<ReturnType<typeof upsertV2Decisions>>;
  let decisionResult: UpsertV2DecisionsResult;

  if (validatorManagedPrimaryFamily) {
    // Persist intelligence-only decisions that have no other persistence path.
    // Skip validator-managed decisions because the validator pipeline owns them.
    decisionResult = intelligenceOnlyDecisions.length > 0
      ? await upsertV2Decisions(params.admin, {
          documentId: params.documentId,
          organizationId: params.organizationId,
          projectId: params.projectId ?? null,
          decisions: intelligenceOnlyDecisions,
          allowLegacyTypeFallback: false,
        })
      : {
          decisionIdsByLocalId: new Map<string, string>(),
          created: 0,
          updated: 0,
          deleted: 0,
          preserved: 0,
        };
  } else {
    decisionResult = await upsertV2Decisions(params.admin, {
        documentId: params.documentId,
        organizationId: params.organizationId,
        projectId: params.projectId ?? null,
        decisions: mapped.decisions,
        allowLegacyTypeFallback: !isContractInvoicePrimaryFamily(family),
      });
  }

  const taskResult = await upsertV2Tasks(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    projectId: params.projectId ?? null,
    tasks: mapped.tasks,
    decisionIdsByLocalId: decisionResult.decisionIdsByLocalId,
    allowLegacyTypeFallback: !isContractInvoicePrimaryFamily(family),
  });

  const executionTraceResult = await persistDocumentExecutionTrace(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    executionTrace: materializePersistedExecutionTrace({
      executionTrace: mapped.executionTrace,
      decisionIdsByLocalId: decisionResult.decisionIdsByLocalId,
      taskIdsByLocalId: taskResult.taskIdsByLocalId,
    }),
  });

  const legacyTasksCancelled = await cancelLegacyGeneratedTasks(
    params.admin,
    params.documentId,
    params.organizationId,
  );
  const legacyDecisionsSuppressed = await suppressLegacyGeneratedDecisions(
    params.admin,
    params.documentId,
    params.organizationId,
  );

  return {
    handled: true,
    family,
    intelligence,
    execution_trace_persisted: executionTraceResult.persisted,
    transaction_data_persisted: transactionDataPersisted,
    canonical_persistence_error: canonicalPersistenceError ?? executionTraceResult.error,
    decisions_created: decisionResult.created,
    decisions_updated: decisionResult.updated,
    decisions_deleted: decisionResult.deleted,
    decisions_preserved: decisionResult.preserved,
    tasks_created: taskResult.created,
    tasks_updated: taskResult.updated,
    tasks_deleted: taskResult.deleted,
    tasks_preserved: taskResult.preserved,
    legacy_decisions_suppressed: legacyDecisionsSuppressed,
    legacy_tasks_cancelled: legacyTasksCancelled,
  };
}

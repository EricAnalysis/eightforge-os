import { createHash } from 'node:crypto';
import {
  isDocumentFactOverridesTableUnavailableError,
} from '@/lib/documentFactOverrides';
import {
  isDocumentFactReviewsTableUnavailableError,
} from '@/lib/documentFactReviews';
import {
  loadProjectDocumentPrecedenceSnapshot,
  type ProjectDocumentPrecedenceSnapshot,
} from '@/lib/server/documentPrecedence';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { persistValidationRun } from '@/lib/validator/persistValidationRun';
import { validateProject } from '@/lib/validator/projectValidator';
import type { ValidationTriggerSource } from '@/types/validator';

type TableError = {
  code?: string | null;
  message?: string | null;
} | null | undefined;

const DEBOUNCE_WINDOW_MS = 30_000;
const LARGE_PROJECT_RECORD_THRESHOLD = 500;

function requireAdminClient() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Server validation client is not configured.');
  }

  return admin;
}

function isMissingProjectTable(
  error: TableError,
  tableName: string,
): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205' || code === '42P01') {
    return true;
  }

  return (
    message.includes(tableName) &&
    (
      message.includes('schema cache') ||
      message.includes('does not exist') ||
      message.includes('could not find the table')
    )
  );
}

function isMissingColumnError(
  error: TableError,
  columnName: string,
): boolean {
  if (!error) return false;

  const message = (error.message ?? '').toLowerCase();
  const normalizedColumnName = columnName.toLowerCase();

  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    message.includes(`'${normalizedColumnName}'`) ||
    message.includes(normalizedColumnName)
  );
}

async function hasRecentInFlightRun(projectId: string): Promise<boolean> {
  const admin = requireAdminClient();
  const threshold = new Date(Date.now() - DEBOUNCE_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from('project_validation_runs')
    .select('id')
    .eq('project_id', projectId)
    .in('status', ['pending', 'running'])
    .gte('run_at', threshold)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load recent validation runs: ${error.message}`);
  }

  return (data?.length ?? 0) > 0;
}

async function loadLastCompletedSnapshotHash(
  projectId: string,
): Promise<string | null> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_runs')
    .select('inputs_snapshot_hash')
    .eq('project_id', projectId)
    .eq('status', 'complete')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load last completed validation run: ${error.message}`);
  }

  return data?.inputs_snapshot_hash ?? null;
}

type ProjectDocumentInputSnapshot = {
  id: string;
  processed_at?: string | null;
  intelligence_trace?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringFromRecord(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function numberFromRecord(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value.replace(/[$,]/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function contractTraceFingerprint(document: ProjectDocumentInputSnapshot): unknown {
  const trace = asRecord(document.intelligence_trace);
  const contractAnalysis = asRecord(trace?.contract_analysis);
  if (!contractAnalysis) {
    return {
      id: document.id,
      processed_at: document.processed_at ?? null,
      contract_analysis: null,
    };
  }

  const pricingModel = asRecord(contractAnalysis.pricing_model);
  const rows = Array.isArray(contractAnalysis.rate_schedule_rows)
    ? contractAnalysis.rate_schedule_rows
      .map((value) => asRecord(value))
      .filter((value): value is Record<string, unknown> => value != null)
      .map((row) => ({
        row_id: stringFromRecord(row, ['row_id', 'id']),
        source_kind: stringFromRecord(row, ['source_kind']),
        category: stringFromRecord(row, ['category', 'source_category', 'material_type']),
        description: stringFromRecord(row, ['description', 'scope']),
        unit: stringFromRecord(row, ['unit', 'unit_type']),
        rate: numberFromRecord(row, ['rate_amount', 'rate']),
        page: numberFromRecord(row, ['page', 'source_page']),
        confidence: stringFromRecord(row, ['confidence']),
      }))
      .sort((left, right) =>
        `${left.page ?? ''}:${left.row_id ?? ''}:${left.rate ?? ''}`.localeCompare(
          `${right.page ?? ''}:${right.row_id ?? ''}:${right.rate ?? ''}`,
          'en-US',
        ),
      )
    : [];

  return {
    id: document.id,
    processed_at: document.processed_at ?? null,
    contract_analysis: {
      rate_schedule_present: asRecord(pricingModel?.rate_schedule_present)?.value ?? null,
      rate_schedule_rows: rows,
    },
  };
}

export function buildValidationInputsSnapshotHash(params: {
  ticketCount: number;
  factCount: number;
  documentSnapshots: readonly ProjectDocumentInputSnapshot[];
  precedenceFingerprint: string;
  validationPhase: string | null;
}): string {
  return createHash('sha1')
    .update(JSON.stringify({
      ticketCount: params.ticketCount,
      factCount: params.factCount,
      documentCount: params.documentSnapshots.length,
      documents: params.documentSnapshots
        .map(contractTraceFingerprint)
        .sort((left, right) => {
          const leftId = asRecord(left)?.id;
          const rightId = asRecord(right)?.id;
          return String(leftId ?? '').localeCompare(String(rightId ?? ''), 'en-US');
        }),
      precedenceFingerprint: params.precedenceFingerprint,
      validationPhase: params.validationPhase ?? 'contract_setup',
    }))
    .digest('hex');
}

async function loadProjectDocumentInputSnapshots(projectId: string): Promise<ProjectDocumentInputSnapshot[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('documents')
    .select('id, processed_at, intelligence_trace')
    .eq('project_id', projectId);

  if (error) {
    throw new Error(`Failed to load project documents: ${error.message}`);
  }

  return ((data ?? []) as ProjectDocumentInputSnapshot[]).map((row) => ({
    id: row.id,
    processed_at: row.processed_at ?? null,
    intelligence_trace: row.intelligence_trace ?? null,
  }));
}

async function loadProjectOrganizationId(projectId: string): Promise<string | null> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('projects')
    .select('organization_id')
    .eq('id', projectId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load project organization: ${error.message}`);
  }

  return typeof data?.organization_id === 'string' ? data.organization_id : null;
}

async function loadProjectValidationPhase(projectId: string): Promise<string | null> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('projects')
    .select('validation_phase')
    .eq('id', projectId)
    .maybeSingle();

  if (error && isMissingColumnError(error, 'validation_phase')) {
    return 'contract_setup';
  }
  if (error) {
    throw new Error(`Failed to load project validation phase: ${error.message}`);
  }

  return typeof data?.validation_phase === 'string' ? data.validation_phase : 'contract_setup';
}

export function buildDocumentPrecedenceSnapshotFingerprint(
  snapshot: ProjectDocumentPrecedenceSnapshot,
): string {
  const relationships = [...snapshot.relationships]
    .map((relationship) => ({
      source_document_id: relationship.source_document_id,
      target_document_id: relationship.target_document_id,
      relationship_type: relationship.relationship_type,
    }))
    .sort((left, right) => {
      const leftKey = `${left.source_document_id}:${left.relationship_type}:${left.target_document_id}`;
      const rightKey = `${right.source_document_id}:${right.relationship_type}:${right.target_document_id}`;
      return leftKey.localeCompare(rightKey, 'en-US');
    });

  const families = snapshot.families.map((family) => ({
    family: family.family,
    governing_document_id: family.governing_document_id ?? null,
    governing_reason: family.governing_reason ?? null,
    has_operator_override: family.has_operator_override,
    documents: family.documents.map((document) => ({
      id: document.id,
      document_subtype: document.document_subtype ?? null,
      authority_status: document.authority_status ?? null,
      effective_date: document.effective_date ?? null,
      precedence_rank: document.precedence_rank ?? null,
      operator_override_precedence: Boolean(document.operator_override_precedence),
      resolved_order: document.resolved_order,
      resolved_role: document.resolved_role,
      resolved_subtype: document.resolved_subtype,
      is_governing: document.is_governing,
      governing_document_id: document.governing_document_id ?? null,
    })),
  }));

  return createHash('sha1')
    .update(JSON.stringify({ families, relationships }))
    .digest('hex');
}

async function loadDocumentPrecedenceFingerprint(projectId: string): Promise<string> {
  const admin = requireAdminClient();
  const organizationId = await loadProjectOrganizationId(projectId);
  if (!organizationId) return 'none';

  const snapshot = await loadProjectDocumentPrecedenceSnapshot(admin, {
    organizationId,
    projectId,
  });

  return buildDocumentPrecedenceSnapshotFingerprint(snapshot);
}

async function countProjectScopedRows(
  table: 'mobile_tickets' | 'load_tickets' | 'document_relationships',
  projectId: string,
): Promise<number> {
  const admin = requireAdminClient();
  const { count, error } = await admin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);

  if (error && isMissingProjectTable(error, table)) {
    return 0;
  }
  if (error) {
    throw new Error(`Failed to count ${table}: ${error.message}`);
  }

  return count ?? 0;
}

async function countInvoiceLineRows(projectId: string): Promise<number> {
  const admin = requireAdminClient();
  const { count, error } = await admin
    .from('invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);

  if (
    error &&
    (
      isMissingProjectTable(error, 'invoice_lines') ||
      isMissingColumnError(error, 'project_id')
    )
  ) {
    return 0;
  }
  if (error) {
    throw new Error(`Failed to count invoice_lines: ${error.message}`);
  }

  return count ?? 0;
}

async function countNormalizedFacts(documentIds: readonly string[]): Promise<number> {
  if (documentIds.length === 0) return 0;

  const admin = requireAdminClient();
  const { count, error } = await admin
    .from('document_extractions')
    .select('id', { count: 'exact', head: true })
    .in('document_id', [...documentIds])
    .eq('status', 'active')
    .not('field_key', 'is', null);

  if (error) {
    throw new Error(`Failed to count document extraction facts: ${error.message}`);
  }

  return count ?? 0;
}

async function countDocumentFactOverrides(documentIds: readonly string[]): Promise<number> {
  if (documentIds.length === 0) return 0;

  const admin = requireAdminClient();
  const { count, error } = await admin
    .from('document_fact_overrides')
    .select('id', { count: 'exact', head: true })
    .in('document_id', [...documentIds]);

  if (error && isDocumentFactOverridesTableUnavailableError(error)) {
    return 0;
  }
  if (error) {
    throw new Error(`Failed to count document fact overrides: ${error.message}`);
  }

  return count ?? 0;
}

async function countDocumentFactReviews(documentIds: readonly string[]): Promise<number> {
  if (documentIds.length === 0) return 0;

  const admin = requireAdminClient();
  const { count, error } = await admin
    .from('document_fact_reviews')
    .select('id', { count: 'exact', head: true })
    .in('document_id', [...documentIds]);

  if (error && isDocumentFactReviewsTableUnavailableError(error)) {
    return 0;
  }
  if (error) {
    throw new Error(`Failed to count document fact reviews: ${error.message}`);
  }

  return count ?? 0;
}

type ValidationTriggerMetrics = {
  inputsSnapshotHash: string;
  relevantRecordCount: number;
};

export type TriggerProjectValidationResult =
  | {
      status: 'triggered';
      mode: 'sync' | 'background';
      inputsSnapshotHash: string;
    }
  | {
      status: 'skipped';
      reason: 'in_flight' | 'unchanged';
    }
  | {
      status: 'failed';
      error: string;
    };

export type TriggerProjectValidationOptions = {
  force?: boolean;
};

export function shouldSkipUnchangedValidationInputs(params: {
  lastCompletedSnapshotHash: string | null;
  inputsSnapshotHash: string;
  force?: boolean;
}): boolean {
  return (
    !params.force &&
    params.lastCompletedSnapshotHash != null &&
    params.lastCompletedSnapshotHash === params.inputsSnapshotHash
  );
}

async function loadValidationTriggerMetrics(
  projectId: string,
): Promise<ValidationTriggerMetrics> {
  const documentSnapshots = await loadProjectDocumentInputSnapshots(projectId);
  const documentIds = documentSnapshots.map((document) => document.id);

  const [
    mobileTicketCount,
    loadTicketCount,
    invoiceLineCount,
    normalizedFactCount,
    overrideCount,
    reviewCount,
    relationshipCount,
    precedenceFingerprint,
    validationPhase,
  ] = await Promise.all([
    countProjectScopedRows('mobile_tickets', projectId),
    countProjectScopedRows('load_tickets', projectId),
    countInvoiceLineRows(projectId),
    countNormalizedFacts(documentIds),
    countDocumentFactOverrides(documentIds),
    countDocumentFactReviews(documentIds),
    countProjectScopedRows('document_relationships', projectId),
    loadDocumentPrecedenceFingerprint(projectId),
    loadProjectValidationPhase(projectId),
  ]);

  const ticketCount = mobileTicketCount + loadTicketCount;
  const factCount =
    normalizedFactCount +
    overrideCount +
    reviewCount +
    relationshipCount;

  return {
    inputsSnapshotHash: buildValidationInputsSnapshotHash({
      ticketCount,
      factCount,
      documentSnapshots,
      precedenceFingerprint,
      validationPhase,
    }),
    relevantRecordCount: ticketCount + invoiceLineCount,
  };
}

async function runValidationFlow(params: {
  projectId: string;
  source: ValidationTriggerSource;
  userId?: string;
  inputsSnapshotHash: string;
}): Promise<void> {
  const result = await validateProject(params.projectId);
  await persistValidationRun(
    params.projectId,
    result,
    params.source,
    params.userId,
    params.inputsSnapshotHash,
  );
}

async function logValidationRunRequested(params: {
  projectId: string;
  source: ValidationTriggerSource;
  userId?: string;
  inputsSnapshotHash: string;
  mode: 'sync' | 'background';
}): Promise<void> {
  const organizationId = await loadProjectOrganizationId(params.projectId);
  if (!organizationId) return;

  const activityResult = await logActivityEvent({
    organization_id: organizationId,
    project_id: params.projectId,
    entity_type: 'project',
    entity_id: params.projectId,
    event_type: 'validation_run_requested',
    changed_by: params.userId ?? null,
    new_value: {
      trigger_source: params.source,
      request_mode: params.mode,
      inputs_snapshot_hash: params.inputsSnapshotHash,
    },
  });

  if (!activityResult.ok) {
    console.error('[triggerProjectValidation] failed to log validation request', {
      projectId: params.projectId,
      source: params.source,
      error: activityResult.error,
    });
  }
}

function startBackgroundValidation(params: {
  projectId: string;
  source: ValidationTriggerSource;
  userId?: string;
  inputsSnapshotHash: string;
}) {
  // Start immediately on the current tick instead of deferring with a timer.
  // Most trigger points are request-scoped handlers, so this keeps the work
  // fire-and-forget while reducing the chance that the runtime drops it before
  // validation begins.
  void (async () => {
    try {
      await runValidationFlow(params);
    } catch (error) {
      console.error('[triggerProjectValidation] background validation failed', {
        projectId: params.projectId,
        source: params.source,
        userId: params.userId ?? null,
        error,
      });
    }
  })();
}

export async function triggerProjectValidation(
  projectId: string,
  source: ValidationTriggerSource,
  userId?: string,
  options: TriggerProjectValidationOptions = {},
): Promise<TriggerProjectValidationResult> {
  try {
    if (await hasRecentInFlightRun(projectId)) {
      return {
        status: 'skipped',
        reason: 'in_flight',
      };
    }

    const triggerMetrics = await loadValidationTriggerMetrics(projectId);
    const lastCompletedSnapshotHash = await loadLastCompletedSnapshotHash(projectId);

    if (shouldSkipUnchangedValidationInputs({
      lastCompletedSnapshotHash,
      inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
      force: options.force,
    })) {
      return {
        status: 'skipped',
        reason: 'unchanged',
      };
    }

    if (triggerMetrics.relevantRecordCount > LARGE_PROJECT_RECORD_THRESHOLD) {
      await logValidationRunRequested({
        projectId,
        source,
        userId,
        inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
        mode: 'background',
      });
      startBackgroundValidation({
        projectId,
        source,
        userId,
        inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
      });
      return {
        status: 'triggered',
        mode: 'background',
        inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
      };
    }

    await logValidationRunRequested({
      projectId,
      source,
      userId,
      inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
      mode: 'sync',
    });
    await runValidationFlow({
      projectId,
      source,
      userId,
      inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
    });
    return {
      status: 'triggered',
      mode: 'sync',
      inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
    };
  } catch (error) {
    console.error('[triggerProjectValidation] validation trigger failed', {
      projectId,
      source,
      userId: userId ?? null,
      error,
    });
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown validation trigger error',
    };
  }
}

import {
  isDocumentFactOverridesTableUnavailableError,
} from '@/lib/documentFactOverrides';
import {
  isDocumentFactReviewsTableUnavailableError,
} from '@/lib/documentFactReviews';
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

async function loadProjectDocumentIds(projectId: string): Promise<string[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('documents')
    .select('id')
    .eq('project_id', projectId);

  if (error) {
    throw new Error(`Failed to load project documents: ${error.message}`);
  }

  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
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

async function loadValidationTriggerMetrics(
  projectId: string,
): Promise<ValidationTriggerMetrics> {
  const documentIds = await loadProjectDocumentIds(projectId);
  const documentCount = documentIds.length;

  const [
    mobileTicketCount,
    loadTicketCount,
    invoiceLineCount,
    normalizedFactCount,
    overrideCount,
    reviewCount,
    relationshipCount,
  ] = await Promise.all([
    countProjectScopedRows('mobile_tickets', projectId),
    countProjectScopedRows('load_tickets', projectId),
    countInvoiceLineRows(projectId),
    countNormalizedFacts(documentIds),
    countDocumentFactOverrides(documentIds),
    countDocumentFactReviews(documentIds),
    countProjectScopedRows('document_relationships', projectId),
  ]);

  const ticketCount = mobileTicketCount + loadTicketCount;
  const factCount =
    normalizedFactCount +
    overrideCount +
    reviewCount +
    relationshipCount;

  return {
    inputsSnapshotHash: `${ticketCount}:${factCount}:${documentCount}`,
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
): Promise<void> {
  try {
    if (await hasRecentInFlightRun(projectId)) {
      return;
    }

    const triggerMetrics = await loadValidationTriggerMetrics(projectId);
    const lastCompletedSnapshotHash = await loadLastCompletedSnapshotHash(projectId);

    if (
      lastCompletedSnapshotHash != null &&
      lastCompletedSnapshotHash === triggerMetrics.inputsSnapshotHash
    ) {
      return;
    }

    if (triggerMetrics.relevantRecordCount > LARGE_PROJECT_RECORD_THRESHOLD) {
      startBackgroundValidation({
        projectId,
        source,
        userId,
        inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
      });
      return;
    }

    await runValidationFlow({
      projectId,
      source,
      userId,
      inputsSnapshotHash: triggerMetrics.inputsSnapshotHash,
    });
  } catch (error) {
    console.error('[triggerProjectValidation] validation trigger failed', {
      projectId,
      source,
      userId: userId ?? null,
      error,
    });
  }
}

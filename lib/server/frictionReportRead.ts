import { buildFrictionReport, type FrictionReport } from '@/lib/resolution/frictionReport';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { deriveValueReadingTelemetry } from '@/lib/resolution/valueReadingLifecycle';
import { loadRegionBoundAssertionRows } from '@/lib/server/regionBoundHumanAssertions';
import { readResolutionQueue, type ResolutionReadClient } from '@/lib/server/resolutionQueueRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  loadValueReadingRecords,
  VALUE_READING_OUTCOMES_TABLE,
  VALUE_READING_RECOVERY_TYPE,
} from '@/lib/server/valueReadingProposals';

/**
 * One organization's friction report (Forgewing generalization, phase 5),
 * composed from existing reads only: each project's resolution queue (the
 * same cases the workspace shows), the human_fact_assertions ledger, and the
 * value-reading proposals, reviews and outcomes. Read-only; scoped to one
 * organization, never across tenants.
 */

export const FRICTION_REPORT_MAX_PROJECTS = 50;

export type FrictionReportReadResult =
  | Readonly<{ status: 'ok'; report: FrictionReport }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>;

type Rows = PromiseLike<{ data: unknown; error: unknown }>;
type Query = Rows & { eq(column: string, value: unknown): Query; in(column: string, values: readonly string[]): Query; limit(count: number): Query };

export async function readFrictionReport(
  query: Readonly<{ organizationId: string }>,
  dependencies: Readonly<{ admin?: ResolutionReadClient | null; readQueue?: typeof readResolutionQueue }> = {},
): Promise<FrictionReportReadResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as ResolutionReadClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const from = (table: string, columns: string) =>
    (admin as unknown as { from(table: string): { select(columns: string): Query } }).from(table).select(columns);

  const projectsRead = await from('projects', 'id').eq('organization_id', query.organizationId).limit(FRICTION_REPORT_MAX_PROJECTS);
  if (projectsRead.error) return { status: 'read_failed', reason: 'projects_read_failed' };
  const projectIds = (Array.isArray(projectsRead.data) ? projectsRead.data : [])
    .flatMap((row) => typeof (row as { id?: unknown }).id === 'string' ? [(row as { id: string }).id] : []);

  const projects: { projectId: string; cases: readonly ResolutionCase[] }[] = [];
  for (const projectId of projectIds) {
    const read = await (dependencies.readQueue ?? readResolutionQueue)(
      { organizationId: query.organizationId, projectId }, { admin, forgewingEnabled: false });
    if (read.status === 'ok') projects.push({ projectId, cases: read.queue.cases });
    else if (read.status === 'read_failed') return { status: 'read_failed', reason: read.reason };
  }

  const documentsRead = await from('documents', 'id, document_type').eq('organization_id', query.organizationId);
  if (documentsRead.error) return { status: 'read_failed', reason: 'documents_read_failed' };
  const documentTypeById = new Map<string, string | null>();
  for (const row of Array.isArray(documentsRead.data) ? documentsRead.data as { id?: unknown; document_type?: unknown }[] : []) {
    if (typeof row.id === 'string') documentTypeById.set(row.id, typeof row.document_type === 'string' ? row.document_type : null);
  }
  const documentIds = [...documentTypeById.keys()];

  try {
    const assertions = await loadRegionBoundAssertionRows(admin, documentIds);
    const records = await loadValueReadingRecords(admin as never, { organizationId: query.organizationId, documentIds });
    const outcomesRead = documentIds.length === 0 ? { data: [], error: null }
      : await from(VALUE_READING_OUTCOMES_TABLE, 'outcome_code, source_document_id')
        .eq('organization_id', query.organizationId).eq('recovery_type', VALUE_READING_RECOVERY_TYPE)
        .in('source_document_id', documentIds);
    if (outcomesRead.error) return { status: 'read_failed', reason: 'outcomes_read_failed' };
    const outcomes = (Array.isArray(outcomesRead.data) ? outcomesRead.data as { outcome_code?: unknown; source_document_id?: unknown }[] : [])
      .flatMap((row) => typeof row.outcome_code === 'string'
        ? [{ outcomeCode: row.outcome_code, documentId: typeof row.source_document_id === 'string' ? row.source_document_id : null }] : []);
    return {
      status: 'ok',
      report: buildFrictionReport({
        organizationId: query.organizationId,
        projects,
        documentTypeById,
        assertions: assertions.rows,
        telemetry: deriveValueReadingTelemetry({ ...records, assertions: assertions.rows }),
        outcomes,
      }),
    };
  } catch {
    return { status: 'read_failed', reason: 'review_records_read_failed' };
  }
}

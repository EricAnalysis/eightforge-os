import { buildFrictionReport, type FrictionReport, type ValidatorOverrideRecord } from '@/lib/resolution/frictionReport';
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
 * value-reading proposals, reviews and outcomes, and the operator overrides
 * of Validator findings with the documents their evidence cites. Read-only; scoped to one
 * organization, never across tenants.
 */

export const FRICTION_REPORT_MAX_PROJECTS = 50;
/** Most recent operator overrides read for the rule semantics review (B6.4). */
export const FRICTION_REPORT_MAX_OVERRIDES = 1000;
const EVIDENCE_READ_CHUNK = 200;

/**
 * How much the report read, and whether a limit cut it short (B8.3b). A signal
 * computed from a truncated read undercounts; a submission records this.
 */
export type FrictionReportReadBounds = Readonly<{
  maxProjects: number;
  projectsRead: number;
  projectsTruncated: boolean;
  maxOverrides: number;
  overridesRead: number;
  overridesTruncated: boolean;
}>;

export type FrictionReportReadResult =
  | Readonly<{ status: 'ok'; report: FrictionReport; readBounds: FrictionReportReadBounds }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>;

type Rows = PromiseLike<{ data: unknown; error: unknown }>;
type Query = Rows & {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
};

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
    // B6.4: operator overrides of Validator findings, this organization only. Ids and
    // cited documents only; the operator's override reason is never read.
    const overridesRead = await from('execution_items', 'id, project_id, source_id, validator_rule_key')
      .eq('organization_id', query.organizationId).eq('source_type', 'validator_finding').eq('outcome', 'overridden')
      .order('updated_at', { ascending: false }).limit(FRICTION_REPORT_MAX_OVERRIDES);
    if (overridesRead.error) return { status: 'read_failed', reason: 'overrides_read_failed' };
    const overridesReadCount = Array.isArray(overridesRead.data) ? overridesRead.data.length : 0;
    const overrideRows = (Array.isArray(overridesRead.data) ? overridesRead.data as Record<string, unknown>[] : [])
      .flatMap((row) => typeof row.id === 'string' && typeof row.project_id === 'string' && typeof row.source_id === 'string'
        && typeof row.validator_rule_key === 'string' && projectIds.includes(row.project_id)
        ? [{ id: row.id, projectId: row.project_id, findingId: row.source_id, ruleId: row.validator_rule_key }] : []);
    const documentsByFinding = new Map<string, Set<string>>();
    const findingIds = [...new Set(overrideRows.map((row) => row.findingId))];
    for (let start = 0; start < findingIds.length; start += EVIDENCE_READ_CHUNK) {
      const evidenceRead = await from('project_validation_evidence', 'finding_id, source_document_id')
        .in('finding_id', findingIds.slice(start, start + EVIDENCE_READ_CHUNK));
      if (evidenceRead.error) return { status: 'read_failed', reason: 'override_evidence_read_failed' };
      for (const row of Array.isArray(evidenceRead.data) ? evidenceRead.data as Record<string, unknown>[] : []) {
        if (typeof row.finding_id !== 'string' || typeof row.source_document_id !== 'string') continue;
        // Only this organization's documents count as distinct documents.
        if (!documentTypeById.has(row.source_document_id)) continue;
        const documents = documentsByFinding.get(row.finding_id) ?? new Set<string>();
        documents.add(row.source_document_id);
        documentsByFinding.set(row.finding_id, documents);
      }
    }
    const overrides: ValidatorOverrideRecord[] = overrideRows.map((row) => ({
      organizationId: query.organizationId, projectId: row.projectId, executionItemId: row.id, findingId: row.findingId,
      ruleId: row.ruleId, documentIds: [...(documentsByFinding.get(row.findingId) ?? [])],
    }));
    return {
      status: 'ok',
      readBounds: {
        maxProjects: FRICTION_REPORT_MAX_PROJECTS,
        projectsRead: projectIds.length,
        projectsTruncated: projectIds.length >= FRICTION_REPORT_MAX_PROJECTS,
        maxOverrides: FRICTION_REPORT_MAX_OVERRIDES,
        overridesRead: overridesReadCount,
        overridesTruncated: overridesReadCount >= FRICTION_REPORT_MAX_OVERRIDES,
      },
      report: buildFrictionReport({
        organizationId: query.organizationId,
        projects,
        documentTypeById,
        assertions: assertions.rows,
        telemetry: deriveValueReadingTelemetry({ ...records, assertions: assertions.rows }),
        outcomes,
        overrides,
      }),
    };
  } catch {
    return { status: 'read_failed', reason: 'review_records_read_failed' };
  }
}

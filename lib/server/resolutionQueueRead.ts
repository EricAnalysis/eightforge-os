import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import { readRecoveryOperationalConfig } from '@/lib/extraction/recovery/recoveryOperationalPolicy';
import { documentReviewedValueState } from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ProjectDecisionRow } from '@/lib/projectOverview';
import {
  buildResolutionQueue,
  type DocumentReviewedValueState,
  type PendingRecoveryProposal,
  type ResolutionQueue,
} from '@/lib/resolution/resolutionCases';
import { resolveProjectIssueObjects } from '@/lib/resolveProjectIssueObjects';
import { readRecoveryReviewQueue } from '@/lib/server/forgewingRecoveryReviewRead';
import { loadRegionBoundAssertionRows, type RegionAssertionClient } from '@/lib/server/regionBoundHumanAssertions';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

/**
 * Server read for the resolution queue (B5-A). Read-only: it loads existing
 * records and hands them to the pure builder. It writes nothing.
 *
 * Forgewing suggestion sources (recovery proposals) are read only when
 * Forgewing is enabled. Today that means the deployment kill switch; it
 * becomes the per-organization entitlement once that lands. Everything else
 * is EightForge Core.
 */

const DECISION_SELECT = 'id, document_id, project_id, source, decision_type, title, summary, severity, status, '
  + 'confidence, last_detected_at, created_at, updated_at, due_at, assigned_to, details';

export type ResolutionQueueReadResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; queue: ResolutionQueue }>;

type Query = PromiseLike<{ data: unknown; error: { message?: string } | null }> & {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  is(column: string, value: null): Query;
  order(column: string, options: { ascending: boolean }): Query;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};
export type ResolutionReadClient = { from(table: string): { select(columns: string): Query } } & RegionAssertionClient;

function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? data as T[] : [];
}

export async function readResolutionQueue(
  query: Readonly<{ organizationId: string; projectId: string }>,
  dependencies: Readonly<{
    admin?: ResolutionReadClient | null;
    forgewingEnabled?: boolean;
    readRecoveryQueue?: typeof readRecoveryReviewQueue;
  }> = {},
): Promise<ResolutionQueueReadResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as ResolutionReadClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const forgewingEnabled = dependencies.forgewingEnabled
    ?? readRecoveryOperationalConfig(process.env, { context: 'resolution_queue' }).masterEnabled;

  const project = await admin.from('projects').select('id, organization_id')
    .eq('id', query.projectId).maybeSingle();
  if (project.error) return { status: 'read_failed', reason: 'project_read_failed' };
  const projectRow = project.data as { organization_id?: string } | null;
  if (!projectRow || projectRow.organization_id !== query.organizationId) return { status: 'not_found' };

  const [documentsRead, findingsRead, executionRead] = await Promise.all([
    admin.from('documents').select('id, title, name, document_type, document_role')
      .eq('organization_id', query.organizationId).eq('project_id', query.projectId),
    admin.from('project_validation_findings').select('*')
      .eq('project_id', query.projectId).eq('status', 'open'),
    admin.from('execution_items').select('*').eq('project_id', query.projectId),
  ]);
  if (documentsRead.error || findingsRead.error || executionRead.error) {
    return { status: 'read_failed', reason: 'project_records_read_failed' };
  }
  const documents = rows<{ id: string; title: string | null; name: string | null; document_type: string | null }>(documentsRead.data);
  const documentIds = documents.map((document) => document.id);
  const findings = rows<ValidationFinding>(findingsRead.data);

  const [evidenceRead, decisionsRead, extractionsRead, assertionRead] = await Promise.all([
    findings.length === 0 ? { data: [], error: null }
      : admin.from('project_validation_evidence').select('*').in('finding_id', findings.map((finding) => finding.id)),
    documentIds.length === 0 ? { data: [], error: null }
      : admin.from('decisions').select(DECISION_SELECT)
        .eq('organization_id', query.organizationId).in('document_id', documentIds),
    documentIds.length === 0 ? { data: [], error: null }
      : admin.from('document_extractions').select('document_id, created_at, data')
        .in('document_id', documentIds).is('field_key', null).order('created_at', { ascending: false }),
    loadRegionBoundAssertionRows(admin, documentIds),
  ]);
  if (evidenceRead.error || decisionsRead.error || extractionsRead.error) {
    return { status: 'read_failed', reason: 'review_inputs_read_failed' };
  }
  const evidence = rows<ValidationEvidence>(evidenceRead.data);

  // The same IssueObjects the Validator tab renders.
  const issues = resolveProjectIssueObjects({
    projectId: query.projectId,
    findings,
    evidence,
    decisions: rows<ProjectDecisionRow>(decisionsRead.data),
    executionItems: rows<ProjectExecutionItemRow>(executionRead.data),
    documents,
  });

  // The same preferred-extraction choice the Validator and the document route make.
  const extractionsByDocument = new Map<string, { document_id: string; created_at: string | null; data: Record<string, unknown> | null }[]>();
  for (const row of rows<{ document_id: string; created_at: string | null; data: Record<string, unknown> | null }>(extractionsRead.data)) {
    extractionsByDocument.set(row.document_id, [...(extractionsByDocument.get(row.document_id) ?? []), row]);
  }
  const reviewedValuesByDocument = new Map<string, DocumentReviewedValueState>();
  for (const documentId of documentIds) {
    const preferred = pickPreferredExtractionBlob(extractionsByDocument.get(documentId) ?? []);
    reviewedValuesByDocument.set(documentId, documentReviewedValueState({
      documentId,
      organizationId: query.organizationId,
      rows: assertionRead.rows,
      extractionData: preferred?.data ?? null,
    }));
  }

  const recoveryProposals: PendingRecoveryProposal[] = [];
  if (forgewingEnabled) {
    const readQueue = dependencies.readRecoveryQueue ?? readRecoveryReviewQueue;
    for (const documentId of documentIds) {
      const result = await readQueue({ organizationId: query.organizationId, sourceDocumentId: documentId },
        { admin: admin as never });
      if (result.status === 'read_failed') return { status: 'read_failed', reason: 'recovery_queue_read_failed' };
      if (result.status !== 'ok') continue;
      for (const candidate of result.candidates) {
        recoveryProposals.push({
          proposalId: candidate.proposalId,
          proposalDigestSha256: candidate.proposalDigestSha256,
          recoveryType: candidate.recoveryType,
          physicalPageNumber: candidate.physicalPageNumber,
          sourceDocumentId: candidate.sourceDocumentId,
          recoveryReason: candidate.recoveryReason,
          proposedValue: candidate.proposedValue,
          certainty: candidate.certainty,
          reviewState: candidate.reviewState,
          evidence: candidate.evidence.map((entry) => ({ observationId: entry.observationId, rawText: entry.rawText })),
        });
      }
    }
  }

  return {
    status: 'ok',
    queue: buildResolutionQueue({
      projectId: query.projectId,
      documents,
      issues,
      evidence,
      reviewedValuesByDocument,
      recoveryProposals,
      forgewingEnabled,
    }),
  };
}

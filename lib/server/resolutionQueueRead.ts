import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { investigateCase } from '@/lib/resolution/caseInvestigation';
import { resolveInvestigationContext } from '@/lib/resolution/investigationContext';
import { loadProjectDocumentPrecedenceSnapshot, type ProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { buildInvestigationSources } from '@/lib/server/investigationSources';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import {
  currentDocumentEvidenceFromExtractionData,
  documentReviewedValueState,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { documentPageFrames, type DocumentPageFrames } from '@/lib/recovery/diagnosticVisualEvidence';
import { recoveryCandidateVisualEvidence } from '@/lib/recovery/recoveryVisualEvidence';
import type { ProjectDecisionRow } from '@/lib/projectOverview';
import {
  buildResolutionQueue,
  type DocumentEvidenceAttention,
  type DocumentReviewedValueState,
  type PendingRecoveryProposal,
  type RecoveryConfirmationOption,
  type ResolutionQueue,
} from '@/lib/resolution/resolutionCases';
import { resolveProjectIssueObjects } from '@/lib/resolveProjectIssueObjects';
import { documentEvidenceAttention } from '@/lib/server/documentEvidenceAttention';
import { resolveForgewingEntitlement, type OrganizationForgewingEntitlementResolver } from '@/lib/server/forgewingEntitlement';
import { readRecoveryReviewQueue, type RecoveryReviewCandidate } from '@/lib/server/forgewingRecoveryReviewRead';
import { loadRegionBoundAssertionRows, type RegionAssertionClient } from '@/lib/server/regionBoundHumanAssertions';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { addValueReadingsToResolutionQueue } from '@/lib/server/valueReadingWorkspace';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

/**
 * Server read for the resolution queue (B5-A). Read-only: it loads existing
 * records and hands them to the pure builder. It writes nothing.
 *
 * Forgewing suggestion sources (recovery proposals) are read only for an
 * organization entitled to Core + Forgewing (the kill switch AND its latest
 * entitlement event). Everything else is EightForge Core, identical in both
 * tiers.
 */

const DECISION_SELECT = 'id, document_id, project_id, source, decision_type, title, summary, severity, status, '
  + 'confidence, last_detected_at, created_at, updated_at, due_at, assigned_to, details';

export type ResolutionQueueReadResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{
      status: 'ok';
      queue: ResolutionQueue;
      /**
       * What the cases were derived from, per document: the preferred
       * extraction and the resolved reviewed-value state. Server-side only
       * (investigation context composes from it); never serialized.
       */
      sources?: Readonly<{
        extractionDataByDocument: ReadonlyMap<string, unknown>;
        reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState>;
      }>;
    }>;

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

/** The confirmations the review route accepts for this proposal, by exact id, with their evidence. */
function selectableConfirmations(candidate: RecoveryReviewCandidate): RecoveryConfirmationOption[] {
  return candidate.proposalVersion === 2
    ? candidate.selectableCandidates.map((entry) => ({
        field: 'confirmedCandidateId' as const,
        id: entry.candidateId,
        rawText: entry.composedRawText,
        proposed: entry.proposed,
        visual: recoveryCandidateVisualEvidence(candidate, entry.candidateId),
      }))
    : candidate.selectableObservations.map((entry) => ({
        field: 'confirmedObservationId' as const,
        id: entry.observationId,
        rawText: entry.rawText,
        proposed: entry.proposed,
        visual: recoveryCandidateVisualEvidence(candidate, entry.observationId),
      }));
}

export async function readResolutionQueue(
  query: Readonly<{ organizationId: string; projectId: string }>,
  dependencies: Readonly<{
    admin?: ResolutionReadClient | null;
    forgewingEnabled?: boolean;
    resolveEntitlement?: OrganizationForgewingEntitlementResolver;
    readRecoveryQueue?: typeof readRecoveryReviewQueue;
    loadPrecedence?: (query: { organizationId: string; projectId: string }) => Promise<ProjectDocumentPrecedenceSnapshot>;
  }> = {},
): Promise<ResolutionQueueReadResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as ResolutionReadClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const project = await admin.from('projects').select('id, organization_id')
    .eq('id', query.projectId).maybeSingle();
  if (project.error) return { status: 'read_failed', reason: 'project_read_failed' };
  const projectRow = project.data as { organization_id?: string } | null;
  if (!projectRow || projectRow.organization_id !== query.organizationId) return { status: 'not_found' };
  // Commercial capability only: it decides whether Forgewing suggestions are
  // listed, never what any case, value or finding is.
  const forgewingEnabled = dependencies.forgewingEnabled
    ?? (await (dependencies.resolveEntitlement ?? resolveForgewingEntitlement)(
      admin as never, query.organizationId)).entitled;

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
      : admin.from('document_extractions').select('id, document_id, created_at, data')
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
  type ExtractionRow = { id?: string; document_id: string; created_at: string | null; data: Record<string, unknown> | null };
  const extractionsByDocument = new Map<string, ExtractionRow[]>();
  const preferredExtractionByDocument = new Map<string, ExtractionRow | null>();
  for (const row of rows<ExtractionRow>(extractionsRead.data)) {
    extractionsByDocument.set(row.document_id, [...(extractionsByDocument.get(row.document_id) ?? []), row]);
  }
  const reviewedValuesByDocument = new Map<string, DocumentReviewedValueState>();
  const extractionDataByDocument = new Map<string, unknown>();
  const documentPages = new Map<string, DocumentPageFrames>();
  for (const documentId of documentIds) {
    const preferred = pickPreferredExtractionBlob(extractionsByDocument.get(documentId) ?? []);
    preferredExtractionByDocument.set(documentId, preferred ?? null);
    extractionDataByDocument.set(documentId, preferred?.data ?? null);
    const frames = documentPageFrames({
      extractionData: preferred?.data ?? null,
      sourceDocumentId: documentId,
      pageRepresentationDigestByPage:
        currentDocumentEvidenceFromExtractionData(preferred?.data ?? null).pageRepresentationDigestByPage,
    });
    if (frames) documentPages.set(documentId, frames);
    reviewedValuesByDocument.set(documentId, documentReviewedValueState({
      documentId,
      organizationId: query.organizationId,
      rows: assertionRead.rows,
      extractionData: preferred?.data ?? null,
    }));
  }

  const recoveryProposals: PendingRecoveryProposal[] = [];
  const recoveryCandidatesByDocument = new Map<string, RecoveryReviewCandidate[]>();
  if (forgewingEnabled) {
    const readQueue = dependencies.readRecoveryQueue ?? readRecoveryReviewQueue;
    for (const documentId of documentIds) {
      const result = await readQueue({ organizationId: query.organizationId, sourceDocumentId: documentId },
        { admin: admin as never });
      if (result.status === 'read_failed') return { status: 'read_failed', reason: 'recovery_queue_read_failed' };
      if (result.status !== 'ok') continue;
      recoveryCandidatesByDocument.set(documentId, [...result.candidates]);
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
          proposalVersion: candidate.proposalVersion,
          selectableConfirmations: selectableConfirmations(candidate),
          sourceEvidenceUnbound: candidate.sourceEvidenceBinding === 'unbound_identity_incomplete',
        });
      }
    }
  }

  // Evidence EightForge knows it could not read, refused to publish or could not
  // interpret: the same diagnostics the document panel shows, from the same
  // preferred extraction the rest of the queue reads. EightForge Core.
  const evidenceAttentionByDocument = new Map<string, DocumentEvidenceAttention>();
  for (const documentId of documentIds) {
    const preferred = preferredExtractionByDocument.get(documentId);
    if (!preferred?.data) continue;
    evidenceAttentionByDocument.set(documentId, documentEvidenceAttention({
      organizationId: query.organizationId,
      documentId,
      extraction: { id: preferred.id, created_at: preferred.created_at, data: preferred.data },
      proposals: recoveryCandidatesByDocument.get(documentId) ?? [],
    }));
  }

  const queue = buildResolutionQueue({
      projectId: query.projectId,
      documents,
      issues,
      evidence,
      reviewedValuesByDocument,
      recoveryProposals,
      forgewingEnabled,
      documentPages,
      evidenceAttentionByDocument,
    });
  const sources = { extractionDataByDocument, reviewedValuesByDocument };
  let withReadings = queue;
  if (forgewingEnabled) {
    try {
      withReadings = await addValueReadingsToResolutionQueue(admin as never,
        { organizationId: query.organizationId, queue, extractionDataByDocument, assertions: assertionRead.rows });
    } catch {
      // Optional Forgewing reads fail closed while manual Core review remains available.
      withReadings = queue;
    }
  }
  return { status: 'ok', sources, queue: await investigateQueue(admin, query, withReadings, sources, dependencies.loadPrecedence) };
}

/**
 * Every case arrives already investigated: EightForge's deterministic
 * investigation reads each case's context locally, sends nothing anywhere and
 * writes nothing, so it runs for every organization with no gate. Precedence
 * is context, not authority: if it cannot be read, its absence is recorded.
 */
async function investigateQueue(
  admin: ResolutionReadClient,
  query: Readonly<{ organizationId: string; projectId: string }>,
  queue: ResolutionQueue,
  sources: Readonly<{ extractionDataByDocument: ReadonlyMap<string, unknown>; reviewedValuesByDocument: ReadonlyMap<string, DocumentReviewedValueState> }>,
  loadPrecedence?: (query: { organizationId: string; projectId: string }) => Promise<ProjectDocumentPrecedenceSnapshot>,
): Promise<ResolutionQueue> {
  let precedence: ProjectDocumentPrecedenceSnapshot | null = null;
  try {
    precedence = await (loadPrecedence ?? ((params) => loadProjectDocumentPrecedenceSnapshot(admin as never, params)))(query);
  } catch {
    precedence = null;
  }
  return {
    ...queue,
    cases: queue.cases.map((resolutionCase) => {
      const context = resolveInvestigationContext(resolutionCase, buildInvestigationSources({
        resolutionCase, cases: queue.cases, precedence, ...sources,
      }), { purpose: 'deterministic_investigation', contentPolicy: { approvedContentClasses: [] },
        budget: { maxTransmittedTextChars: 0 } });
      return { ...resolutionCase, investigation: investigateCase(resolutionCase, context) };
    }),
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyQuestion } from '@/lib/ask/classifier';
import {
  loadDecisions,
  loadFactsByFieldKeys,
  loadProjectDocuments,
  loadValidatorFindings,
} from '@/lib/ask/retrieval';
import type { AskProjectRecord } from '@/lib/ask/types';
import type { ContextSectionKind, ProjectContextPlan } from '@/lib/projectIntelligence/contextPlan';
import { factKeysForFindings } from '@/lib/projectIntelligence/evidenceAssessment';
import type { ProjectContextSources } from '@/lib/projectIntelligence/projectContext';
import { TRANSACTION_CONTEXT_BOUNDS } from '@/lib/projectIntelligence/transactionContext';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';
import { readProjectReviewedTruth } from '@/lib/server/reviewedTruthRead';
import { readTransactionSummariesForProject } from '@/lib/server/transactionDataPersistence';

/**
 * Server read of the sources one context plan names. Composes the existing
 * scoped loaders and resolvers, recomputes nothing, writes nothing. A section the
 * plan does not name is not read at all.
 *
 * Tenant and project scope: the caller has already resolved the project through
 * the actor's organization, and every read below is bound to that organization or
 * to that project. Anything that comes back for another project stops the request
 * rather than being filtered, because it means the scoping itself is wrong.
 *
 * A failed read of one section becomes `null`, never an empty list: "could not
 * read the documents" must not look like "the project has no documents".
 */

export class ProjectIntelligenceScopeError extends Error {
  constructor() {
    super('Project intelligence read returned records from another project.');
    this.name = 'ProjectIntelligenceScopeError';
  }
}

export type ProjectIntelligenceProjectRow = Readonly<{
  id: string;
  name: string;
  validation_status: string | null;
  validation_summary_json: unknown;
}>;

export type ProjectIntelligenceReadDependencies = Readonly<{
  loadFindings?: typeof loadValidatorFindings;
  loadDocuments?: typeof loadProjectDocuments;
  loadPrecedence?: typeof loadProjectDocumentPrecedenceSnapshot;
  loadFacts?: typeof loadFactsByFieldKeys;
  loadDecisions?: typeof loadDecisions;
  readReviewedTruth?: typeof readProjectReviewedTruth;
  readTransactions?: typeof readTransactionSummariesForProject;
}>;

export type ProjectIntelligenceReadResult =
  | Readonly<{ status: 'ok'; sources: ProjectContextSources }>
  | Readonly<{ status: 'focus_finding_not_found' }>;

async function settled<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ProjectIntelligenceScopeError) throw error;
    // By class only: never the question, a title or a provider message.
    console.warn('[projectIntelligence] section_read_failed', { errorClass: error instanceof Error ? error.name : typeof error });
    return null;
  }
}

export async function readProjectIntelligenceSources(
  params: Readonly<{
    admin: SupabaseClient;
    organizationId: string;
    project: ProjectIntelligenceProjectRow;
    question: string;
    plan: ProjectContextPlan;
  }>,
  dependencies: ProjectIntelligenceReadDependencies = {},
): Promise<ProjectIntelligenceReadResult> {
  const { admin, organizationId, project, plan } = params;
  const projectId = project.id;
  const planned = (kind: ContextSectionKind) => plan.sections.includes(kind);
  const question = classifyQuestion(params.question);
  const askProject: AskProjectRecord = {
    id: projectId, name: project.name, validationStatus: project.validation_status, validationSummary: project.validation_summary_json,
  };

  // Every plan reads findings first: the facts it needs depend on them.
  const findingsRead = await settled(() => (dependencies.loadFindings ?? loadValidatorFindings)({
    admin, projectId, orgId: organizationId, question, project: askProject,
  }));
  const open = findingsRead?.all ?? null;
  if (plan.focusFindingId != null && open != null && !open.some((finding) => finding.id === plan.focusFindingId)) {
    return { status: 'focus_finding_not_found' };
  }

  const [documentsRead, precedence, decisions, transactions] = await Promise.all([
    planned('documents')
      ? settled(() => (dependencies.loadDocuments ?? loadProjectDocuments)({ admin, projectId, orgId: organizationId, question }))
      : undefined,
    planned('document_relationships')
      ? settled(async () => {
        const snapshot = await (dependencies.loadPrecedence ?? loadProjectDocumentPrecedenceSnapshot)(admin, { organizationId, projectId });
        const foreign = snapshot.documents.some((document) => document.project_id !== projectId)
          || snapshot.relationships.some((relationship) => relationship.project_id != null && relationship.project_id !== projectId);
        if (foreign) throw new ProjectIntelligenceScopeError();
        return snapshot;
      })
      : undefined,
    planned('operator_decisions')
      ? settled(() => (dependencies.loadDecisions ?? loadDecisions)({ admin, projectId, orgId: organizationId, question }))
      : undefined,
    planned('transaction_context')
      ? settled(async () => {
        const summaries = await (dependencies.readTransactions ?? readTransactionSummariesForProject)({
          admin, projectId, limit: TRANSACTION_CONTEXT_BOUNDS.maxDatasets,
        });
        if (summaries.datasets.some((dataset) => dataset.projectId !== projectId)) throw new ProjectIntelligenceScopeError();
        return summaries;
      })
      : undefined,
  ]);

  const documents = documentsRead === undefined ? undefined : documentsRead?.all ?? null;
  const focus = open?.filter((finding) => plan.focusFindingId == null || finding.id === plan.focusFindingId) ?? [];
  const [facts, reviewedTruth] = await Promise.all([
    planned('canonical_facts')
      ? settled(async () => {
        const fieldKeys = factKeysForFindings(focus);
        if (fieldKeys.length === 0) return [];
        const read = await (dependencies.loadFacts ?? loadFactsByFieldKeys)({
          admin, projectId, orgId: organizationId, fieldKeys, project: askProject,
        });
        return read.facts;
      })
      : undefined,
    planned('reviewed_truth')
      ? settled(() => (dependencies.readReviewedTruth ?? readProjectReviewedTruth)(admin as never, {
        organizationId, documentIds: documents?.map((document) => document.id) ?? [],
      }))
      : undefined,
  ]);

  return {
    status: 'ok',
    sources: {
      project: { id: projectId, name: project.name, validationStatus: project.validation_status },
      findings: open ? { open, latestRunAt: findingsRead?.latestRunAt ?? null } : null,
      ...(documents !== undefined ? { documents } : {}),
      ...(precedence !== undefined ? { precedence: precedence ? { families: precedence.families, relationships: precedence.relationships } : null } : {}),
      ...(facts !== undefined ? { facts } : {}),
      ...(reviewedTruth !== undefined ? { reviewedTruth } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
      ...(transactions !== undefined ? { transactions } : {}),
    },
  };
}

/** What the catalogue's route resolver needs about one finding. */
export function primaryFindingActionContext(sources: ProjectContextSources, findingId: string | null) {
  const finding = findingId ? sources.findings?.open.find((entry) => entry.id === findingId) : null;
  if (!finding) return null;
  return {
    subjectId: finding.subjectId ?? null,
    evidenceDocumentIds: [...(finding.documentId ? [finding.documentId] : []), ...(finding.evidenceDocumentIds ?? [])],
    page: finding.page ?? null,
  };
}

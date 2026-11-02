import { hashCanonical } from '@/lib/extraction/domain/hash';
import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';
import type { AskDocument, DecisionRecord, StructuredFact, ValidatorFinding } from '@/lib/ask/types';
import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import {
  CONTEXT_SECTION_KINDS,
  PROJECT_CONTEXT_BOUNDS,
  type ContextSectionKind,
  type ProjectContextPlan,
} from '@/lib/projectIntelligence/contextPlan';
import {
  TRANSACTION_CONTEXT_BOUNDS,
  transactionFindingCounts,
  type ProjectTransactionSummaries,
  type TransactionContextPayload,
} from '@/lib/projectIntelligence/transactionContext';

/**
 * The unified project context: a read-only, request-scoped view over truth that
 * existing resolvers already produced (conceptually the Forgewing project
 * context). It is not a store and it computes no fact. It follows the same
 * discipline as the per-case investigation context: every section says where it
 * came from, every record is citable, and every section the plan named but could
 * not supply or send is listed with its reason.
 *
 * Pure. The server read supplies the sources; this assembles them.
 */

export type ProjectContextRecord = Readonly<{
  recordId: string;
  label: string;
  documentId: string | null;
  page: number | null;
}>;

export type ProjectContextSectionSource =
  | 'projects'
  | 'project_validation_findings'
  | 'documents'
  | 'document_precedence'
  | 'canonical_and_document_facts'
  | 'human_fact_assertions'
  | 'decisions'
  | 'transaction_data_datasets';

export type ProjectContextSection = Readonly<{
  kind: ContextSectionKind;
  /** Customer text is `text_excerpts`; ids and relationship types are `metadata`. */
  contentClass: 'text_excerpts' | 'metadata';
  provenance: Readonly<{ source: ProjectContextSectionSource; projectId: string; recordIds: readonly string[] }>;
  records: readonly ProjectContextRecord[];
  transmitted: boolean;
  payload: unknown;
}>;

export type ProjectContextOmissionReason =
  /** The plan for this intent does not use the section. Never read. */
  | 'not_in_plan'
  /** Planned, but EightForge holds no such record. */
  | 'not_available'
  /** Planned, but the read failed: absence here proves nothing. */
  | 'read_failed'
  /** Read, but the data-policy ledger did not approve its content class for this request. */
  | 'content_class_not_approved'
  /** Read, but the transmission budget was spent by higher-priority sections. */
  | 'over_budget';

export type ProjectContextOmission = Readonly<{ kind: ContextSectionKind; reason: ProjectContextOmissionReason }>;

export type ProjectIntelligenceContext = Readonly<{
  organizationId: string;
  projectId: string;
  plan: ProjectContextPlan;
  sections: readonly ProjectContextSection[];
  omissions: readonly ProjectContextOmission[];
  /** Digest of exactly what would be transmitted. */
  transmittedDigest: string;
  /** Digest of every section read: the same evidence always yields the same digest. */
  readDigest: string;
}>;

export type ProjectIntelligenceProject = Readonly<{
  id: string;
  name: string;
  validationStatus: string | null;
}>;

/** What the server read. A key absent means not read; null means the read failed. */
export type ProjectContextSources = Readonly<{
  project: ProjectIntelligenceProject;
  findings?: Readonly<{ open: readonly ValidatorFinding[]; latestRunAt: string | null }> | null;
  documents?: readonly AskDocument[] | null;
  precedence?: Readonly<{
    families: readonly ResolvedDocumentPrecedenceFamily[];
    relationships: readonly DocumentRelationshipRecord[];
  }> | null;
  facts?: readonly StructuredFact[] | null;
  reviewedTruth?: Readonly<{
    effective: readonly Readonly<{ documentId: string; factKey: string; value: unknown; assertionId: string; physicalPageNumber: number }>[];
    held: readonly Readonly<{ documentId: string; factKey: string; reason: string; assertionIds: readonly string[] }>[];
  }> | null;
  decisions?: readonly DecisionRecord[] | null;
  transactions?: ProjectTransactionSummaries | null;
}>;

export type ProjectContextTransmissionPolicy = Readonly<{
  approvedContentClasses: readonly 'text_excerpts'[];
  maxTransmittedTextChars?: number;
}>;

/** Nothing leaves EightForge: the deterministic path reads every section locally. */
export const LOCAL_ONLY_POLICY: ProjectContextTransmissionPolicy = Object.freeze({ approvedContentClasses: [] });

type Candidate = Omit<ProjectContextSection, 'transmitted' | 'provenance'> & Readonly<{ source: ProjectContextSectionSource }>;

function severityRank(severity: string): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}

/** Stable: severity, then whether it blocks, then id. The focus finding is always kept. */
export function orderFindings(findings: readonly ValidatorFinding[], focusFindingId: string | null): ValidatorFinding[] {
  return [...findings].sort((left, right) =>
    Number(right.id === focusFindingId) - Number(left.id === focusFindingId)
    || severityRank(left.severity) - severityRank(right.severity)
    || Number(right.blocksProject) - Number(left.blocksProject)
    || left.id.localeCompare(right.id, 'en-US'));
}

function identitySection(project: ProjectIntelligenceProject): Candidate {
  return {
    kind: 'project_identity', contentClass: 'text_excerpts', source: 'projects',
    records: [{ recordId: project.id, label: project.name, documentId: null, page: null }],
    payload: { name: project.name, validationStatus: project.validationStatus },
  };
}

function findingsSection(value: NonNullable<ProjectContextSources['findings']>, focus: string | null): Candidate | null {
  const bounded = orderFindings(value.open, focus).slice(0, PROJECT_CONTEXT_BOUNDS.maxFindings);
  return {
    kind: 'validator_findings', contentClass: 'text_excerpts', source: 'project_validation_findings',
    records: bounded.map((finding) => ({
      recordId: finding.id,
      label: validatorRuleExplanation(finding.ruleId)?.title ?? finding.description,
      documentId: finding.documentId ?? null,
      page: finding.page ?? null,
    })),
    payload: {
      openFindingCount: value.open.length,
      latestValidationRunAt: value.latestRunAt,
      findings: bounded.map((finding) => {
        // The catalogue is the authoritative explanation of a rule; never restated by hand.
        const rule = validatorRuleExplanation(finding.ruleId);
        return {
          id: finding.id, severity: finding.severity, blocksProject: finding.blocksProject,
          title: rule?.title ?? null, whatItChecks: rule?.explanation ?? null, requiredAction: rule?.requiredAction ?? null,
          description: finding.description, field: finding.field ?? null,
          expected: finding.expected ?? null, actual: finding.actual ?? null,
          documentId: finding.documentId ?? null, documentName: finding.documentName ?? null,
          page: finding.page ?? null, snippet: finding.snippet ?? null, linkedDecisionId: finding.linkedDecisionId ?? null,
        };
      }),
    },
  };
}

function resolvedDocuments(sources: ProjectContextSources) {
  return (sources.precedence?.families ?? []).flatMap((family) => family.documents);
}

function documentsSection(sources: ProjectContextSources): Candidate | null {
  const documents = sources.documents;
  if (!documents || documents.length === 0) return null;
  const resolvedById = new Map(resolvedDocuments(sources).map((document) => [document.id, document]));
  const bounded = documents.slice(0, PROJECT_CONTEXT_BOUNDS.maxDocuments);
  return {
    kind: 'documents', contentClass: 'text_excerpts', source: 'documents',
    records: bounded.map((document) => ({ recordId: document.id, label: document.title, documentId: document.id, page: null })),
    payload: {
      totalDocumentCount: documents.length,
      documents: bounded.map((document) => {
        const resolved = resolvedById.get(document.id);
        return {
          id: document.id, title: document.title, documentType: document.documentType ?? null,
          processingStatus: document.processingStatus ?? null, processedAt: document.processedAt ?? null,
          family: resolved?.family ?? null, subtype: resolved?.resolved_subtype ?? null,
          authorityStatus: resolved?.authority_status ?? null, isGoverning: resolved?.is_governing ?? null,
        };
      }),
    },
  };
}

function relationshipsSection(sources: ProjectContextSources): Candidate | null {
  const precedence = sources.precedence;
  if (!precedence) return null;
  const bounded = precedence.relationships.slice(0, PROJECT_CONTEXT_BOUNDS.maxRelationships);
  return {
    kind: 'document_relationships', contentClass: 'metadata', source: 'document_precedence',
    records: bounded.flatMap((relationship) => relationship.id
      ? [{ recordId: relationship.id, label: `Document link: ${relationship.relationship_type}`, documentId: relationship.source_document_id, page: null }]
      : []),
    payload: {
      governing: precedence.families.map((family) => ({
        family: family.family, governingDocumentId: family.governing_document_id, reason: family.governing_reason,
      })),
      relationships: bounded.map((relationship) => ({
        id: relationship.id ?? null, type: relationship.relationship_type,
        sourceDocumentId: relationship.source_document_id, targetDocumentId: relationship.target_document_id,
      })),
    },
  };
}

function factsSection(facts: readonly StructuredFact[]): Candidate | null {
  if (facts.length === 0) return null;
  const bounded = facts.slice(0, PROJECT_CONTEXT_BOUNDS.maxFacts);
  return {
    kind: 'canonical_facts', contentClass: 'text_excerpts', source: 'canonical_and_document_facts',
    records: bounded.map((fact) => ({
      recordId: fact.id, label: fact.documentName ? `${fact.label} (${fact.documentName})` : fact.label,
      documentId: fact.extractedFrom ?? null, page: fact.page ?? null,
    })),
    payload: bounded.map((fact) => ({
      id: fact.id, label: fact.label, fieldKey: fact.fieldKey ?? null, value: fact.value, unit: fact.unit ?? null,
      documentId: fact.extractedFrom ?? null, documentName: fact.documentName ?? null, page: fact.page ?? null,
      sourceKind: fact.sourceKind ?? null,
    })),
  };
}

function reviewedSection(value: NonNullable<ProjectContextSources['reviewedTruth']>): Candidate | null {
  if (value.effective.length === 0 && value.held.length === 0) return null;
  const effective = value.effective.slice(0, PROJECT_CONTEXT_BOUNDS.maxReviewedValues);
  const held = value.held.slice(0, PROJECT_CONTEXT_BOUNDS.maxReviewedValues);
  return {
    kind: 'reviewed_truth', contentClass: 'text_excerpts', source: 'human_fact_assertions',
    records: [
      ...effective.map((entry) => ({ recordId: entry.assertionId, label: `Reviewed value: ${entry.factKey}`, documentId: entry.documentId, page: entry.physicalPageNumber })),
      ...held.flatMap((entry) => entry.assertionIds.map((id) => ({ recordId: id, label: `Held review: ${entry.factKey}`, documentId: entry.documentId, page: null }))),
    ],
    payload: {
      appliedReviewedValues: effective.map((entry) => ({ documentId: entry.documentId, factKey: entry.factKey, value: entry.value })),
      heldReviews: held.map((entry) => ({ documentId: entry.documentId, factKey: entry.factKey, reason: entry.reason })),
    },
  };
}

function decisionsSection(decisions: readonly DecisionRecord[]): Candidate | null {
  if (decisions.length === 0) return null;
  const bounded = decisions.slice(0, PROJECT_CONTEXT_BOUNDS.maxDecisions);
  return {
    kind: 'operator_decisions', contentClass: 'text_excerpts', source: 'decisions',
    records: bounded.map((decision) => ({ recordId: decision.id, label: decision.title, documentId: decision.documentId ?? null, page: null })),
    payload: bounded.map((decision) => ({
      id: decision.id, title: decision.title, status: decision.status, severity: decision.severity,
      summary: decision.summary, documentId: decision.documentId ?? null,
    })),
  };
}

function transactionSection(value: ProjectTransactionSummaries, open: readonly ValidatorFinding[]): Candidate | null {
  if (value.datasets.length === 0) return null;
  const datasets = value.datasets.slice(0, TRANSACTION_CONTEXT_BOUNDS.maxDatasets);
  const counts = transactionFindingCounts(open);
  const flagged = datasets.flatMap((dataset) => dataset.flaggedReviews.flatMap((review) =>
    review.flaggedRecordIds.map((recordId) => ({ recordId, label: `${review.label}: flagged line`, documentId: dataset.documentId, page: null }))))
    .slice(0, TRANSACTION_CONTEXT_BOUNDS.maxFlaggedRecords);
  const findings = orderFindings(open.filter((finding) => counts.some((entry) => entry.findingIds.includes(finding.id))), null)
    .slice(0, TRANSACTION_CONTEXT_BOUNDS.maxFindingRecords);
  const citable = new Set(flagged.map((record) => record.recordId));
  const payload: TransactionContextPayload = {
    totalDatasetCount: value.totalDatasetCount,
    datasets: datasets.map((dataset) => ({ ...dataset, flaggedReviews: dataset.flaggedReviews.map((review) => ({
      ...review, flaggedRecordIds: review.flaggedRecordIds.filter((recordId) => citable.has(recordId)),
    })) })),
    openFindings: counts.map(({ group, count }) => ({ group, count })),
  };
  return {
    kind: 'transaction_context', contentClass: 'text_excerpts', source: 'transaction_data_datasets',
    records: [
      ...datasets.map((dataset) => ({ recordId: dataset.id, label: 'Ticket data upload', documentId: dataset.documentId, page: null })),
      ...findings.map((finding) => ({
        recordId: finding.id, label: validatorRuleExplanation(finding.ruleId)?.title ?? finding.description,
        documentId: finding.documentId ?? null, page: finding.page ?? null,
      })),
      ...flagged,
    ],
    payload,
  };
}

function candidate(kind: ContextSectionKind, sources: ProjectContextSources, focus: string | null): Candidate | null | 'read_failed' {
  switch (kind) {
    case 'project_identity':
      return identitySection(sources.project);
    case 'validator_findings':
      return sources.findings ? findingsSection(sources.findings, focus) : 'read_failed';
    case 'documents':
      return sources.documents ? documentsSection(sources) : 'read_failed';
    case 'document_relationships':
      return sources.precedence ? relationshipsSection(sources) : 'read_failed';
    case 'canonical_facts':
      return sources.facts ? factsSection(sources.facts) : 'read_failed';
    case 'reviewed_truth':
      return sources.reviewedTruth ? reviewedSection(sources.reviewedTruth) : 'read_failed';
    case 'operator_decisions':
      return sources.decisions ? decisionsSection(sources.decisions) : 'read_failed';
    case 'transaction_context':
      return sources.transactions ? transactionSection(sources.transactions, sources.findings?.open ?? []) : 'read_failed';
  }
}

function digests(projectId: string, sections: readonly ProjectContextSection[]) {
  const identity = (section: ProjectContextSection) => ({ kind: section.kind, provenance: section.provenance, payload: section.payload });
  return {
    transmittedDigest: hashCanonical({ version: 'project_intelligence_context_v1', projectId,
      transmitted: sections.filter((section) => section.transmitted).map(identity) }),
    readDigest: hashCanonical({ version: 'project_intelligence_context_v1', projectId, read: sections.map(identity) }),
  };
}

export function assembleProjectContext(
  params: Readonly<{ organizationId: string; plan: ProjectContextPlan; sources: ProjectContextSources; policy: ProjectContextTransmissionPolicy }>,
): ProjectIntelligenceContext {
  const { plan, sources, policy } = params;
  const projectId = sources.project.id;
  const planned = new Set(plan.sections);
  const approved = new Set<string>(policy.approvedContentClasses);
  let budget = Math.max(0, policy.maxTransmittedTextChars ?? PROJECT_CONTEXT_BOUNDS.maxTransmittedTextChars);
  const sections: ProjectContextSection[] = [];
  const omissions: ProjectContextOmission[] = CONTEXT_SECTION_KINDS
    .filter((kind) => !planned.has(kind)).map((kind) => ({ kind, reason: 'not_in_plan' as const }));
  for (const kind of plan.sections) {
    const built = candidate(kind, sources, plan.focusFindingId);
    if (built === 'read_failed' || built === null) {
      omissions.push({ kind, reason: built === 'read_failed' ? 'read_failed' : 'not_available' });
      continue;
    }
    const { source, ...rest } = built;
    const provenance = { source, projectId, recordIds: [...new Set(rest.records.map((record) => record.recordId))] };
    // Metadata travels only alongside approved content, as in the investigation context.
    const classApproved = rest.contentClass === 'metadata' ? approved.size > 0 : approved.has(rest.contentClass);
    let transmitted = false;
    if (approved.size > 0 && !classApproved) {
      omissions.push({ kind, reason: 'content_class_not_approved' });
    } else if (classApproved) {
      const size = JSON.stringify(rest.payload ?? null).length;
      if (size > budget) {
        omissions.push({ kind, reason: 'over_budget' });
      } else {
        budget -= size;
        transmitted = true;
      }
    }
    sections.push({ ...rest, provenance, transmitted });
  }
  return { organizationId: params.organizationId, projectId, plan, sections, omissions, ...digests(projectId, sections) };
}

/** Every citable record in the context, by id. A citation that is not here does not resolve. */
export function contextRecordIndex(context: ProjectIntelligenceContext) {
  const index = new Map<string, ProjectContextRecord & Readonly<{ sectionKind: ContextSectionKind }>>();
  for (const section of context.sections) {
    for (const record of section.records) {
      if (!index.has(record.recordId)) index.set(record.recordId, { ...record, sectionKind: section.kind });
    }
  }
  return index;
}

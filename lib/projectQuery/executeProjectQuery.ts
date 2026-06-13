import { buildProjectQueryResult, projectQueryMissing } from '@/lib/projectQuery/buildResult';
import { dedupeSignalEvidence } from '@/lib/projectQuery/evidenceDedupe';
import { parseProjectQueryIntent } from '@/lib/projectQuery/intent';
import { truthPayloadToProjectResult } from '@/lib/projectQuery/normalizeTruthResponse';
import type { EvidenceAnchor, ProjectQueryResult } from '@/lib/projectQuery/types';
import type { ProjectDecisionRow, ProjectDocumentRow, ProjectTaskRow } from '@/lib/projectOverview';
import { parseTruthQuery, type TruthQueryType, type TruthResultPayload } from '@/lib/truthQuery';
import type { ValidationStatus } from '@/types/validator';

export type ProjectQueryContext = {
  validatorStatus?: ValidationStatus;
  criticalFindings?: number;
  documents?: ProjectDocumentRow[];
  decisions?: ProjectDecisionRow[];
  tasks?: ProjectTaskRow[];
};

/** Injected port so execution can run client-side (fetch) or server-side (direct engine) later. */
export type TruthQueryPort = (
  projectId: string,
  type: TruthQueryType,
  value: string,
) => Promise<TruthResultPayload | null>;

function docHref(projectId: string, documentId: string): string {
  return `/platform/documents/${documentId}?source=project&projectId=${encodeURIComponent(projectId)}`;
}

function decisionHref(decisionId: string): string {
  return `/platform/decisions/${decisionId}`;
}

function taskHref(task: ProjectTaskRow): string {
  if (task.decision_id) return decisionHref(task.decision_id);
  return `/platform/workflows/${task.id}`;
}

function validatorSectionHref(projectId: string): string {
  return `/platform/projects/${encodeURIComponent(projectId)}#project-validator`;
}

function listBlockedDocuments(projectId: string, documents: ProjectDocumentRow[]): ProjectQueryResult {
  const blocked = documents.filter(
    (d) => d.processing_status === 'blocked' || d.processing_status === 'failed',
  );
  const evidence: EvidenceAnchor[] = blocked.slice(0, 8).map((d) => ({
    label: d.title ?? d.name,
    href: docHref(projectId, d.id),
    locator: (d.document_type ?? 'Document').toUpperCase(),
    snippet: `Status: ${d.processing_status}${d.processing_error ? ` · ${d.processing_error}` : ''}`,
    sourceId: `document:${d.id}`,
    sourceKind: 'document',
  }));

  if (blocked.length === 0) {
    return buildProjectQueryResult({
      projectId,
      type: 'LIST',
      status: 'Verified',
      result: 'No project documents are in blocked or failed processing state.',
      evidence: [],
      nextAction: null,
      confidenceLevel: 'HIGH',
      sourceIds: [],
      precedenceApplied: false,
    });
  }

  return buildProjectQueryResult({
    projectId,
    type: 'LIST',
    status: 'Signal',
    result: `${blocked.length} project document(s) in blocked or failed processing state.`,
    evidence,
    nextAction: 'Open each linked document and resolve processing errors or re-run extraction.',
    confidenceLevel: 'HIGH',
    sourceIds: blocked.map((d) => d.id),
    precedenceApplied: false,
  });
}

function signalResultSummary(evidence: EvidenceAnchor[]): string {
  const parts: string[] = [];
  if (evidence.some((e) => e.sourceId === 'signal:validator:blocked')) {
    parts.push('Validator blocks approval pending verification');
  }
  if (evidence.some((e) => e.sourceId === 'signal:validator:findings_open')) {
    parts.push('Open validator findings affect approval readiness');
  }
  if (evidence.some((e) => e.sourceId === 'signal:validator:critical_count')) {
    const row = evidence.find((e) => e.sourceId === 'signal:validator:critical_count');
    const n = row?.locator?.replace(/^count:/, '') ?? '';
    if (n) parts.push(`${n} critical finding(s) on record`);
  }
  const decisionCount = evidence.filter((e) => e.sourceId?.startsWith('decision:')).length;
  if (decisionCount > 0) {
    parts.push(`${decisionCount} open critical decision(s)`);
  }
  const taskCount = evidence.filter((e) => e.sourceId?.startsWith('task:')).length;
  if (taskCount > 0) {
    parts.push(`${taskCount} blocked workflow task(s) on decision path`);
  }
  const docCount = evidence.filter((e) => e.sourceId?.startsWith('document:')).length;
  if (docCount > 0) {
    parts.push(`${docCount} document(s) blocked or failed processing`);
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : '';
}

/**
 * SIGNAL: material blockers, exposure/verification gates, etc.
 * Evidence is deduped by decision id, rule id, or source id before render.
 */
function materialSignals(projectId: string, context: ProjectQueryContext): ProjectQueryResult {
  const docs = context.documents ?? [];
  const decisions = context.decisions ?? [];
  const tasks = context.tasks ?? [];
  const validatorStatus = context.validatorStatus;
  const criticalFindings = context.criticalFindings ?? 0;

  const evidence: EvidenceAnchor[] = [];

  if (validatorStatus === 'BLOCKED') {
    evidence.push({
      label: 'Project validation gate',
      href: validatorSectionHref(projectId),
      locator: 'BLOCKED',
      snippet: 'Approval path blocked until verification findings are cleared.',
      sourceId: 'signal:validator:blocked',
      sourceKind: 'validator',
    });
  } else if (validatorStatus === 'FINDINGS_OPEN') {
    evidence.push({
      label: 'Project validation gate',
      href: validatorSectionHref(projectId),
      locator: 'FINDINGS_OPEN',
      snippet: 'Open validator findings require resolution before a clean approval signal.',
      sourceId: 'signal:validator:findings_open',
      sourceKind: 'validator',
    });
  }

  if (criticalFindings > 0) {
    evidence.push({
      label: 'Critical validator findings',
      href: validatorSectionHref(projectId),
      locator: `count:${criticalFindings}`,
      snippet: `${criticalFindings} critical finding(s) recorded on the project validation summary.`,
      sourceId: 'signal:validator:critical_count',
      sourceKind: 'validator',
    });
  }

  const criticalOpen = decisions.filter(
    (d) =>
      d.severity === 'critical' &&
      !['resolved', 'dismissed', 'suppressed'].includes(d.status),
  );
  for (const d of criticalOpen.slice(0, 5)) {
    evidence.push({
      label: d.title,
      href: decisionHref(d.id),
      locator: `Decision · ${d.status}`,
      snippet: d.summary ?? `Severity: ${d.severity}`,
      sourceId: `decision:${d.id}`,
      sourceKind: 'decision',
    });
  }

  const blockedWorkflowTasks = tasks.filter(
    (t) => t.status === 'blocked' && t.decision_id != null,
  );
  for (const t of blockedWorkflowTasks.slice(0, 5)) {
    evidence.push({
      label: t.title,
      href: taskHref(t),
      locator: `Task · blocked`,
      snippet: t.description ?? `Linked decision workflow · priority ${t.priority}`,
      sourceId: `task:${t.id}`,
      sourceKind: 'task',
    });
  }

  const failedOrBlockedDocs = docs.filter(
    (d) => d.processing_status === 'blocked' || d.processing_status === 'failed',
  );
  for (const doc of failedOrBlockedDocs.slice(0, 5)) {
    evidence.push({
      label: doc.title ?? doc.name,
      href: docHref(projectId, doc.id),
      locator: `Document · ${doc.processing_status}`,
      snippet: doc.processing_error ?? 'Processing did not complete; structured verification may be incomplete.',
      sourceId: `document:${doc.id}`,
      sourceKind: 'document',
    });
  }

  const deduped = dedupeSignalEvidence(evidence);

  if (deduped.length === 0) {
    return projectQueryMissing(projectId, 'SIGNAL');
  }

  const summary = signalResultSummary(deduped);
  const resultText =
    summary ||
    `${deduped
      .map((e) => e.label)
      .slice(0, 6)
      .join('; ')}.`;

  return buildProjectQueryResult({
    projectId,
    type: 'SIGNAL',
    status: 'Signal',
    result: resultText,
    evidence: deduped,
    nextAction:
      'Resolve items in Evidence in precedence order (validator gate, then critical decisions, then workflow tasks, then document processing).',
    confidenceLevel: 'MEDIUM',
    sourceIds: deduped.map((e) => e.sourceId).filter(Boolean) as string[],
    precedenceApplied: true,
  });
}

export async function executeProjectQuery(args: {
  projectId: string;
  input: string;
  context?: ProjectQueryContext;
  queryTruth: TruthQueryPort;
}): Promise<ProjectQueryResult> {
  const { projectId, input, context = {}, queryTruth } = args;

  const intent = parseProjectQueryIntent(input);
  if (!intent) return projectQueryMissing(projectId, 'FACT');

  const truthParsed = parseTruthQuery(intent.value);
  if (truthParsed) {
    const payload = await queryTruth(projectId, truthParsed.type, truthParsed.value);
    if (!payload) return projectQueryMissing(projectId, intent.type);
    return truthPayloadToProjectResult(projectId, intent.type, payload);
  }

  const docs = context.documents ?? [];

  if (intent.type === 'LIST') {
    if (
      /\b(blocked|failed)\b/.test(intent.normalized) &&
      /\b(doc|docs|document|documents)\b/.test(intent.normalized)
    ) {
      return listBlockedDocuments(projectId, docs);
    }
    return projectQueryMissing(projectId, intent.type);
  }

  if (intent.type === 'SIGNAL') {
    return materialSignals(projectId, context);
  }

  return projectQueryMissing(projectId, intent.type);
}

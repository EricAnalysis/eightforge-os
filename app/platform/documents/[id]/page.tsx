'use client';

import { use, useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  DocumentFactAnchorRecord,
} from '@/lib/documentFactAnchors';
import type {
  DocumentFactReviewRecord,
  DocumentFactReviewStatus,
} from '@/lib/documentFactReviews';
import type {
  DocumentFactOverrideActionType,
  DocumentFactOverrideRecord,
} from '@/lib/documentFactOverrides';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { isContractInvoicePrimaryDocumentType } from '@/lib/contractInvoicePrimary';
import {
  resolveDocumentDetailContext,
  type DocumentDetailContextMode,
} from '@/lib/documentNavigation';
import { DocumentProcessingStatus } from '@/components/DocumentProcessingStatus';
import type { DocumentDecision } from '@/lib/types/decisions';
import { buildDocumentIntelligence } from '@/lib/documentIntelligence';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { buildDocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { DocumentProjectControls } from '@/components/documents/DocumentProjectControls';
import { DocumentDetailExperience } from '@/components/document-intelligence/DocumentDetailExperience';
import type {
  DetectedEntity,
  DocumentExecutionTrace,
  DocumentSummary,
  GeneratedDecision,
  NormalizedDecision,
  ReviewErrorType,
  TriggeredWorkflowTask,
} from '@/lib/types/documentIntelligence';

// ─── Constants ────────────────────────────────────────────────────────────────


// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentDetail = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  status: string;
  created_at: string;
  storage_path: string;
  project_id: string | null;
  projects: { id: string; name: string } | { id: string; name: string }[] | null;
  processing_status?: string | null;
  processing_error?: string | null;
  processed_at?: string | null;
  domain?: string | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
  relatedDocs?: RelatedDocInput[];
  factOverrides?: DocumentFactOverrideRecord[];
  factAnchors?: DocumentFactAnchorRecord[];
  factReviews?: DocumentFactReviewRecord[];
};

type EvaluateResponse = {
  document_id: string;
  domain: string;
  document_type: string;
  facts_loaded: number;
  rules_evaluated: number;
  matched_rules: number;
  decisions_created: number;
  decisions_updated: number;
  decisions_skipped: number;
  tasks_created: number;
  tasks_skipped: number;
  processing_status: string;
  debug?: {
    extraction_row_count: number;
    derived_facts: Record<string, unknown>;
  };
};

type ExtractionRow = {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
};

type DecisionRow = Pick<
  DocumentDecision,
  'id' | 'decision_type' | 'decision_value' | 'confidence' | 'source' | 'created_at'
>;

type PersistentDecisionRow = {
  id: string;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};

type WorkflowTaskRow = {
  id: string;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  decision_id: string | null;
  source: string | null;
  source_metadata?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};

type FeedbackState = {
  status: 'correct' | 'incorrect';
  reviewErrorType?: ReviewErrorType | null;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function resolveProject(
  raw: DocumentDetail['projects'],
): { id: string; name: string } | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

type BreadcrumbItem = {
  label: string;
  href?: string;
};

function buildDocumentBreadcrumbs(params: {
  title: string;
  mode: DocumentDetailContextMode;
  project: { id: string; name: string } | null;
}): BreadcrumbItem[] {
  const { title, mode, project } = params;

  if (mode === 'project' && project) {
    return [
      { label: 'Workspace', href: '/platform/workspace' },
      { label: 'Projects', href: '/platform/projects' },
      { label: project.name, href: `/platform/projects/${project.id}` },
      { label: 'Documents', href: `/platform/projects/${project.id}#project-documents` },
      { label: title },
    ];
  }

  return [
    { label: 'Workspace', href: '/platform/workspace' },
    { label: 'Documents', href: '/platform/documents' },
    { label: title },
  ];
}

function documentContextBadgeLabel(mode: DocumentDetailContextMode): string {
  switch (mode) {
    case 'project':
      return 'Project Context';
    case 'documents':
      return 'Documents Context';
    default:
      return 'Direct Link';
  }
}

function documentContextDescription(
  mode: DocumentDetailContextMode,
  project: { id: string; name: string } | null,
): string {
  switch (mode) {
    case 'project':
      return project
        ? `Opened from ${project.name}. Return to the project overview to stay in the active workflow.`
        : 'Opened from a project workflow. Return to the project overview to stay anchored.';
    case 'documents':
      return project
        ? `Opened from the global documents queue. This file is still linked to ${project.name}.`
        : 'Opened from the global documents queue.';
    default:
      return project
        ? `Opened directly on the canonical document route. This file is linked to ${project.name}.`
        : 'Opened directly on the canonical document route.';
  }
}

function isCurrentV2GeneratedRecord(record: {
  details?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
}): boolean {
  const detailsVersion = record.details?.intelligence_version;
  const metaVersion = record.source_metadata?.intelligence_version;
  const supersededAt = record.details?.superseded_at ?? record.source_metadata?.superseded_at;
  return (detailsVersion === 'v2' || metaVersion === 'v2') && supersededAt == null;
}

function getTaskReason(task: WorkflowTaskRow): string {
  const detailReason = task.details?.reason;
  if (typeof detailReason === 'string' && detailReason.trim().length > 0) {
    return detailReason;
  }
  return task.description ?? task.task_type.replace(/_/g, ' ');
}

function getSuggestedOwner(task: WorkflowTaskRow): string | undefined {
  const metaOwner = task.source_metadata?.suggested_owner;
  if (typeof metaOwner === 'string' && metaOwner.trim().length > 0) {
    return metaOwner;
  }
  const detailOwner = task.details?.suggested_owner;
  return typeof detailOwner === 'string' && detailOwner.trim().length > 0
    ? detailOwner
    : undefined;
}

function parseDocumentExecutionTrace(
  trace: DocumentExecutionTrace | Record<string, unknown> | null | undefined,
): DocumentExecutionTrace | null {
  if (!trace || typeof trace !== 'object') return null;
  const candidate = trace as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;

  return {
    extraction_snapshot_id:
      typeof candidate.extraction_snapshot_id === 'string'
        ? candidate.extraction_snapshot_id
        : undefined,
    facts: candidate.facts as Record<string, unknown>,
    decisions: candidate.decisions,
    flow_tasks: candidate.flow_tasks,
    generated_at:
      typeof candidate.generated_at === 'string' ? candidate.generated_at : '',
    engine_version:
      typeof candidate.engine_version === 'string' ? candidate.engine_version : '',
    classification: candidate.classification,
    summary: candidate.summary,
    entities: candidate.entities,
    key_facts: candidate.key_facts,
    suggested_questions: candidate.suggested_questions,
    extracted:
      candidate.extracted && typeof candidate.extracted === 'object'
        ? candidate.extracted as Record<string, unknown>
        : undefined,
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : undefined,
    extraction_gaps: Array.isArray(candidate.extraction_gaps) ? candidate.extraction_gaps : undefined,
    audit_notes: Array.isArray(candidate.audit_notes) ? candidate.audit_notes : undefined,
    node_traces: Array.isArray(candidate.node_traces) ? candidate.node_traces : undefined,
  };
}

function decisionStatusFromCanonical(
  decision: DocumentExecutionTrace['decisions'][number],
): GeneratedDecision['status'] {
  if (decision.family === 'missing') {
    return decision.severity === 'info' ? 'info' : 'missing';
  }
  if (decision.family === 'mismatch') return 'mismatch';
  if (decision.family === 'risk') return 'risky';
  return decision.severity === 'info' ? 'passed' : 'info';
}

function decisionSeverityFromCanonical(
  decision: DocumentExecutionTrace['decisions'][number],
): NonNullable<GeneratedDecision['severity']> {
  if (decision.severity === 'critical') return 'critical';
  if (decision.severity === 'warning') return 'high';
  return 'low';
}

type PersistedCanonicalDecisionDetails = {
  intelligence_status?: GeneratedDecision['status'] | null;
  action?: string | null;
  reason?: string | null;
  primary_action?: GeneratedDecision['primary_action'];
  suggested_actions?: GeneratedDecision['suggested_actions'];
  family?: GeneratedDecision['family'];
  normalized_severity?: GeneratedDecision['normalized_severity'];
  detail?: string | null;
  field_key?: string | null;
  expected_location?: string | null;
  observed_value?: string | number | null;
  expected_value?: string | number | null;
  impact?: string | null;
  fact_refs?: string[];
  source_refs?: string[];
  evidence_objects?: GeneratedDecision['evidence_objects'];
  missing_source_context?: string[];
  rule_id?: string | null;
};

function asPersistedDecisionDetails(
  details: Record<string, unknown> | null | undefined,
): PersistedCanonicalDecisionDetails {
  return (details ?? {}) as PersistedCanonicalDecisionDetails;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function generatedStatusFromPersisted(
  row: PersistentDecisionRow,
  traceDecision: DocumentExecutionTrace['decisions'][number] | null,
): GeneratedDecision['status'] {
  const details = asPersistedDecisionDetails(row.details);
  const status = details.intelligence_status;
  if (
    status === 'passed' ||
    status === 'missing' ||
    status === 'risky' ||
    status === 'mismatch' ||
    status === 'info'
  ) {
    return status;
  }
  if (traceDecision) {
    return decisionStatusFromCanonical(traceDecision);
  }
  return row.status === 'resolved' ? 'passed' : 'info';
}

function generatedSeverityFromPersisted(
  row: PersistentDecisionRow,
  traceDecision: DocumentExecutionTrace['decisions'][number] | null,
): NonNullable<GeneratedDecision['severity']> {
  if (traceDecision) {
    return decisionSeverityFromCanonical(traceDecision);
  }
  if (row.severity === 'critical') return 'critical';
  if (row.severity === 'high' || row.severity === 'medium') return 'high';
  return 'low';
}

function mapPersistedDecisionRowToGeneratedDecision(params: {
  row: PersistentDecisionRow;
  traceDecision: DocumentExecutionTrace['decisions'][number] | null;
  relatedTaskIds: string[];
}): GeneratedDecision {
  const { row, traceDecision, relatedTaskIds } = params;
  const details = asPersistedDecisionDetails(row.details);
  const primaryAction = details.primary_action ?? traceDecision?.primary_action;
  const detail =
    details.detail ??
    traceDecision?.detail ??
    details.reason ??
    row.summary ??
    row.title;
  const reason =
    details.reason ??
    traceDecision?.reason ??
    detail;

  return {
    id: row.id,
    type: row.decision_type,
    status: generatedStatusFromPersisted(row, traceDecision),
    title: row.title,
    explanation: detail,
    reason,
    severity: generatedSeverityFromPersisted(row, traceDecision),
    action: primaryAction?.description ?? details.action ?? undefined,
    primary_action: primaryAction,
    suggested_actions: details.suggested_actions ?? traceDecision?.suggested_actions,
    confidence: row.confidence ?? traceDecision?.confidence,
    relatedTaskIds: relatedTaskIds.length > 0 ? relatedTaskIds : undefined,
    family: details.family ?? traceDecision?.family,
    detail,
    field_key: details.field_key ?? traceDecision?.field_key,
    expected_location: details.expected_location ?? traceDecision?.expected_location,
    observed_value: details.observed_value ?? traceDecision?.observed_value,
    expected_value: details.expected_value ?? traceDecision?.expected_value,
    impact: details.impact ?? traceDecision?.impact ?? undefined,
    fact_refs: asStringArray(details.fact_refs ?? traceDecision?.fact_refs),
    source_refs: asStringArray(details.source_refs ?? traceDecision?.source_refs),
    rule_id: details.rule_id ?? traceDecision?.rule_id ?? undefined,
    normalized_severity: details.normalized_severity ?? traceDecision?.severity,
    normalization_mode: 'structured',
    evidence_objects: details.evidence_objects ?? traceDecision?.evidence_objects,
    missing_source_context:
      details.missing_source_context ??
      traceDecision?.missing_source_context ??
      [],
  };
}

function mapPersistedTaskRowToTriggeredTask(task: WorkflowTaskRow): TriggeredWorkflowTask {
  return {
    id: task.id,
    title: task.title,
    priority:
      task.priority === 'P1' || task.priority === 'critical' ? 'P1' :
      task.priority === 'P2' || task.priority === 'high' ? 'P2' : 'P3',
    reason: getTaskReason(task),
    suggestedOwner: getSuggestedOwner(task),
    status: (['open', 'in_progress', 'resolved', 'auto_completed'] as const).includes(
      task.status as 'open' | 'in_progress' | 'resolved' | 'auto_completed',
    )
      ? (task.status as TriggeredWorkflowTask['status'])
      : 'open',
    flow_type:
      task.details?.flow_type === 'validation' ||
      task.details?.flow_type === 'correction' ||
      task.details?.flow_type === 'documentation' ||
      task.details?.flow_type === 'escalation'
        ? (task.details.flow_type as TriggeredWorkflowTask['flow_type'])
        : task.source_metadata?.flow_type === 'validation' ||
          task.source_metadata?.flow_type === 'correction' ||
          task.source_metadata?.flow_type === 'documentation' ||
          task.source_metadata?.flow_type === 'escalation'
          ? (task.source_metadata.flow_type as TriggeredWorkflowTask['flow_type'])
          : undefined,
  };
}

function contractInvoiceLabel(documentType: string | null | undefined): 'Contract' | 'Invoice' {
  return (documentType ?? '').toLowerCase() === 'invoice' ? 'Invoice' : 'Contract';
}

function buildContractInvoiceUnavailableSummary(
  documentType: string | null | undefined,
  message: string,
): DocumentSummary {
  const label = contractInvoiceLabel(documentType);
  return {
    headline: `${label} canonical review is unavailable.`,
    nextAction: message,
    traceHint: 'Canonical persisted rows required',
  };
}

function buildContractInvoicePrimarySummary(params: {
  documentType: string | null | undefined;
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
}): DocumentSummary {
  const { documentType, decisions, tasks } = params;
  const label = contractInvoiceLabel(documentType);
  const topDecision = decisions[0] ?? null;
  const nextTask = tasks[0] ?? null;

  if (topDecision) {
    return {
      headline: `${label} needs review: ${topDecision.title}.`,
      nextAction: nextTask?.title ?? topDecision.primary_action?.description ?? topDecision.reason ?? 'Resolve the persisted findings below.',
      traceHint: `Persisted decisions ${decisions.length}`,
    };
  }

  if (nextTask) {
    return {
      headline: `${label} has persisted next actions ready.`,
      nextAction: nextTask.title,
      traceHint: `Persisted actions ${tasks.length}`,
    };
  }

  return {
    headline: `${label} has no open canonical review items.`,
    nextAction: 'No action required.',
    traceHint: 'No persisted findings',
  };
}

function buildContractInvoicePrimaryEntities(params: {
  decisions: GeneratedDecision[];
  available: boolean;
  unavailableMessage?: string;
}): DetectedEntity[] {
  const { decisions, available, unavailableMessage } = params;
  if (!available) {
    return [{
      key: 'status',
      label: 'Status',
      value: 'Unavailable',
      status: 'warning',
      tooltip: unavailableMessage,
    }];
  }

  const topDecision = decisions[0] ?? null;
  if (!topDecision) {
    return [{
      key: 'status',
      label: 'Status',
      value: 'No open findings',
      status: 'ok',
    }];
  }

  return [{
    key: 'status',
    label: 'Status',
    value: topDecision.status === 'mismatch' ? 'Blocked' : 'Needs review',
    status: topDecision.status === 'mismatch' ? 'critical' : 'warning',
    tooltip: topDecision.title,
  }];
}

function parseRequestedPage(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export default function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const orgId = organizationId;

  const [doc, setDoc]           = useState<DocumentDetail | null>(null);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [signedUrl, setSignedUrl]   = useState<string | null>(null);
  const [fileExt, setFileExt]       = useState<string>('');
  const [fileContentType, setFileContentType] = useState<string>('');
  const [fileError, setFileError]   = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [extractions, setExtractions]     = useState<ExtractionRow[]>([]);
  const [extractionsLoading, setExtractionsLoading] = useState(false);
  const [, setDecisions] = useState<DecisionRow[]>([]);
  const [, setDecisionsLoading] = useState(false);
  const [persistentDecisions, setPersistentDecisions] = useState<PersistentDecisionRow[]>([]);
  const [, setPersistentDecisionsLoading] = useState(false);
  const [workflowTasks, setWorkflowTasks] = useState<WorkflowTaskRow[]>([]);
  const [, setWorkflowTasksLoading] = useState(false);
  const [relatedDocs, setRelatedDocs] = useState<RelatedDocInput[]>([]);
  const [factOverrides, setFactOverrides] = useState<DocumentFactOverrideRecord[]>([]);
  const [factAnchors, setFactAnchors] = useState<DocumentFactAnchorRecord[]>([]);
  const [factReviews, setFactReviews] = useState<DocumentFactReviewRecord[]>([]);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackState>>({});
  const [feedbackErrorById, setFeedbackErrorById] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [lastEvalResult, setLastEvalResult] = useState<EvaluateResponse | null>(null);
  const requestedSource = searchParams.get('source');
  const requestedProjectId = searchParams.get('projectId');
  const requestedEvidencePage = parseRequestedPage(searchParams.get('page'));
  const requestedEvidenceFactId = searchParams.get('factId');
  const requestedEvidenceFieldKey = searchParams.get('fieldKey');
  const evidenceNavigationKey = useMemo(
    () => {
      if (
        requestedEvidencePage == null &&
        !requestedEvidenceFactId &&
        !requestedEvidenceFieldKey
      ) {
        return null;
      }

      return `${requestedEvidencePage ?? 'none'}:${requestedEvidenceFactId ?? 'none'}:${requestedEvidenceFieldKey ?? 'none'}`;
    },
    [requestedEvidenceFactId, requestedEvidenceFieldKey, requestedEvidencePage],
  );
  const linkedProject = doc ? resolveProject(doc.projects) : null;
  const detailContext = resolveDocumentDetailContext(
    searchParams,
    linkedProject?.id ?? doc?.project_id ?? null,
  );
  const fallbackProjectHref =
    requestedSource === 'project' && requestedProjectId
      ? `/platform/projects/${requestedProjectId}`
      : null;
  const loadingBackHref = fallbackProjectHref ?? '/platform/documents';

  const loadAllData = useCallback(async () => {
    // Reset to loading state — one cheap synchronous render before any awaits.
    setDoc(null);
    setRelatedDocs([]);
    setSignedUrl(null);
    setFileExt('');
    setFileContentType('');
    setFileError(null);
    setFileLoading(false);
    setExtractions([]);
    setDecisions([]);
    setPersistentDecisions([]);
    setWorkflowTasks([]);
    setFeedbackMap({});
    setFeedbackErrorById({});
    setFactOverrides([]);
    setFactAnchors([]);
    setFactReviews([]);
    setNotFound(false);
    setError(null);
    setLoading(true);
    setExtractionsLoading(true);
    setDecisionsLoading(true);
    setPersistentDecisionsLoading(true);
    setWorkflowTasksLoading(true);

    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const authHeaders: Record<string, string> = authSession?.access_token
        ? { Authorization: `Bearer ${authSession.access_token}` }
        : {};

      // ── Phase 1: primary data (parallel) ────────────────────────────────────
      const [docResult, extractionsResult, decisionsResult, persistentResult, tasksResult] =
        await Promise.all([
          (async () => {
            const res = await fetch(
              `/api/documents/${id}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`,
              { headers: authHeaders },
            );
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              return {
                data: null,
                error: {
                  message: (body as { error?: string })?.error ?? 'Document fetch failed',
                  status: res.status,
                },
              };
            }
            return { data: body as DocumentDetail, error: null };
          })(),
          supabase
            .from('document_extractions')
            .select('id, data, created_at')
            .eq('document_id', id)
            // IMPORTANT: only blob extraction rows; normalized fact rows share the same table.
            .is('field_key', null)
            .order('created_at', { ascending: false }),
          supabase
            .from('document_decisions')
            .select('id, decision_type, decision_value, confidence, source, created_at')
            .eq('document_id', id)
            .order('created_at', { ascending: true }),
          supabase
            .from('decisions')
            .select('id, decision_type, title, summary, severity, status, confidence, details, created_at')
            .eq('document_id', id)
            .order('created_at', { ascending: true }),
          supabase
            .from('workflow_tasks')
            .select('id, task_type, title, description, priority, status, decision_id, source, source_metadata, details, created_at')
            .eq('document_id', id)
            .order('created_at', { ascending: true }),
        ]);

      if (docResult.error || !docResult.data) {
        if (docResult.error?.status === 404) {
          setNotFound(true);
        } else {
          setError(docResult.error?.message ?? 'Failed to load document');
        }
        setLoading(false);
        setExtractionsLoading(false);
        setDecisionsLoading(false);
        setPersistentDecisionsLoading(false);
        setWorkflowTasksLoading(false);
        return;
      }

      const docData = docResult.data as DocumentDetail;
      const loadedDecisions = (decisionsResult.data ?? []) as DecisionRow[];
      const loadedPersistentDecisions = (persistentResult.data ?? []) as PersistentDecisionRow[];

      // Compute feedback IDs from phase-1 results (needs decision rows).
      const generatedPersistentDecisionIds = loadedPersistentDecisions
        .filter((decision) => isCurrentV2GeneratedRecord(decision))
        .map((decision) => decision.id);
      const feedbackDecisionIds = isContractInvoicePrimaryDocumentType(docData.document_type)
        ? generatedPersistentDecisionIds
        : loadedDecisions.map((decision) => decision.id);

      // ── Phase 2: feedback + signed URL in parallel ───────────────────────────
      // Running both here (instead of sequentially after setState) means all
      // state is committed in one React batch below, so buildDocumentIntelligenceViewModel
      // runs exactly once instead of twice.
      const [feedbackResult, fileRes] = await Promise.all([
        feedbackDecisionIds.length > 0
          ? supabase
              .from('decision_feedback')
              .select('decision_id, is_correct, review_error_type')
              .in('decision_id', feedbackDecisionIds)
          : Promise.resolve({ data: [] as Array<{ decision_id: string; is_correct: boolean; review_error_type?: ReviewErrorType | null }>, error: null }),
        docData.storage_path
          ? fetch(
              `/api/documents/${id}/file${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`,
              { headers: authHeaders },
            )
          : Promise.resolve(null as Response | null),
      ]);

      // Build feedback map from phase-2 results.
      const nextFeedbackMap: Record<string, FeedbackState> = {};
      if (feedbackResult.data) {
        for (const row of feedbackResult.data as Array<{
          decision_id: string;
          is_correct: boolean;
          review_error_type?: ReviewErrorType | null;
        }>) {
          nextFeedbackMap[row.decision_id] = {
            status: row.is_correct ? 'correct' : 'incorrect',
            reviewErrorType: row.is_correct ? null : (row.review_error_type ?? 'edge_case'),
          };
        }
      }

      // Parse signed URL response.
      let resolvedSignedUrl: string | null = null;
      let resolvedFileExt = '';
      let resolvedFileContentType = '';
      let resolvedFileError: string | null = null;

      if (fileRes === null) {
        resolvedFileError = 'No file attached to this document';
      } else {
        if (redirectIfUnauthorized(fileRes, router.replace)) return;
        try {
          const fileBody = await fileRes.json().catch(() => ({})) as {
            signedUrl?: string;
            ext?: string;
            contentType?: string;
            error?: string;
          };
          if (fileRes.ok && fileBody.signedUrl) {
            resolvedSignedUrl = fileBody.signedUrl;
            resolvedFileExt = fileBody.ext ?? '';
            resolvedFileContentType = fileBody.contentType ?? '';
          } else {
            resolvedFileError = fileBody.error ?? 'Could not generate file link';
          }
        } catch {
          resolvedFileError = 'Failed to fetch file URL';
        }
      }

      // ── Phase 3: single state batch ──────────────────────────────────────────
      // All setState calls below are synchronous (no awaits) so React 18 batches
      // them into one render. buildDocumentIntelligenceViewModel runs exactly once
      // with complete data (doc + extractions + feedback + fact records).
      setDoc(docData);
      setRelatedDocs(docData.relatedDocs ?? []);
      setFactOverrides(docData.factOverrides ?? []);
      setFactAnchors(docData.factAnchors ?? []);
      setFactReviews(docData.factReviews ?? []);
      if (!extractionsResult.error && extractionsResult.data) {
        setExtractions(extractionsResult.data as ExtractionRow[]);
      }
      setDecisions(loadedDecisions);
      setPersistentDecisions(loadedPersistentDecisions);
      if (!tasksResult.error && tasksResult.data) {
        setWorkflowTasks(tasksResult.data as WorkflowTaskRow[]);
      }
      setFeedbackMap(nextFeedbackMap);
      setSignedUrl(resolvedSignedUrl);
      setFileExt(resolvedFileExt);
      setFileContentType(resolvedFileContentType);
      setFileError(resolvedFileError);
      setLoading(false);
      setExtractionsLoading(false);
      setDecisionsLoading(false);
      setPersistentDecisionsLoading(false);
      setWorkflowTasksLoading(false);
      setFileLoading(false);
    } catch {
      setError('Failed to load document');
    } finally {
      setLoading(false);
      setExtractionsLoading(false);
      setDecisionsLoading(false);
      setPersistentDecisionsLoading(false);
      setWorkflowTasksLoading(false);
    }
  }, [id, orgId, router.replace]);

  useEffect(() => {
    if (orgLoading) return;
    loadAllData();
  }, [orgLoading, loadAllData, refreshKey]);

  const handleDecisionFeedback = async (
    decisionId: string,
    input: {
      isCorrect: boolean;
      reviewErrorType?: ReviewErrorType | null;
    },
  ) => {
    setFeedbackErrorById((prev) => ({ ...prev, [decisionId]: '' }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const reviewErrorType = input.isCorrect ? null : (input.reviewErrorType ?? 'edge_case');

      const res = await fetch(`/api/decisions/${decisionId}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          is_correct: input.isCorrect,
          review_error_type: reviewErrorType,
        }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;

      if (res.ok) {
        setFeedbackMap((prev) => ({
          ...prev,
          [decisionId]: {
            status: input.isCorrect ? 'correct' : 'incorrect',
            reviewErrorType,
          },
        }));
      } else {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string })?.error ?? 'Failed to save feedback';
        setFeedbackErrorById((prev) => ({ ...prev, [decisionId]: msg }));
      }
    } catch {
      setFeedbackErrorById((prev) => ({ ...prev, [decisionId]: 'Failed to save feedback' }));
    }
  };

  const handleFactOverride = async (input: {
    fieldKey: string;
    valueJson: unknown;
    rawValue?: string | null;
    actionType: DocumentFactOverrideActionType;
    reason?: string | null;
  }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return { ok: false, error: 'Authentication required' };
      }

      const res = await fetch(`/api/documents/${id}/facts/override`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(input),
      });

      if (redirectIfUnauthorized(res, router.replace)) {
        return { ok: false, error: 'Authentication required' };
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (body as { error?: string })?.error ?? 'Failed to save fact override',
        };
      }

      const created = (body as { override?: DocumentFactOverrideRecord }).override;
      if (!created) {
        return { ok: false, error: 'Override response was incomplete' };
      }

      setFactOverrides((prev) => {
        const next = prev
          .filter((override) => override.id !== created.id)
          .map((override) =>
            override.fieldKey === created.fieldKey
              ? { ...override, isActive: false }
              : override,
          );
        return [created, ...next];
      });

      return { ok: true };
    } catch {
      return { ok: false, error: 'Failed to save fact override' };
    }
  };

  const handleFactReview = async (input: {
    fieldKey: string;
    reviewStatus: DocumentFactReviewStatus;
    reviewedValueJson?: unknown;
    notes?: string | null;
  }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return { ok: false, error: 'Authentication required' };
      }

      const res = await fetch(`/api/documents/${id}/facts/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(input),
      });

      if (redirectIfUnauthorized(res, router.replace)) {
        return { ok: false, error: 'Authentication required' };
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (body as { error?: string })?.error ?? 'Failed to save fact review',
        };
      }

      const created = (body as { review?: DocumentFactReviewRecord }).review;
      if (!created) {
        return { ok: false, error: 'Review response was incomplete' };
      }

      setFactReviews((prev) => [created, ...prev.filter((review) => review.id !== created.id)]);

      return { ok: true };
    } catch {
      return { ok: false, error: 'Failed to save fact review' };
    }
  };

  const handleFactAnchor = async (input: {
    fieldKey: string;
    overrideId?: string | null;
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }): Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  > => {
    const applyCreatedAnchor = (created: DocumentFactAnchorRecord) => {
      setFactAnchors((prev) => {
        const next = prev
          .filter((anchor) => anchor.id !== created.id)
          .map((anchor) =>
            anchor.fieldKey === created.fieldKey &&
            anchor.overrideId === created.overrideId &&
            (
              created.anchorType === 'page_range' ||
              created.anchorType === 'table_region'
                ? anchor.anchorType === 'page_range' || anchor.anchorType === 'table_region'
                : true
            )
              ? { ...anchor, isPrimary: false }
              : anchor,
          );
        return [created, ...next];
      });
    };

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return { ok: false, error: 'Authentication required' };
      }

      const anchorPayload: Record<string, unknown> = {
        fieldKey: input.fieldKey,
        anchorType: input.anchorType,
        pageNumber: input.pageNumber,
        snippet: input.snippet ?? null,
        quoteText: input.quoteText ?? null,
        rectJson: input.rectJson ?? null,
        anchorJson: input.anchorJson ?? null,
      };
      const rawOverride = input.overrideId;
      if (
        typeof rawOverride === 'string' &&
        rawOverride.trim().length > 0 &&
        rawOverride.trim().toLowerCase() !== 'null' &&
        rawOverride.trim().toLowerCase() !== 'undefined'
      ) {
        anchorPayload.overrideId = rawOverride.trim();
      }

      const res = await fetch(`/api/documents/${id}/facts/anchor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(anchorPayload),
      });

      if (redirectIfUnauthorized(res, router.replace)) {
        return { ok: false, error: 'Authentication required' };
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (body as { error?: string })?.error ?? 'Failed to save fact anchor',
        };
      }

      const created = (body as { anchor?: DocumentFactAnchorRecord }).anchor;
      if (!created) {
        return { ok: false, error: 'Anchor response was incomplete' };
      }

      applyCreatedAnchor(created);

      return { ok: true, anchor: created };
    } catch {
      return { ok: false, error: 'Failed to save fact anchor' };
    }
  };

  const handleRateScheduleAnchor = async (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }): Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  > => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return { ok: false, error: 'Authentication required' };
      }

      const res = await fetch(`/api/documents/${id}/rate-schedule/anchor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(input),
      });

      if (redirectIfUnauthorized(res, router.replace)) {
        return { ok: false, error: 'Authentication required' };
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (body as { error?: string })?.error ?? 'Failed to save rate schedule anchor',
        };
      }

      const created = (body as { anchor?: DocumentFactAnchorRecord }).anchor;
      if (!created) {
        return { ok: false, error: 'Rate schedule anchor response was incomplete' };
      }

      setFactAnchors((prev) => {
        const next = prev
          .filter((anchor) => anchor.id !== created.id)
          .map((anchor) =>
            anchor.fieldKey === created.fieldKey &&
            anchor.overrideId === created.overrideId &&
            (anchor.anchorType === 'page_range' || anchor.anchorType === 'table_region')
              ? { ...anchor, isPrimary: false }
              : anchor,
          );
        return [created, ...next];
      });

      return { ok: true, anchor: created };
    } catch {
      return { ok: false, error: 'Failed to save rate schedule anchor' };
    }
  };

  const handleStatusChange = (newStatus: string) => {
    setDoc((prev) => (prev ? { ...prev, processing_status: newStatus } : prev));
    // Refresh all data when pipeline reaches a terminal state
    if (newStatus === 'decisioned' || newStatus === 'extracted' || newStatus === 'failed') {
      setRefreshKey((k) => k + 1);
    }
  };

  const handleEvaluate = async () => {
    if (!doc?.domain || !doc?.document_type) return;
    setEvaluating(true);
    setEvalError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setEvalError('Authentication required');
        return;
      }
      const res = await fetch(`/api/documents/${id}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEvalError(data?.error ?? data?.detail ?? 'Evaluation failed');
        return;
      }
      setLastEvalResult(data as EvaluateResponse);
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              processing_status: data.processing_status ?? prev.processing_status,
              processed_at: data.processing_status === 'decisioned' ? new Date().toISOString() : prev.processed_at,
            }
          : prev,
      );
      setRefreshKey((k) => k + 1);
    } catch {
      setEvalError('Evaluation request failed');
    } finally {
      setEvaluating(false);
    }
  };

  // ── Document Intelligence (client-side computation) ────────────────────────
  // Must be before early returns to satisfy Rules of Hooks.

  const preferredExtraction = useMemo(
    () => pickPreferredExtractionBlob(extractions),
    [extractions],
  );

  const intelligence = useMemo(() => {
    if (!doc || extractionsLoading) return null;
    const extractionBlob = preferredExtraction?.data ?? null;
    if (process.env.NEXT_PUBLIC_EIGHTFORGE_EVIDENCE_DEBUG === '1') {
      const extraction = (extractionBlob as Record<string, unknown> | null)?.extraction as Record<string, unknown> | null;
      const hasEvidence = !!(extraction && (extraction as Record<string, unknown>).evidence_v1);
      const ev = (extraction?.evidence_v1 as Record<string, unknown> | null) ?? null;
      const signals = (ev?.section_signals as Record<string, unknown> | null) ?? null;
      console.log('[DocumentDetailPage] preferred extraction selected', {
        documentId: id,
        latestExtractionRowId: (extractions[0] ?? null)?.id ?? null,
        preferredExtractionRowId: preferredExtraction?.id ?? null,
        createdAt: preferredExtraction?.created_at ?? null,
        hasEvidenceV1: hasEvidence,
        extractionMode: extraction?.mode ?? null,
        rate_section_present: signals?.rate_section_present ?? null,
        unit_price_structure_present: signals?.unit_price_structure_present ?? null,
        rate_section_pages: signals?.rate_section_pages ?? null,
      });
    }
    return buildDocumentIntelligence({
      documentType: doc.document_type,
      documentTitle: doc.title,
      documentName: doc.name,
      projectName: resolveProject(doc.projects)?.name ?? null,
      extractionData: extractionBlob as Record<string, unknown> | null,
      relatedDocs,
    });
  }, [doc, extractions, extractionsLoading, id, preferredExtraction, relatedDocs]);

  const contractInvoicePrimaryMode = isContractInvoicePrimaryDocumentType(doc?.document_type);
  const canonicalTrace = useMemo(
    () => parseDocumentExecutionTrace(doc?.intelligence_trace ?? null),
    [doc?.intelligence_trace],
  );

  const currentV2PersistedDecisions = useMemo(() => {
    return persistentDecisions.filter((decision) => isCurrentV2GeneratedRecord(decision));
  }, [persistentDecisions]);

  const currentV2PersistedTasks = useMemo(() => {
    return workflowTasks.filter((task) => isCurrentV2GeneratedRecord(task));
  }, [workflowTasks]);

  const persistedCanonicalTaskIdsByDecisionId = useMemo(() => {
    const next = new Map<string, string[]>();
    for (const task of currentV2PersistedTasks) {
      if (!task.decision_id) continue;
      const current = next.get(task.decision_id) ?? [];
      current.push(task.id);
      next.set(task.decision_id, current);
    }
    return next;
  }, [currentV2PersistedTasks]);

  const traceDecisionById = useMemo(() => {
    return new Map(
      (canonicalTrace?.decisions ?? []).map((decision) => [decision.id, decision] as const),
    );
  }, [canonicalTrace]);

  const contractInvoiceRenderedDecisions = useMemo((): GeneratedDecision[] => {
    if (!contractInvoicePrimaryMode) return [];

    return currentV2PersistedDecisions.map((row) =>
      mapPersistedDecisionRowToGeneratedDecision({
        row,
        traceDecision: traceDecisionById.get(row.id) ?? null,
        relatedTaskIds: persistedCanonicalTaskIdsByDecisionId.get(row.id) ?? [],
      }),
    );
  }, [
    contractInvoicePrimaryMode,
    currentV2PersistedDecisions,
    persistedCanonicalTaskIdsByDecisionId,
    traceDecisionById,
  ]);

  const contractInvoiceRenderedTasks = useMemo((): TriggeredWorkflowTask[] => {
    if (!contractInvoicePrimaryMode) return [];
    return currentV2PersistedTasks.map(mapPersistedTaskRowToTriggeredTask);
  }, [contractInvoicePrimaryMode, currentV2PersistedTasks]);

  const actionableTraceDecisionIds = useMemo(() => {
    if (!contractInvoicePrimaryMode || !canonicalTrace) return [];
    return canonicalTrace.decisions
      .filter((decision) => decision.family !== 'confirmed')
      .map((decision) => decision.id);
  }, [canonicalTrace, contractInvoicePrimaryMode]);

  const traceTaskIds = useMemo(() => {
    if (!contractInvoicePrimaryMode || !canonicalTrace) return [];
    return canonicalTrace.flow_tasks.map((task) => task.id);
  }, [canonicalTrace, contractInvoicePrimaryMode]);

  const contractInvoicePrimaryUnavailableMessage = useMemo(() => {
    if (!contractInvoicePrimaryMode) return null;

    const persistedDecisionIds = new Set(currentV2PersistedDecisions.map((decision) => decision.id));
    const persistedTaskIds = new Set(currentV2PersistedTasks.map((task) => task.id));
    const missingPersistedActionableDecisionIds = actionableTraceDecisionIds.filter(
      (decisionId) => !persistedDecisionIds.has(decisionId),
    );
    const missingPersistedTaskIds = traceTaskIds.filter(
      (taskId) => !persistedTaskIds.has(taskId),
    );

    if (missingPersistedActionableDecisionIds.length > 0 || missingPersistedTaskIds.length > 0) {
      return 'Canonical persisted decisions or tasks are stale relative to the document trace. Reprocess this document before reviewing findings.';
    }

    if (canonicalTrace == null && currentV2PersistedDecisions.length === 0 && currentV2PersistedTasks.length === 0) {
      return doc?.processing_status === 'decisioned'
        ? 'Canonical persisted contract/invoice artifacts are unavailable. Reprocess this document to rebuild the primary review state.'
        : 'Canonical contract/invoice review is not ready yet. Wait for processing to complete or reprocess the document.';
    }

    return null;
  }, [
    actionableTraceDecisionIds,
    canonicalTrace,
    contractInvoicePrimaryMode,
    currentV2PersistedDecisions,
    currentV2PersistedTasks,
    doc?.processing_status,
    traceTaskIds,
  ]);

  const contractInvoicePrimaryAvailable = contractInvoicePrimaryMode && contractInvoicePrimaryUnavailableMessage == null;

  const persistedDecisionsToShow = useMemo(() => {
    if (contractInvoicePrimaryMode) return currentV2PersistedDecisions;
    return persistentDecisions;
  }, [contractInvoicePrimaryMode, currentV2PersistedDecisions, persistentDecisions]);

  const persistedTasksToShow = useMemo(() => {
    if (contractInvoicePrimaryMode) return currentV2PersistedTasks;
    return workflowTasks;
  }, [contractInvoicePrimaryMode, currentV2PersistedTasks, workflowTasks]);

  const displayDecisions = useMemo((): GeneratedDecision[] => {
    if (contractInvoicePrimaryMode) {
      return contractInvoicePrimaryAvailable ? contractInvoiceRenderedDecisions : [];
    }
    return intelligence?.decisions ?? [];
  }, [
    contractInvoicePrimaryAvailable,
    contractInvoicePrimaryMode,
    contractInvoiceRenderedDecisions,
    intelligence,
  ]);

  const displayTasks = useMemo((): TriggeredWorkflowTask[] => {
    if (contractInvoicePrimaryMode) {
      return contractInvoicePrimaryAvailable ? contractInvoiceRenderedTasks : [];
    }
    return intelligence?.tasks ?? [];
  }, [
    contractInvoicePrimaryAvailable,
    contractInvoicePrimaryMode,
    contractInvoiceRenderedTasks,
    intelligence,
  ]);

  const displaySummary = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      if (contractInvoicePrimaryUnavailableMessage) {
        return buildContractInvoiceUnavailableSummary(
          doc?.document_type,
          contractInvoicePrimaryUnavailableMessage,
        );
      }
      if (canonicalTrace?.summary) return canonicalTrace.summary;
      return buildContractInvoicePrimarySummary({
        documentType: doc?.document_type,
        decisions: contractInvoiceRenderedDecisions,
        tasks: contractInvoiceRenderedTasks,
      });
    }
    return intelligence?.summary ?? null;
  }, [
    canonicalTrace,
    contractInvoicePrimaryMode,
    contractInvoicePrimaryUnavailableMessage,
    contractInvoiceRenderedDecisions,
    contractInvoiceRenderedTasks,
    doc?.document_type,
    intelligence,
  ]);

  const displayEntities = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      if (canonicalTrace?.entities) return canonicalTrace.entities;
      return buildContractInvoicePrimaryEntities({
        decisions: contractInvoiceRenderedDecisions,
        available: contractInvoicePrimaryAvailable,
        unavailableMessage: contractInvoicePrimaryUnavailableMessage ?? undefined,
      });
    }
    return intelligence?.entities ?? [];
  }, [
    canonicalTrace,
    contractInvoicePrimaryAvailable,
    contractInvoicePrimaryMode,
    contractInvoicePrimaryUnavailableMessage,
    contractInvoiceRenderedDecisions,
    intelligence,
  ]);

  const displayExtractionGaps = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.extraction_gaps ?? [];
    }
    return intelligence?.extractionGaps ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

  const displayAuditNotes = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.audit_notes ?? [];
    }
    return intelligence?.auditNotes ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

  const displayNodeTraces = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.node_traces ?? [];
    }
    return intelligence?.nodeTraces ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

  const displaySuggestedQuestions = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.suggested_questions ?? [];
    }
    return intelligence?.suggestedQuestions ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

  const displayNormalizedDecisions = useMemo((): NormalizedDecision[] => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.decisions ?? [];
    }
    return intelligence?.normalizedDecisions ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

  const reviewedDecisionIds = useMemo(
    () => Object.keys(feedbackMap).filter((decisionId) => feedbackMap[decisionId]?.status != null),
    [feedbackMap],
  );

  const intelligenceViewModel = useMemo(() => {
    if (!doc || extractionsLoading) return null;
    return buildDocumentIntelligenceViewModel({
      documentId: doc.id,
      documentType: doc.document_type,
      documentName: doc.name,
      documentTitle: doc.title,
      projectName: resolveProject(doc.projects)?.name ?? null,
      preferredExtraction,
      relatedDocs,
      normalizedDecisions: displayNormalizedDecisions,
      extractionGaps: displayExtractionGaps,
      auditNotes: displayAuditNotes,
      nodeTraces: displayNodeTraces,
      executionTrace: canonicalTrace,
      extractionHistory: extractions,
      factOverrides,
      factAnchors,
      factReviews,
      reviewedDecisionIds,
    });
  }, [
    canonicalTrace,
    displayAuditNotes,
    displayExtractionGaps,
    displayNodeTraces,
    displayNormalizedDecisions,
    doc,
    extractions,
    extractionsLoading,
    factAnchors,
    factOverrides,
    factReviews,
    preferredExtraction,
    relatedDocs,
    reviewedDecisionIds,
  ]);

  const derivedDocumentStatus = useMemo(() => {
    const baseStatus = (doc?.processing_status ?? doc?.status ?? '').toLowerCase();
    if (baseStatus === 'failed') return 'failed';

    const model = intelligenceViewModel;
    const factsPresent = (model?.counts.totalFacts ?? 0) > 0;
    const parserReady = model?.parserStatus === 'Ready';

    // Prefer derived readiness (facts + parser status) over persisted processing_status,
    // since the persisted row can lag for spreadsheet ticket-query flows.
    const extractionComplete =
      preferredExtraction != null ||
      model?.extractionTimestamp != null ||
      (factsPresent && parserReady);

    const reviewBlockersPresent =
      displayDecisions.length > 0 ||
      displayTasks.length > 0 ||
      (model?.counts.conflictingFacts ?? 0) > 0 ||
      (model?.counts.missingFacts ?? 0) > 0 ||
      (model?.counts.missingEvidenceFacts ?? 0) > 0;

    if (extractionComplete && reviewBlockersPresent) return 'needs_review';
    if (extractionComplete) return 'ready';

    // Default to processing for in-flight/unknown states (including uploaded).
    return 'processing';
  }, [
    displayDecisions.length,
    displayTasks.length,
    doc?.processing_status,
    doc?.status,
    intelligenceViewModel,
    preferredExtraction,
  ]);

  const reviewableDecisionIds = useMemo(
    () =>
      contractInvoicePrimaryMode
        ? contractInvoiceRenderedDecisions.map((decision) => decision.id)
        : [],
    [contractInvoicePrimaryMode, contractInvoiceRenderedDecisions],
  );

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading || orgLoading) {
    return (
      <div className="space-y-3">
        <Link
          href={loadingBackHref}
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Back
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="space-y-3">
        <Link
          href={loadingBackHref}
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Back
        </Link>
        <p className="text-[11px] text-red-400">{error}</p>
      </div>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────

  if (notFound || !doc) {
    return (
      <div className="space-y-3">
        <Link
          href={loadingBackHref}
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Back
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Document not found.</p>
      </div>
    );
  }

  const displayTitle = doc.title ?? doc.name;
  const project = linkedProject;
  const filename     = doc.storage_path.split('/').at(-1) ?? doc.storage_path;
  const breadcrumbs = buildDocumentBreadcrumbs({
    title: displayTitle,
    mode: detailContext.mode,
    project,
  });
  const projectHref = project ? `/platform/projects/${project.id}` : null;
  const projectDocumentsHref = project ? `${projectHref}#project-documents` : null;
  const backToDocumentsHref = '/platform/documents';
  const primaryBackHref =
    detailContext.mode === 'project' && projectHref ? projectHref : backToDocumentsHref;
  const primaryBackLabel =
    detailContext.mode === 'project' && projectHref ? 'Back to Project' : 'Back to Documents';
  const secondaryBackHref =
    detailContext.mode === 'project' ? backToDocumentsHref : projectHref;
  const secondaryBackLabel =
    detailContext.mode === 'project' ? 'Back to Documents' : 'Back to Project';
  const hasIntelligenceWorkspace = intelligenceViewModel != null;
  const evaluationSection = (
    <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
      <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Evaluation</div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#8B94A3]">Processing status</span>
          <span
            className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
              (doc.processing_status ?? lastEvalResult?.processing_status) === 'decisioned'
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : (doc.processing_status ?? lastEvalResult?.processing_status) === 'failed'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                  : 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]'
            }`}
          >
            {doc.processing_status ?? lastEvalResult?.processing_status ?? '—'}
          </span>
        </div>
        {(doc.processed_at || lastEvalResult) && (
          <span className="text-[11px] text-[#8B94A3]">
            Last processed: {doc.processed_at
              ? new Date(doc.processed_at).toLocaleString()
              : lastEvalResult
                ? 'Just now'
                : '—'}
          </span>
        )}
        {lastEvalResult ? (
          <>
            <span className="text-[11px] text-[#8B94A3]">
              Matched rules: <strong className="text-[#F5F7FA]">{lastEvalResult.matched_rules}</strong>
            </span>
            <span className="text-[11px] text-[#8B94A3]">
              Decisions: <strong className="text-[#F5F7FA]">+{lastEvalResult.decisions_created}</strong> created,{' '}
              <strong className="text-[#F5F7FA]">{lastEvalResult.decisions_updated}</strong> updated
            </span>
            <span className="text-[11px] text-[#8B94A3]">
              Tasks created: <strong className="text-[#F5F7FA]">{lastEvalResult.tasks_created}</strong>
            </span>
          </>
        ) : null}
        {doc.domain && doc.document_type ? (
          <button
            type="button"
            onClick={handleEvaluate}
            disabled={evaluating}
            className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {evaluating ? 'Evaluating…' : 'Evaluate Document'}
          </button>
        ) : (
          <span className="text-[11px] text-amber-400">
            Set domain and document type to evaluate.
          </span>
        )}
      </div>
      {evalError && (
        <p className="mt-2 text-[11px] text-red-400">{evalError}</p>
      )}
      {lastEvalResult && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#1A1A3E] pt-3 text-[11px] sm:grid-cols-4">
            <div><span className="text-[#8B94A3]">Facts loaded</span> <span className="text-[#F5F7FA]">{lastEvalResult.facts_loaded}</span></div>
            <div><span className="text-[#8B94A3]">Rules evaluated</span> <span className="text-[#F5F7FA]">{lastEvalResult.rules_evaluated}</span></div>
            <div><span className="text-[#8B94A3]">Matched rules</span> <span className="text-[#F5F7FA]">{lastEvalResult.matched_rules}</span></div>
            <div><span className="text-[#8B94A3]">Decisions created</span> <span className="text-[#F5F7FA]">{lastEvalResult.decisions_created}</span></div>
            <div><span className="text-[#8B94A3]">Decisions updated</span> <span className="text-[#F5F7FA]">{lastEvalResult.decisions_updated}</span></div>
            <div><span className="text-[#8B94A3]">Decisions skipped</span> <span className="text-[#F5F7FA]">{lastEvalResult.decisions_skipped}</span></div>
            <div><span className="text-[#8B94A3]">Tasks created</span> <span className="text-[#F5F7FA]">{lastEvalResult.tasks_created}</span></div>
            <div><span className="text-[#8B94A3]">Tasks skipped</span> <span className="text-[#F5F7FA]">{lastEvalResult.tasks_skipped}</span></div>
          </div>
          {lastEvalResult.debug && Object.keys(lastEvalResult.debug.derived_facts ?? {}).length > 0 && (
            <div className="mt-2 border-t border-[#1A1A3E] pt-2 text-[11px]">
              <span className="text-[#8B94A3]">Derived facts (debug):</span>{' '}
              <span className="text-[#F5F7FA]">
                {lastEvalResult.debug.extraction_row_count} rows → {JSON.stringify(lastEvalResult.debug.derived_facts)}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <DocumentDetailExperience
        breadcrumbs={breadcrumbs}
        contextLabel={documentContextBadgeLabel(detailContext.mode)}
        contextDescription={documentContextDescription(detailContext.mode, project)}
        projectId={project?.id ?? doc.project_id ?? null}
        projectName={project?.name ?? null}
        documentType={doc.document_type}
        displayTitle={displayTitle}
        processingStatus={derivedDocumentStatus}
        summary={displaySummary}
        entities={displayEntities}
        fileContentType={fileContentType}
        fileLoading={fileLoading}
        fileError={fileError}
        signedUrl={signedUrl}
        fileExt={fileExt}
        filename={filename}
        projectDocumentsHref={projectDocumentsHref}
        secondaryBackHref={secondaryBackHref}
        secondaryBackLabel={secondaryBackLabel}
        primaryBackHref={primaryBackHref}
        primaryBackLabel={primaryBackLabel}
        processingStatusNode={(
          <DocumentProcessingStatus
            status={doc.processing_status ?? doc.status}
            processingError={doc.processing_error ?? null}
            documentId={id}
            orgId={orgId ?? undefined}
            onStatusChange={handleStatusChange}
            onProcessed={loadAllData}
          />
        )}
        hasIntelligenceWorkspace={hasIntelligenceWorkspace}
        intelligenceViewModel={intelligenceViewModel}
        extractionVersion={intelligenceViewModel?.extractionVersion ?? null}
        extractionTimestamp={
          intelligenceViewModel?.extractionTimestamp ?? doc.processed_at ?? preferredExtraction?.created_at ?? null
        }
        decisions={displayDecisions}
        tasks={displayTasks}
        projectContextLabel={project?.name ?? undefined}
        reviewableDecisionIds={reviewableDecisionIds}
        unavailableMessage={
          contractInvoicePrimaryMode
            ? contractInvoicePrimaryUnavailableMessage ?? undefined
            : undefined
        }
        feedbackById={contractInvoicePrimaryMode ? feedbackMap : undefined}
        feedbackErrorById={contractInvoicePrimaryMode ? feedbackErrorById : undefined}
        onReviewDecision={contractInvoicePrimaryMode ? handleDecisionFeedback : undefined}
        documentId={id}
        orgId={orgId ?? undefined}
        comparisons={intelligence?.comparisons ?? []}
        suggestedQuestions={displaySuggestedQuestions}
        uploadedAt={doc.created_at}
        processedAt={doc.processed_at}
        decisionsGeneratedAt={persistedDecisionsToShow[0]?.created_at ?? null}
        tasksCreatedAt={persistedTasksToShow[0]?.created_at ?? null}
        auditNotes={displayAuditNotes}
        nodeTraces={displayNodeTraces}
        onSaveFactOverride={handleFactOverride}
        onSaveFactReview={handleFactReview}
        onSaveFactAnchor={handleFactAnchor}
        onSaveRateScheduleAnchor={handleRateScheduleAnchor}
        initialSelectedFactId={requestedEvidenceFactId}
        initialSelectedFieldKey={requestedEvidenceFieldKey}
        initialPage={requestedEvidencePage}
        navigationKey={evidenceNavigationKey}
        evaluationNode={evaluationSection}
        managementNode={(
          <DocumentProjectControls
            documentId={id}
            documentLabel={displayTitle}
            currentProjectId={project?.id ?? doc.project_id ?? null}
            currentProjectName={project?.name ?? null}
            onDocumentProjectChanged={loadAllData}
          />
        )}
      />
    </div>
  );
}



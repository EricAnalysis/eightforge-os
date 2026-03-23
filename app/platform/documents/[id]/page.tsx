'use client';

import { use, useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { isContractInvoicePrimaryDocumentType } from '@/lib/contractInvoicePrimary';
import { DocumentProcessingStatus } from '@/components/DocumentProcessingStatus';
import { extractKeyFacts } from '@/lib/types/extraction';
import type { DocumentDecision } from '@/lib/types/decisions';
import { buildDocumentIntelligence } from '@/lib/documentIntelligence';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import { SummaryCard } from '@/components/document-intelligence/SummaryCard';
import { EntityChips } from '@/components/document-intelligence/EntityChips';
import { DecisionsSection } from '@/components/document-intelligence/DecisionsSection';
import { FlowSection } from '@/components/document-intelligence/FlowSection';
import { ReviewSection } from '@/components/document-intelligence/ReviewSection';
import { SignalsSection } from '@/components/document-intelligence/SignalsSection';
import { AuditSection } from '@/components/document-intelligence/AuditSection';
import { EvidenceSection } from '@/components/document-intelligence/EvidenceSection';
import { AskDocumentSection } from '@/components/document-intelligence/AskDocumentSection';
import { CrossDocChecks } from '@/components/document-intelligence/CrossDocChecks';
import type {
  DetectedEntity,
  DocumentExecutionTrace,
  DocumentSummary,
  GeneratedDecision,
  ReviewErrorType,
  TriggeredWorkflowTask,
} from '@/lib/types/documentIntelligence';

// ─── Constants ────────────────────────────────────────────────────────────────

const PREVIEWABLE_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded:    'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    processing:  'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse',
    extracted:   'bg-sky-500/20 text-sky-400 border border-sky-500/40',
    decisioned:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed:      'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[11px]">
      <span className="w-28 shrink-0 text-[#8B94A3]">{label}</span>
      <span className="text-[#F5F7FA]">{children}</span>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high:     'bg-orange-500/20 text-orange-400 border border-orange-500/40',
    medium:   'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low:      'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {severity}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high:     'bg-orange-500/20 text-orange-400 border border-orange-500/40',
    medium:   'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    normal:   'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    low:      'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[priority] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {priority}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open:       'bg-[#8B5CFF]/20 text-[#B794FF] border border-[#8B5CFF]/40',
    in_progress:'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    resolved:   'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    cancelled:  'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveProject(
  raw: DocumentDetail['projects'],
): { id: string; name: string } | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function titleize(s: string): string {
  return s
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function DecisionSourceBadge({ source }: { source: DecisionRow['source'] }) {
  const map: Record<string, string> = {
    deterministic: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    ai_enriched: 'bg-purple-500/20 text-purple-300 border border-purple-500/40',
    manual: 'bg-blue-500/20 text-blue-300 border border-blue-500/40',
  };
  const cls = map[source] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {source}
    </span>
  );
}

// ─── Document Intelligence helpers ───────────────────────────────────────────

const ENTITY_KEYS = new Set([
  'ticket_number', 'contract_number', 'invoice_number', 'project_name',
  'location', 'date', 'amount', 'material', 'vendor', 'customer',
  'site', 'hauler', 'disposal_site',
]);

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

function taskPriorityFromCanonical(
  priority: DocumentExecutionTrace['flow_tasks'][number]['priority'],
): TriggeredWorkflowTask['priority'] {
  if (priority === 'high') return 'P1';
  if (priority === 'medium') return 'P2';
  return 'P3';
}

function mapCanonicalFlowTaskToTriggeredTask(
  task: DocumentExecutionTrace['flow_tasks'][number],
): TriggeredWorkflowTask {
  return {
    id: task.id,
    title: task.title,
    priority: taskPriorityFromCanonical(task.priority),
    reason: task.expected_outcome,
    status: 'open',
    autoCreated: true,
    flow_type: task.flow_type,
  };
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

function flatScanEntities(
  obj: unknown,
  found: Map<string, string>,
  depth = 0,
): void {
  if (depth > 5 || !obj || typeof obj !== 'object') return;
  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const norm = key.toLowerCase().replace(/[\s-]/g, '_');
    if (ENTITY_KEYS.has(norm) && val != null && !found.has(norm)) {
      const sv = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (sv.length > 0 && sv !== 'null' && sv !== 'undefined') {
        found.set(norm, sv);
      }
    }
    if (typeof val === 'object' && val !== null) {
      if (Array.isArray(val)) {
        for (const item of val) flatScanEntities(item, found, depth + 1);
      } else {
        flatScanEntities(val as Record<string, unknown>, found, depth + 1);
      }
    }
  }
}

function deriveEntities(rows: ExtractionRow[]): { key: string; value: string }[] {
  const found = new Map<string, string>();
  for (const row of rows) flatScanEntities(row.data, found);
  return Array.from(found.entries()).map(([k, v]) => ({ key: k, value: v }));
}

function safeJsonPreview(data: unknown, maxLen = 400): string {
  try {
    const str = JSON.stringify(data, null, 2);
    return str.length > maxLen ? str.slice(0, maxLen) + '\n…' : str;
  } catch {
    return String(data);
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
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
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [persistentDecisions, setPersistentDecisions] = useState<PersistentDecisionRow[]>([]);
  const [persistentDecisionsLoading, setPersistentDecisionsLoading] = useState(false);
  const [workflowTasks, setWorkflowTasks] = useState<WorkflowTaskRow[]>([]);
  const [workflowTasksLoading, setWorkflowTasksLoading] = useState(false);
  const [relatedDocs, setRelatedDocs] = useState<RelatedDocInput[]>([]);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, FeedbackState>>({});
  const [feedbackErrorById, setFeedbackErrorById] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [lastEvalResult, setLastEvalResult] = useState<EvaluateResponse | null>(null);

  const loadAllData = useCallback(async () => {
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
                error: { message: (body as { error?: string })?.error ?? 'Document fetch failed' },
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
      setNotFound(true);
      setLoading(false);
      setExtractionsLoading(false);
      setDecisionsLoading(false);
      setPersistentDecisionsLoading(false);
      setWorkflowTasksLoading(false);
      return;
    }

    const docData = docResult.data as DocumentDetail;
    setDoc(docData);
    setRelatedDocs(docData.relatedDocs ?? []);
    setLoading(false);

    if (!extractionsResult.error && extractionsResult.data) {
      setExtractions(extractionsResult.data as ExtractionRow[]);
    }
    setExtractionsLoading(false);

    if (!decisionsResult.error && decisionsResult.data) {
      setDecisions(decisionsResult.data as DecisionRow[]);
    }
    setDecisionsLoading(false);

    if (!persistentResult.error && persistentResult.data) {
      setPersistentDecisions(persistentResult.data as PersistentDecisionRow[]);
    }
    setPersistentDecisionsLoading(false);

    if (!tasksResult.error && tasksResult.data) {
      setWorkflowTasks(tasksResult.data as WorkflowTaskRow[]);
    }
    setWorkflowTasksLoading(false);

    const loadedDecisions = (decisionsResult.data ?? []) as DecisionRow[];
    const loadedPersistentDecisions = (persistentResult.data ?? []) as PersistentDecisionRow[];
    const generatedPersistentDecisionIds = loadedPersistentDecisions
      .filter((decision) => isCurrentV2GeneratedRecord(decision))
      .map((decision) => decision.id);
    const feedbackDecisionIds = isContractInvoicePrimaryDocumentType(docData.document_type)
      ? generatedPersistentDecisionIds
      : loadedDecisions.map((decision) => decision.id);

    if (feedbackDecisionIds.length > 0) {
      const { data: feedbackRows } = await supabase
        .from('decision_feedback')
        .select('decision_id, is_correct, review_error_type')
        .in('decision_id', feedbackDecisionIds);

      if (feedbackRows) {
        const next: Record<string, FeedbackState> = {};
        for (const row of feedbackRows as Array<{
          decision_id: string;
          is_correct: boolean;
          review_error_type?: ReviewErrorType | null;
        }>) {
          next[row.decision_id] = {
            status: row.is_correct ? 'correct' : 'incorrect',
            reviewErrorType: row.is_correct ? null : (row.review_error_type ?? 'edge_case'),
          };
        }
        setFeedbackMap(next);
      }
    }

    if (docResult.data.storage_path) {
      setFileLoading(true);
      try {
        const fileRes = await fetch(
          `/api/documents/${id}/file${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`,
          { headers: authHeaders },
        );
        if (redirectIfUnauthorized(fileRes, router.replace)) return;
        const fileBody = await fileRes.json().catch(() => ({}));
        if (fileRes.ok && fileBody.signedUrl) {
          setSignedUrl(fileBody.signedUrl);
          setFileExt(fileBody.ext ?? '');
          setFileContentType(fileBody.contentType ?? '');
        } else {
          setFileError(
            (fileBody as { error?: string })?.error ?? 'Could not generate file link',
          );
        }
      } catch {
        setFileError('Failed to fetch file URL');
      } finally {
        setFileLoading(false);
      }
    } else {
      setFileError('No file attached to this document');
    }
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

  const displayEvidence = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.evidence ?? [];
    }
    return intelligence?.evidence ?? [];
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

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

  const displayExtracted = useMemo(() => {
    if (contractInvoicePrimaryMode) {
      return canonicalTrace?.extracted ?? null;
    }
    return intelligence?.extracted ?? null;
  }, [canonicalTrace, contractInvoicePrimaryMode, intelligence]);

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
          href="/platform/documents"
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Documents
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
          href="/platform/documents"
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Documents
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
          href="/platform/documents"
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Documents
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Document not found.</p>
      </div>
    );
  }

  const displayTitle = doc.title ?? doc.name;
  const project      = resolveProject(doc.projects);
  const filename     = doc.storage_path.split('/').at(-1) ?? doc.storage_path;

  const latestExtraction = preferredExtraction;
  // Prefer operator-grade intelligence key facts; fall back to raw extraction key facts.
  const keyFacts = intelligence?.keyFacts?.length
    ? intelligence.keyFacts
    : (latestExtraction ? extractKeyFacts(latestExtraction.data) : []);
  const shouldRenderPrimaryIntelligence = contractInvoicePrimaryMode
    ? displaySummary != null
    : intelligence != null && displaySummary != null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Page header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1">
            <Link
              href="/platform/documents"
              className="text-[11px] text-[#8B5CFF] hover:underline"
            >
              ← Documents
            </Link>
          </div>
          <h2 className="text-sm font-semibold text-[#F5F7FA]">{displayTitle}</h2>
          <p className="text-xs text-[#8B94A3]">
            {doc.document_type
              ? doc.document_type.charAt(0).toUpperCase() + doc.document_type.slice(1)
              : 'Document'}{' '}
            · <StatusBadge status={doc.status} />
          </p>
        </div>
        <div className="shrink-0">
          {signedUrl ? (
            <a
              href={signedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
            >
              Open File
            </a>
          ) : fileError ? (
            <span className="text-[11px] text-red-400">File unavailable</span>
          ) : fileLoading ? (
            <span className="text-[11px] text-[#8B94A3]">Generating link…</span>
          ) : null}
        </div>
      </section>

      {/* Processing status + Reprocess button */}
      <DocumentProcessingStatus
        status={doc.processing_status ?? doc.status}
        processingError={doc.processing_error ?? null}
        documentId={id}
        orgId={orgId ?? undefined}
        onStatusChange={handleStatusChange}
        onProcessed={loadAllData}
      />

      {/* ── Document Intelligence ────────────────────────────────────── */}
      <section className="rounded-lg border border-[#8B5CFF]/30 bg-[#0E0E2A] p-5">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="h-2.5 w-2.5 rounded-full bg-[#8B5CFF] shadow-[0_0_6px_rgba(139,92,255,0.5)]" />
          <h3 className="text-xs font-semibold tracking-wide text-[#F5F7FA]">
            Document Intelligence
          </h3>
        </div>

        {/* ── Intelligence sections ─────────────────────────────────────── */}
        {shouldRenderPrimaryIntelligence && displaySummary && (
          <div className="mb-5 space-y-3">
            {/* 1. Summary */}
            <SummaryCard summary={displaySummary} />

            {/* 2. Entity chips */}
            {displayEntities.length > 0 && (
              <EntityChips entities={displayEntities} />
            )}

            {/* 3. Decisions — grouped by status */}
            <DecisionsSection
              decisions={displayDecisions}
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
            />

            {/* 4. Flow — next actions */}
            <FlowSection
              tasks={displayTasks}
              unavailableMessage={
                contractInvoicePrimaryMode
                  ? contractInvoicePrimaryUnavailableMessage ?? undefined
                  : undefined
              }
            />

            {/* 5. Review — human validation */}
            <ReviewSection documentId={id} orgId={orgId ?? undefined} />

            {/* 6. Signals — attention flags derived from decisions */}
            <SignalsSection decisions={displayDecisions} />

            {/* 7. Evidence and extraction gaps */}
            <EvidenceSection
              evidence={displayEvidence}
              gaps={displayExtractionGaps}
            />

            {/* 7. Ask this document */}
            <AskDocumentSection
              questions={displaySuggestedQuestions}
              documentId={id}
            />

            {/* 8. Cross-doc checks */}
            {intelligence?.comparisons && intelligence.comparisons.length > 0 && (
              <CrossDocChecks comparisons={intelligence.comparisons} />
            )}

            {/* 9. Audit — timeline */}
            <AuditSection
              uploadedAt={doc.created_at}
              processedAt={doc.processed_at}
              decisionsGeneratedAt={persistedDecisionsToShow[0]?.created_at ?? null}
              tasksCreatedAt={persistedTasksToShow[0]?.created_at ?? null}
              currentStatus={doc.processing_status}
              auditNotes={displayAuditNotes}
              nodeTraces={displayNodeTraces}
            />

            {/* 6. Structured extracted data (collapsed) */}
            {displayExtracted && Object.keys(displayExtracted).length > 0 && (
              <details className="rounded-xl border border-white/10 bg-[#0F1117]">
                <summary className="cursor-pointer select-none px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[#8B94A3] hover:text-[#C5CAD4]">
                  Structured Extracted Data
                </summary>
                <pre className="overflow-x-auto px-5 pb-4 pt-2 text-[10px] leading-relaxed text-[#F5F7FA]/80">
                  {JSON.stringify(displayExtracted, null, 2)}
                </pre>
              </details>
            )}

            {/* 7. Raw JSON (collapsed by default) */}
            {latestExtraction && (
              <details className="rounded-xl border border-white/10 bg-[#0F1117]">
                <summary className="cursor-pointer select-none px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[#8B94A3] hover:text-[#C5CAD4]">
                  Raw Extraction JSON
                </summary>
                <pre className="overflow-x-auto px-5 pb-4 pt-2 text-[10px] leading-relaxed text-[#F5F7FA]/60">
                  {JSON.stringify(latestExtraction.data, null, 2)}
                </pre>
              </details>
            )}

            {doc.intelligence_trace && Object.keys(doc.intelligence_trace).length > 0 && (
              <details className="rounded-xl border border-white/10 bg-[#0F1117]">
                <summary className="cursor-pointer select-none px-5 py-3 text-xs font-semibold uppercase tracking-wider text-[#8B94A3] hover:text-[#C5CAD4]">
                  Persisted Execution Trace
                </summary>
                <pre className="overflow-x-auto px-5 pb-4 pt-2 text-[10px] leading-relaxed text-[#F5F7FA]/60">
                  {JSON.stringify(doc.intelligence_trace, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* ── Existing debug sections ──────────────────────────────────── */}

        {/* A — Document Metadata */}
        <div className="mb-4 rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#8B94A3]">
            Metadata
          </div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            <MetaRow label="Title">{displayTitle}</MetaRow>
            <MetaRow label="File name">{doc.name}</MetaRow>
            <MetaRow label="Type">
              {doc.document_type ? titleize(doc.document_type) : <span className="text-[#3a3f5a]">—</span>}
            </MetaRow>
            <MetaRow label="Status"><StatusBadge status={doc.status} /></MetaRow>
            {doc.processing_status && (
              <MetaRow label="Processing"><StatusBadge status={doc.processing_status} /></MetaRow>
            )}
            {doc.domain && <MetaRow label="Domain">{titleize(doc.domain)}</MetaRow>}
            <MetaRow label="Created">{new Date(doc.created_at).toLocaleString()}</MetaRow>
            {doc.processed_at && (
              <MetaRow label="Processed">{new Date(doc.processed_at).toLocaleString()}</MetaRow>
            )}
            {project && <MetaRow label="Project">{project.name}</MetaRow>}
          </div>
        </div>

        {/* B — Extraction Results */}
        <div className="mb-4 rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#8B94A3]">
            Extraction Results
          </div>
          {extractionsLoading ? (
            <p className="text-[11px] text-[#8B94A3]">Loading…</p>
          ) : extractions.length === 0 ? (
            <p className="text-[11px] italic text-[#8B94A3]">No extraction results yet</p>
          ) : (
            <div className="space-y-2">
              {extractions.map((ex) => {
                const d = ex.data as Record<string, unknown>;
                return (
                  <div key={ex.id} className="rounded border border-[#1A1A3E] bg-[#0E0E2A] p-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[10px] text-[#8B94A3]">
                      <span>{new Date(ex.created_at).toLocaleString()}</span>
                      {typeof d.extractor === 'string' && (
                        <span>Source: <span className="text-[#F5F7FA]">{d.extractor}</span></span>
                      )}
                      {typeof d.status === 'string' && <StatusBadge status={d.status} />}
                      {typeof d.confidence === 'number' && (
                        <span>Confidence: <span className="text-[#F5F7FA]">{Math.round(Number(d.confidence) * 100)}%</span></span>
                      )}
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#0A0A20] p-2 text-[10px] leading-relaxed text-[#F5F7FA]/80">
                      {safeJsonPreview(d)}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* C — Detected Entities */}
        <div className="mb-4 rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#8B94A3]">
            Detected Entities
          </div>
          {(() => {
            const entities = deriveEntities(extractions);
            return entities.length === 0 ? (
              <p className="text-[11px] italic text-[#8B94A3]">No detected entities yet</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {entities.map((e) => (
                  <span
                    key={e.key}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#8B5CFF]/25 bg-[#8B5CFF]/10 px-3 py-1 text-[10px]"
                  >
                    <span className="text-[#8B94A3]">{titleize(e.key)}</span>
                    <span className="font-medium text-[#F5F7FA]">{e.value}</span>
                  </span>
                ))}
              </div>
            );
          })()}
        </div>

        {!contractInvoicePrimaryMode && (
          <>
        {/* D — Decisions Generated */}
        <div className="mb-4 rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#8B94A3]">
            Decisions Generated
          </div>
          {persistentDecisionsLoading ? (
            <p className="text-[11px] text-[#8B94A3]">Loading…</p>
          ) : persistedDecisionsToShow.length === 0 ? (
            <p className="text-[11px] italic text-[#8B94A3]">No decisions generated yet</p>
          ) : (
            <div className="space-y-2">
              {persistedDecisionsToShow.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-3 rounded border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2 text-[11px]">
                  <Link href={`/platform/decisions/${d.id}`} className="font-medium text-[#8B5CFF] hover:underline">
                    {d.title}
                  </Link>
                  <span className="text-[10px] text-[#8B94A3]">{titleize(d.decision_type)}</span>
                  <SeverityBadge severity={d.severity} />
                  <StatusBadge status={d.status} />
                  {typeof d.confidence === 'number' && (
                    <span className="text-[10px] text-[#8B94A3]">{Math.round(d.confidence * 100)}%</span>
                  )}
                  <span className="ml-auto text-[10px] text-[#8B94A3]">{new Date(d.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* E — Workflow Tasks Triggered */}
        <div className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#8B94A3]">
            Workflow Tasks Triggered
          </div>
          {workflowTasksLoading ? (
            <p className="text-[11px] text-[#8B94A3]">Loading…</p>
          ) : persistedTasksToShow.length === 0 ? (
            <p className="text-[11px] italic text-[#8B94A3]">No workflow tasks triggered yet</p>
          ) : (
            <div className="space-y-2">
              {persistedTasksToShow.map((t) => (
                <div key={t.id} className="flex flex-wrap items-center gap-3 rounded border border-[#1A1A3E] bg-[#0E0E2A] px-3 py-2 text-[11px]">
                  <Link href={`/platform/workflows/${t.id}`} className="font-medium text-[#8B5CFF] hover:underline">
                    {t.title || titleize(t.task_type)}
                  </Link>
                  <span className="text-[10px] text-[#8B94A3]">{titleize(t.task_type)}</span>
                  <PriorityBadge priority={t.priority} />
                  <TaskStatusBadge status={t.status} />
                  <span className="ml-auto text-[10px] text-[#8B94A3]">{new Date(t.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        )}
      </section>

      {/* Evaluation summary + Evaluate button */}
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
          {lastEvalResult && (
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
          )}
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

      {/* Key Facts from extraction */}
      {keyFacts.length > 0 && (
        <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
          <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Key Facts</div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {keyFacts.map((fact) => (
              <div key={fact.label} className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-3">
                <div className="mb-1 text-[10px] text-[#8B94A3]">{fact.label}</div>
                <div className="text-[11px] font-medium text-[#F5F7FA]">
                  {typeof fact.value === 'boolean'
                    ? fact.value ? 'Yes' : 'No'
                    : fact.value != null
                      ? String(fact.value)
                      : <span className="text-[#3a3f5a]">—</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Metadata */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Details</div>
        <div className="space-y-2">
          <MetaRow label="Title">{displayTitle}</MetaRow>
          <MetaRow label="File name">{doc.name}</MetaRow>
          <MetaRow label="Document type">
            {doc.document_type
              ? doc.document_type.charAt(0).toUpperCase() + doc.document_type.slice(1)
              : <span className="text-[#3a3f5a]">—</span>}
          </MetaRow>
          <MetaRow label="Status">
            <StatusBadge status={doc.status} />
          </MetaRow>
          <MetaRow label="Created">
            {new Date(doc.created_at).toLocaleString()}
          </MetaRow>
          <MetaRow label="Project">
            {project
              ? <span>{project.name}</span>
              : <span className="text-[#3a3f5a]">—</span>}
          </MetaRow>
          <MetaRow label="Storage path">
            <span className="font-mono text-[10px] text-[#8B94A3]">{doc.storage_path}</span>
          </MetaRow>
          <MetaRow label="File">
            <span className="font-mono text-[10px] text-[#8B94A3]">{filename}</span>
          </MetaRow>
        </div>
      </section>

      {/* File actions */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">File</div>

        {fileLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Generating secure link…</p>
        ) : fileError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] text-red-400">{fileError}</p>
            <p className="mt-1 text-[10px] text-[#8B94A3]">
              The file may have been removed from storage, or the server could not generate a link. Try reloading the page.
            </p>
          </div>
        ) : signedUrl ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={signedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
              >
                Open File
              </a>
              <a
                href={signedUrl}
                download={filename}
                rel="noopener noreferrer"
                className="rounded-md border border-[#1A1A3E] px-3 py-2 text-[11px] font-medium text-[#F5F7FA] hover:bg-[#1A1A3E]"
              >
                Download
              </a>
              <span className="text-[10px] text-[#8B94A3]">
                {fileContentType || 'unknown type'}
              </span>
            </div>

            {/* Inline PDF preview */}
            {fileExt === 'pdf' && (
              <div className="overflow-hidden rounded-md border border-[#1A1A3E]">
                <iframe
                  src={`${signedUrl}#toolbar=1&navpanes=0`}
                  title="PDF preview"
                  className="h-[600px] w-full bg-white"
                />
              </div>
            )}

            {/* Inline image preview */}
            {PREVIEWABLE_TYPES.has(fileExt) && fileExt !== 'pdf' && (
              <div className="overflow-hidden rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={signedUrl}
                  alt={filename}
                  className="max-h-[500px] max-w-full rounded object-contain"
                />
              </div>
            )}
          </div>
        ) : !doc.storage_path ? (
          <p className="text-[11px] italic text-[#8B94A3]">No file attached to this document.</p>
        ) : null}
      </section>

      {!contractInvoicePrimaryMode && (
        <>
      {/* Decisions (from decisions table) */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Decisions</div>
        {persistentDecisionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading decisions…</p>
        ) : persistedDecisionsToShow.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No decisions yet. Process the document to generate decisions.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[11px]">
              <thead className="text-[#8B94A3]">
                <tr className="border-b border-[#1A1A3E]">
                  <th className="py-2 pr-3 font-medium">Title</th>
                  <th className="py-2 pr-3 font-medium">Severity</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Confidence</th>
                  <th className="py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="text-[#F5F7FA]">
                {persistedDecisionsToShow.map((d) => (
                  <tr key={d.id} className="border-b border-[#1A1A3E] last:border-b-0">
                    <td className="py-2 pr-3">
                      <Link
                        href={`/platform/decisions/${d.id}`}
                        className="text-[#8B5CFF] hover:underline"
                      >
                        {d.title}
                      </Link>
                      {d.summary && (
                        <div className="mt-0.5 text-[10px] text-[#8B94A3]">{d.summary}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <SeverityBadge severity={d.severity} />
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="py-2 pr-3">
                      {typeof d.confidence === 'number'
                        ? `${Math.round(d.confidence * 100)}%`
                        : <span className="text-[#3a3f5a]">—</span>}
                    </td>
                    <td className="py-2 text-[#8B94A3]">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Workflow Tasks */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Workflow Tasks</div>
        {workflowTasksLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading tasks…</p>
        ) : persistedTasksToShow.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No workflow tasks yet. Tasks are created automatically from decisions.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[11px]">
              <thead className="text-[#8B94A3]">
                <tr className="border-b border-[#1A1A3E]">
                  <th className="py-2 pr-3 font-medium">Title</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Priority</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="text-[#F5F7FA]">
                {persistedTasksToShow.map((t) => (
                  <tr key={t.id} className="border-b border-[#1A1A3E] last:border-b-0">
                    <td className="py-2 pr-3">
                      <Link
                        href={`/platform/workflows/${t.id}`}
                        className="text-[#8B5CFF] hover:underline"
                      >
                        {t.title}
                      </Link>
                      {t.description && (
                        <div className="mt-0.5 text-[10px] text-[#8B94A3] line-clamp-1">
                          {t.description}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3">{titleize(t.task_type)}</td>
                    <td className="py-2 pr-3">
                      <PriorityBadge priority={t.priority} />
                    </td>
                    <td className="py-2 pr-3">
                      <TaskStatusBadge status={t.status} />
                    </td>
                    <td className="py-2 text-[#8B94A3]">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
        </>
      )}

      {/* Extractions */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Extractions</div>
        {extractionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading extractions…</p>
        ) : extractions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No extractions yet.</p>
        ) : (
          <div className="space-y-3">
            {extractions.map((ex) => (
              <div key={ex.id} className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] p-3">
                <p className="mb-2 text-[10px] text-[#8B94A3]">
                  {new Date(ex.created_at).toLocaleString()}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-[#F5F7FA]">
                  {JSON.stringify(ex.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {!contractInvoicePrimaryMode && (
        <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Decision Signals</div>
        {decisionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : decisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No decision signals yet. Run analysis to generate signals.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[11px]">
              <thead className="text-[#8B94A3]">
                <tr className="border-b border-[#1A1A3E]">
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">Confidence</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 text-right font-medium"> </th>
                </tr>
              </thead>
              <tbody className="text-[#F5F7FA]">
                {decisions.map((d) => (
                  <tr key={d.id} className="border-b border-[#1A1A3E] last:border-b-0">
                    <td className="py-2 pr-3">{titleize(d.decision_type)}</td>
                    <td className="py-2 pr-3">
                      {d.decision_value ? titleize(d.decision_value) : <span className="text-[#3a3f5a]">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {typeof d.confidence === 'number'
                        ? `${Math.round(d.confidence * 100)}%`
                        : <span className="text-[#3a3f5a]">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <DecisionSourceBadge source={d.source} />
                    </td>
                    <td className="py-2 text-right">
                      {feedbackMap[d.id]?.status === 'correct' ? (
                        <span className="text-[11px] text-emerald-400">✓</span>
                      ) : feedbackMap[d.id]?.status === 'incorrect' ? (
                        <span className="text-[11px] text-red-400">✗</span>
                      ) : (
                        <span className="inline-flex flex-col items-end gap-1">
                          <span className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleDecisionFeedback(d.id, { isCorrect: true })}
                              className="text-[11px] text-[#8B94A3] hover:text-emerald-400"
                              aria-label="Mark decision correct"
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDecisionFeedback(d.id, { isCorrect: false, reviewErrorType: 'edge_case' })}
                              className="text-[11px] text-[#8B94A3] hover:text-red-400"
                              aria-label="Mark decision incorrect"
                            >
                              ✗
                            </button>
                          </span>
                          {feedbackErrorById[d.id] && (
                            <span className="text-[10px] text-red-400">{feedbackErrorById[d.id]}</span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </div>
  );
}

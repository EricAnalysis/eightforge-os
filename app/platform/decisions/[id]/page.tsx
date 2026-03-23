'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DecisionDetailView } from '@/components/decision-detail/DecisionDetailView';
import {
  type DecisionDetailDocumentRef,
  type DecisionDetailFeedback,
  type DecisionDetailTask,
  resolveDecisionEvidence,
  resolveDecisionExecutiveSummary,
  resolveDecisionMetrics,
  resolveDecisionProcessState,
} from '@/lib/decisionDetail';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
  resolveDecisionSuggestedActions,
} from '@/lib/decisionActions';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import type { ReviewErrorType } from '@/lib/types/documentIntelligence';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';

type DecisionDetail = {
  id: string;
  document_id: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  source: string;
  created_at: string;
  first_detected_at: string | null;
  last_detected_at: string | null;
  resolved_at: string | null;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  details: Record<string, unknown> | null;
  documents?: DecisionDetailDocumentRef | DecisionDetailDocumentRef[];
};

const STATUS_OPTIONS = ['open', 'in_review', 'resolved', 'suppressed'] as const;

function documentRefFromDecision(
  documentValue: DecisionDetail['documents'],
): DecisionDetailDocumentRef {
  if (Array.isArray(documentValue)) return documentValue[0] ?? null;
  return documentValue ?? null;
}

function isNotFoundError(error: { code?: string; details?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'PGRST116') return true;
  return typeof error.details === 'string' && error.details.includes('0 rows');
}

export default function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);

  const [decision, setDecision] = useState<DecisionDetail | null>(null);
  const [relatedTasks, setRelatedTasks] = useState<DecisionDetailTask[]>([]);
  const [feedback, setFeedback] = useState<DecisionDetailFeedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const [statusSaved, setStatusSaved] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState(false);
  const [assignSaved, setAssignSaved] = useState(false);
  const [updatingDueDate, setUpdatingDueDate] = useState(false);
  const [dueDateError, setDueDateError] = useState(false);
  const [dueDateSaved, setDueDateSaved] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackSubmitError, setFeedbackSubmitError] = useState<string | null>(null);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [activityKey, setActivityKey] = useState(0);

  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const assignTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dueDateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(statusTimer.current);
      clearTimeout(assignTimer.current);
      clearTimeout(dueDateTimer.current);
      clearTimeout(feedbackTimer.current);
    };
  }, []);

  const loadFeedbackHistory = async (decisionId: string) => {
    const { data } = await supabase
      .from('decision_feedback')
      .select('id, created_at, is_correct, feedback_type, disposition, decision_status_at_feedback, created_by, review_error_type, metadata')
      .eq('decision_id', decisionId)
      .order('created_at', { ascending: false });

    setFeedback((data ?? []) as DecisionDetailFeedback[]);
  };

  useEffect(() => {
    if (orgLoading) return;

    if (!organizationId) {
      setLoading(false);
      setLoadError('Organization context is unavailable.');
      return;
    }

    const load = async () => {
      setLoading(true);
      setNotFound(false);
      setLoadError(null);
      setDecision(null);
      setRelatedTasks([]);
      setFeedback([]);

      const { data: decisionData, error: decisionError } = await supabase
        .from('decisions')
        .select(
          'id, document_id, decision_type, title, summary, severity, status, confidence, source, created_at, first_detected_at, last_detected_at, resolved_at, due_at, assigned_to, assigned_at, assigned_by, details, documents(id, title, name, processing_status, processed_at)'
        )
        .eq('id', id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (decisionError) {
        if (isNotFoundError(decisionError)) {
          setNotFound(true);
        } else {
          setLoadError('Failed to load the decision detail experience.');
        }
        setLoading(false);
        return;
      }

      if (!decisionData) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setDecision(decisionData as DecisionDetail);

      const { data: taskData } = await supabase
        .from('workflow_tasks')
        .select('id, document_id, task_type, title, description, priority, status, due_at, assigned_to, source_metadata, details, created_at, updated_at')
        .eq('decision_id', id)
        .order('created_at', { ascending: false })
        .limit(20);

      setRelatedTasks((taskData ?? []) as DecisionDetailTask[]);
      await loadFeedbackHistory(id);
      setLoading(false);
    };

    load();
  }, [id, organizationId, orgLoading]);

  const updateStatus = async (newStatus: string) => {
    if (!organizationId || !decision) return;
    setUpdateError(false);
    setStatusSaved(false);
    setUpdatingStatus(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setUpdateError(true);
        return;
      }

      const response = await fetch(`/api/decisions/${decision.id}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (redirectIfUnauthorized(response, router.replace)) return;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setUpdateError(true);
        return;
      }

      setDecision((current) => current ? { ...current, ...body, documents: current.documents } : null);
      clearTimeout(statusTimer.current);
      setStatusSaved(true);
      statusTimer.current = setTimeout(() => setStatusSaved(false), 2000);
      setActivityKey((current) => current + 1);
      await loadFeedbackHistory(decision.id);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const submitFeedback = async (isCorrect: boolean, reviewErrorType?: ReviewErrorType) => {
    if (!organizationId || !decision) return;
    setFeedbackSubmitError(null);
    setFeedbackSaved(false);
    setSubmittingFeedback(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setFeedbackSubmitError('Authentication required.');
        return;
      }

      const response = await fetch(`/api/decisions/${decision.id}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          is_correct: isCorrect,
          review_error_type: isCorrect ? null : reviewErrorType,
        }),
      });

      if (redirectIfUnauthorized(response, router.replace)) return;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedbackSubmitError((body as { error?: string }).error ?? 'Failed to save feedback.');
        return;
      }

      await loadFeedbackHistory(decision.id);
      clearTimeout(feedbackTimer.current);
      setFeedbackSaved(true);
      feedbackTimer.current = setTimeout(() => setFeedbackSaved(false), 2000);
      setActivityKey((current) => current + 1);
    } finally {
      setSubmittingFeedback(false);
    }
  };

  const assignDecision = async (assignedTo: string | null) => {
    if (!organizationId || !decision) return;
    setAssignError(false);
    setAssignSaved(false);
    setAssigning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setAssignError(true);
        return;
      }

      const response = await fetch(`/api/decisions/${decision.id}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ assigned_to: assignedTo }),
      });

      if (redirectIfUnauthorized(response, router.replace)) return;
      if (!response.ok) {
        setAssignError(true);
        return;
      }

      const body = await response.json().catch(() => ({}));
      setDecision((current) => current ? { ...current, ...body, documents: current.documents } : null);
      clearTimeout(assignTimer.current);
      setAssignSaved(true);
      assignTimer.current = setTimeout(() => setAssignSaved(false), 2000);
      setActivityKey((current) => current + 1);
    } finally {
      setAssigning(false);
    }
  };

  const updateDueDate = async (dueAt: string | null) => {
    if (!organizationId || !decision) return;
    setDueDateError(false);
    setDueDateSaved(false);
    setUpdatingDueDate(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setDueDateError(true);
        return;
      }

      const response = await fetch(`/api/decisions/${decision.id}/due-date`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ due_at: dueAt }),
      });

      if (redirectIfUnauthorized(response, router.replace)) return;
      if (!response.ok) {
        setDueDateError(true);
        return;
      }

      const body = await response.json().catch(() => ({}));
      setDecision((current) => current ? { ...current, ...body, documents: current.documents } : null);
      clearTimeout(dueDateTimer.current);
      setDueDateSaved(true);
      dueDateTimer.current = setTimeout(() => setDueDateSaved(false), 2000);
      setActivityKey((current) => current + 1);
    } finally {
      setUpdatingDueDate(false);
    }
  };

  if (loading || orgLoading) {
    return (
      <div className="p-8">
        <Link href="/platform/decisions" className="text-sm text-[#3B82F6] hover:underline">
          Back to decisions
        </Link>
        <p className="mt-3 text-sm text-[#94A3B8]">Loading decision detail...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8">
        <Link href="/platform/decisions" className="text-sm text-[#3B82F6] hover:underline">
          Back to decisions
        </Link>
        <div className="mt-4 rounded-2xl border border-[#EF4444]/30 bg-[#EF4444]/10 p-6">
          <p className="text-sm font-medium text-[#EF4444]">Fetch failure</p>
          <p className="mt-2 text-sm text-[#E5EDF7]">{loadError}</p>
        </div>
      </div>
    );
  }

  if (notFound || !decision) {
    return (
      <div className="p-8">
        <Link href="/platform/decisions" className="text-sm text-[#3B82F6] hover:underline">
          Back to decisions
        </Link>
        <div className="mt-4 rounded-2xl border border-[#2F3B52] bg-[#111827] p-6">
          <p className="text-sm font-medium text-[#E5EDF7]">No decision found</p>
          <p className="mt-2 text-sm text-[#94A3B8]">
            The requested decision does not exist in the active organization context.
          </p>
        </div>
      </div>
    );
  }

  const documentRef = documentRefFromDecision(decision.documents);
  const documentLabel = documentRef?.title ?? documentRef?.name ?? 'Source document unavailable';
  const documentHref = decision.document_id ? `/platform/documents/${decision.document_id}` : null;
  const reason = resolveDecisionReason(decision.details ?? null, decision.summary);
  const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);
  const suggestedActions = resolveDecisionSuggestedActions(decision.details ?? null);
  const projectContext = resolveDecisionProjectContext(decision.details ?? null);
  const openTaskCount = relatedTasks.filter(
    (task) => task.status !== 'resolved' && task.status !== 'cancelled',
  ).length;

  const evidence = resolveDecisionEvidence({
    details: decision.details ?? null,
    confidence: decision.confidence,
    severity: decision.severity,
    source: decision.source,
    documentLabel: documentRef ? documentLabel : null,
  });

  const summary = resolveDecisionExecutiveSummary({
    decisionTitle: decision.title,
    documentLabel: documentRef ? documentLabel : null,
    projectContextLabel: projectContext?.label ?? null,
    reason,
    impact: typeof decision.details?.impact === 'string' ? decision.details.impact : null,
    primaryAction,
    hasStructuredEvidence: evidence.hasStructuredEvidence,
    relatedTaskCount: openTaskCount,
    details: decision.details ?? null,
  });

  const processState = resolveDecisionProcessState({
    decisionStatus: decision.status,
    documentProcessingStatus: documentRef?.processing_status ?? null,
    hasDocument: Boolean(documentRef),
    relatedTaskCount: openTaskCount,
    feedbackCount: feedback.length,
  });

  const metrics = resolveDecisionMetrics({
    confidence: decision.confidence,
    severity: decision.severity,
    relatedTaskCount: openTaskCount,
    feedbackCount: feedback.length,
    hasPrimaryAction: Boolean(primaryAction),
    detectedAt: decision.last_detected_at ?? decision.first_detected_at ?? decision.created_at,
  });

  return (
    <DecisionDetailView
      decision={decision}
      documentRef={documentRef}
      documentLabel={documentLabel}
      documentHref={documentHref}
      projectContextLabel={projectContext?.label ?? null}
      reason={reason}
      primaryAction={primaryAction}
      suggestedActions={suggestedActions}
      summary={summary}
      evidence={evidence}
      processState={processState}
      metrics={metrics}
      relatedTasks={relatedTasks}
      feedback={feedback}
      members={members}
      organizationId={organizationId}
      activityRefreshKey={activityKey}
      statusControl={{
        options: STATUS_OPTIONS,
        updating: updatingStatus,
        saved: statusSaved,
        error: updateError,
        onChange: updateStatus,
      }}
      assignmentControl={{
        saving: assigning,
        saved: assignSaved,
        error: assignError,
        onChange: assignDecision,
      }}
      dueDateControl={{
        saving: updatingDueDate,
        saved: dueDateSaved,
        error: dueDateError,
        onChange: updateDueDate,
      }}
      feedbackControl={{
        saving: submittingFeedback,
        saved: feedbackSaved,
        error: feedbackSubmitError,
        onSubmit: submitFeedback,
      }}
    />
  );
}

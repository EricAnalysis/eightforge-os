'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { DocumentProcessingStatus } from '@/components/DocumentProcessingStatus';
import { extractKeyFacts } from '@/lib/types/extraction';
import type { DocumentDecision } from '@/lib/types/decisions';

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET = 'documents';
const SIGNED_URL_EXPIRY = 300;

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
  created_at: string;
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded:   'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    processing: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    processed:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed:     'bg-red-500/20 text-red-400 border border-red-500/40',
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [doc, setDoc]           = useState<DocumentDetail | null>(null);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [signedUrl, setSignedUrl]   = useState<string | null>(null);
  const [fileError, setFileError]   = useState(false);
  const [extractions, setExtractions]     = useState<ExtractionRow[]>([]);
  const [extractionsLoading, setExtractionsLoading] = useState(false);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [persistentDecisions, setPersistentDecisions] = useState<PersistentDecisionRow[]>([]);
  const [persistentDecisionsLoading, setPersistentDecisionsLoading] = useState(false);
  const [workflowTasks, setWorkflowTasks] = useState<WorkflowTaskRow[]>([]);
  const [workflowTasksLoading, setWorkflowTasksLoading] = useState(false);
  const [feedbackMap, setFeedbackMap] = useState<
    Record<string, 'correct' | 'incorrect'>
  >({});
  const [refreshKey, setRefreshKey] = useState(0);

  const loadAllData = useCallback(async () => {
    if (!organizationId) return;

    setDoc(null);
    setSignedUrl(null);
    setFileError(false);
    setExtractions([]);
    setDecisions([]);
    setPersistentDecisions([]);
    setWorkflowTasks([]);
    setFeedbackMap({});
    setNotFound(false);
    setLoading(true);
    setExtractionsLoading(true);
    setDecisionsLoading(true);
    setPersistentDecisionsLoading(true);
    setWorkflowTasksLoading(true);

    const [docResult, extractionsResult, decisionsResult, persistentResult, tasksResult] =
      await Promise.all([
        supabase
          .from('documents')
          .select(
            'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name)',
          )
          .eq('id', id)
          .eq('organization_id', organizationId)
          .single(),
        supabase
          .from('document_extractions')
          .select('id, data, created_at')
          .eq('document_id', id)
          .order('created_at', { ascending: false }),
        supabase
          .from('document_decisions')
          .select('id, decision_type, decision_value, confidence, source, created_at')
          .eq('document_id', id)
          .order('created_at', { ascending: true }),
        supabase
          .from('decisions')
          .select('id, decision_type, title, summary, severity, status, confidence, created_at')
          .eq('document_id', id)
          .order('created_at', { ascending: true }),
        supabase
          .from('workflow_tasks')
          .select('id, task_type, title, description, priority, status, decision_id, created_at')
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

    setDoc(docResult.data as DocumentDetail);
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
    if (loadedDecisions.length > 0) {
      const { data: feedbackRows } = await supabase
        .from('decision_feedback')
        .select('decision_id, is_correct')
        .in('decision_id', loadedDecisions.map((d) => d.id));

      if (feedbackRows) {
        const next: Record<string, 'correct' | 'incorrect'> = {};
        for (const row of feedbackRows as Array<{ decision_id: string; is_correct: boolean }>) {
          next[row.decision_id] = row.is_correct ? 'correct' : 'incorrect';
        }
        setFeedbackMap(next);
      }
    }

    if (docResult.data.storage_path) {
      const { data: urlData, error: urlError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(docResult.data.storage_path as string, SIGNED_URL_EXPIRY);

      if (!urlError && urlData?.signedUrl) {
        setSignedUrl(urlData.signedUrl);
      } else {
        setFileError(true);
      }
    } else {
      setFileError(true);
    }
  }, [id, organizationId]);

  useEffect(() => {
    if (orgLoading || !organizationId) return;
    loadAllData();
  }, [orgLoading, organizationId, loadAllData, refreshKey]);

  const handleDecisionFeedback = async (
    decisionId: string,
    isCorrect: boolean,
  ) => {
    if (!organizationId) return;
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      if (!userId) return;

      await supabase
        .from('decision_feedback')
        .upsert(
          {
            decision_id: decisionId,
            organization_id: organizationId,
            is_correct: isCorrect,
            reviewed_by: userId,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'decision_id,reviewed_by' },
        );

      setFeedbackMap((prev) => ({
        ...prev,
        [decisionId]: isCorrect ? 'correct' : 'incorrect',
      }));
    } catch {
      // Silently handle feedback errors
    }
  };

  const handleStatusChange = (newStatus: string) => {
    setDoc((prev) => (prev ? { ...prev, status: newStatus } : prev));
    if (newStatus === 'processed') {
      setRefreshKey((k) => k + 1);
    }
  };

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

  const latestExtraction = extractions[0] ?? null;
  const keyFacts = latestExtraction ? extractKeyFacts(latestExtraction.data) : [];

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
              View File
            </a>
          ) : fileError ? (
            <span className="text-[11px] text-red-400">File unavailable</span>
          ) : (
            <span className="text-[11px] text-[#8B94A3]">Generating link…</span>
          )}
        </div>
      </section>

      {/* Processing status + Reprocess button */}
      <DocumentProcessingStatus
        status={doc.status}
        documentId={id}
        onStatusChange={handleStatusChange}
      />

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
        {fileError ? (
          <p className="text-[11px] text-red-400">
            File unavailable. The storage object may have been removed.
          </p>
        ) : signedUrl ? (
          <div className="flex flex-wrap gap-2">
            <a
              href={signedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
            >
              View File
            </a>
            <a
              href={signedUrl}
              download={filename}
              rel="noopener noreferrer"
              className="rounded-md border border-[#1A1A3E] px-3 py-2 text-[11px] font-medium text-[#F5F7FA] hover:bg-[#1A1A3E]"
            >
              Download
            </a>
          </div>
        ) : (
          <p className="text-[11px] text-[#8B94A3]">Generating secure link…</p>
        )}
      </section>

      {/* Decisions (from decisions table) */}
      <section className="rounded-lg border border-white/5 bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Decisions</div>
        {persistentDecisionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading decisions…</p>
        ) : persistentDecisions.length === 0 ? (
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
                {persistentDecisions.map((d) => (
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
        ) : workflowTasks.length === 0 ? (
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
                {workflowTasks.map((t) => (
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

      {/* Document Decisions (raw engine output) */}
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
                      {feedbackMap[d.id] === 'correct' ? (
                        <span className="text-[11px] text-emerald-400">✓</span>
                      ) : feedbackMap[d.id] === 'incorrect' ? (
                        <span className="text-[11px] text-red-400">✗</span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleDecisionFeedback(d.id, true)}
                            className="text-[11px] text-[#8B94A3] hover:text-emerald-400"
                            aria-label="Mark decision correct"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDecisionFeedback(d.id, false)}
                            className="text-[11px] text-[#8B94A3] hover:text-red-400"
                            aria-label="Mark decision incorrect"
                          >
                            ✗
                          </button>
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
    </div>
  );
}

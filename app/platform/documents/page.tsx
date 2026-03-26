'use client';

import Link from 'next/link';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  buildDocumentWorkspaceItems,
  filterDocumentWorkspaceItems,
  groupDocumentWorkspaceItems,
  sortDocumentWorkspaceItems,
  summarizeDocumentWorkspaceItems,
  type DocumentReviewStatus,
  type DocumentWorkspaceAttentionFilter,
  type DocumentWorkspaceDocRow,
  type DocumentWorkspaceGroup,
  type DocumentWorkspaceItem,
  type DocumentWorkspaceMode,
  type DocumentWorkspaceRecentFilter,
  type DocumentWorkspaceReviewRow,
  type DocumentWorkspaceSort,
  type DocumentWorkspaceTone,
} from '@/lib/documentWorkspace';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';

type UploadedDocRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string;
  created_at: string;
};

type ProjectOption = {
  id: string;
  name: string;
};

const DOC_TYPES = [
  'contract',
  'invoice',
  'report',
  'policy',
  'procedure',
  'specification',
  'other',
] as const;

const WORKSPACE_MODES: Array<{
  key: DocumentWorkspaceMode;
  label: string;
  description: string;
}> = [
  {
    key: 'all',
    label: 'All Documents',
    description: 'Global scan across every record in the workspace.',
  },
  {
    key: 'needs_review',
    label: 'Needs Review',
    description: 'Focus on documents still carrying review or finding pressure.',
  },
  {
    key: 'contracts',
    label: 'Contracts',
    description: 'Rate, contract, and source-of-truth review.',
  },
  {
    key: 'invoices',
    label: 'Invoices',
    description: 'Billing-side verification and payment support.',
  },
  {
    key: 'unlinked',
    label: 'Unlinked',
    description: 'Records not yet attached to an active project.',
  },
];

const SORT_OPTIONS: Array<{ value: DocumentWorkspaceSort; label: string }> = [
  { value: 'updated_desc', label: 'Updated newest' },
  { value: 'created_desc', label: 'Created newest' },
  { value: 'findings_desc', label: 'Most findings' },
  { value: 'title_asc', label: 'Title A-Z' },
];

const ATTENTION_OPTIONS: Array<{
  value: DocumentWorkspaceAttentionFilter;
  label: string;
}> = [
  { value: '', label: 'All attention states' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'findings', label: 'Has findings' },
  { value: 'blocked', label: 'Blocked / failed' },
  { value: 'clear', label: 'Operationally clear' },
];

const RECENT_OPTIONS: Array<{
  value: DocumentWorkspaceRecentFilter;
  label: string;
}> = [
  { value: '', label: 'Any recent activity' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const DOCUMENT_SELECT =
  'id, title, name, document_type, processing_status, processing_error, created_at, processed_at, domain, project_id, intelligence_trace, projects(id, name, code)';

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';

  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Unavailable';
  return new Date(value).toLocaleString();
}

function toneClasses(tone: DocumentWorkspaceTone): string {
  switch (tone) {
    case 'danger':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'info':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    default:
      return 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3]';
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded: 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3]',
    processing: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    extracted: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    decisioned: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  };

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
        map[status] ?? 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3]'
      }`}
    >
      {titleize(status)}
    </span>
  );
}

function ReviewBadge({ status }: { status: DocumentReviewStatus }) {
  const map: Record<DocumentReviewStatus, string> = {
    not_reviewed: 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3]',
    in_review: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    approved: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    needs_correction: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  };

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${map[status]}`}
    >
      {titleize(status)}
    </span>
  );
}

function WorkspaceStatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: DocumentWorkspaceTone;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClasses(tone)}`}
    >
      {label}
    </span>
  );
}

function WorkspaceMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="border-l border-[#1A1A3E] pl-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B94A3]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[#F5F7FA]">
        {value}
      </p>
      <p className="mt-1 text-[11px] text-[#8B94A3]">{detail}</p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  minWidthClass = 'min-w-[160px]',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  minWidthClass?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
      <span className="font-medium text-[#F5F7FA]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${minWidthClass} rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]`}
      >
        {options.map((option) => (
          <option key={`${label}-${option.value || 'all'}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModeButton({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-[#8B5CFF]/50 bg-[#8B5CFF]/10 text-[#F5F7FA]'
          : 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3] hover:border-[#3B82F6]/30 hover:text-[#F5F7FA]'
      }`}
    >
      <span className="block text-[10px] font-semibold uppercase tracking-[0.18em]">
        {label}
      </span>
      <span className="mt-1 block text-[11px] leading-5">{description}</span>
    </button>
  );
}

function LayoutToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors ${
        active
          ? 'bg-[#3B82F6] text-white'
          : 'bg-[#0A0A20] text-[#8B94A3] hover:text-[#F5F7FA]'
      }`}
    >
      {label}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={`document-skeleton-${index}`}
          className="rounded-lg border border-[#1A1A3E] bg-[#0A0A20] px-4 py-4"
        >
          <div className="h-3 w-32 animate-pulse rounded bg-[#1A1A3E]" />
          <div className="mt-3 h-3 w-64 animate-pulse rounded bg-[#1A1A3E]" />
          <div className="mt-3 h-3 w-48 animate-pulse rounded bg-[#1A1A3E]" />
        </div>
      ))}
    </div>
  );
}

function handleOpenKey(
  event: KeyboardEvent<HTMLDivElement>,
  onOpen: () => void,
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onOpen();
  }
}

function DocumentRow({
  document,
  showProject,
  onOpen,
  onReprocess,
  isProcessing,
  processError,
}: {
  document: DocumentWorkspaceItem;
  showProject: boolean;
  onOpen: () => void;
  onReprocess: () => void;
  isProcessing: boolean;
  processError?: string | null;
}) {
  const canReprocess =
    document.processingStatus === 'uploaded' ||
    document.processingStatus === 'failed' ||
    document.processingStatus === 'extracted';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => handleOpenKey(event, onOpen)}
      className="group flex items-start justify-between gap-4 border-b border-[#1A1A3E] px-4 py-4 text-left transition-colors hover:bg-[#12122E] last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={document.documentHref}
            onClick={(event) => event.stopPropagation()}
            className="text-[13px] font-semibold text-[#F5F7FA] hover:text-[#8B5CFF]"
          >
            {document.title}
          </Link>
          <WorkspaceStatusBadge
            label={document.workspaceStatusLabel}
            tone={document.workspaceTone}
          />
          <StatusBadge status={document.processingStatus} />
          {document.reviewStatus !== 'not_reviewed' ? (
            <ReviewBadge status={document.reviewStatus} />
          ) : null}
          {document.isUnlinked ? (
            <span className="inline-flex rounded-full border border-[#1A1A3E] bg-[#111827] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#C7D2E3]">
              Unlinked
            </span>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-[#8B94A3]">
          <span>{document.documentTypeLabel}</span>
          {document.domain ? <span>{titleize(document.domain)}</span> : null}
          {showProject ? (
            document.projectHref ? (
              <Link
                href={document.projectHref}
                onClick={(event) => event.stopPropagation()}
                className="text-[#8B5CFF] hover:underline"
              >
                {document.projectCode
                  ? `${document.projectName} / ${document.projectCode}`
                  : document.projectName}
              </Link>
            ) : (
              <span>Unlinked project</span>
            )
          ) : null}
          <span>Created {formatTimestamp(document.createdAt)}</span>
          <span>Updated {formatTimestamp(document.latestActivityAt)}</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[#8B94A3]">
          <span>
            {document.unresolvedFindingCount > 0
              ? `${document.unresolvedFindingCount} unresolved finding${document.unresolvedFindingCount === 1 ? '' : 's'}`
              : 'No open findings'}
          </span>
          {document.pendingActionCount > 0 ? (
            <span>
              {document.pendingActionCount} pending action{document.pendingActionCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {document.blockedCount > 0 ? (
            <span>
              {document.blockedCount} blocked signal{document.blockedCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        {document.processingError ? (
          <p className="mt-2 text-[11px] text-red-400">
            Processing error: {document.processingError}
          </p>
        ) : null}
        {processError ? (
          <p className="mt-2 text-[11px] text-red-400">
            Reprocess failed: {processError}
          </p>
        ) : null}
      </div>

      <div
        className="flex shrink-0 flex-col items-end gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <Link
          href={document.documentHref}
          className="text-[11px] font-medium text-[#8B5CFF] hover:underline"
        >
          Open
        </Link>
        {canReprocess ? (
          isProcessing ? (
            <span className="text-[11px] text-[#8B94A3]">Processing...</span>
          ) : (
            <button
              type="button"
              onClick={onReprocess}
              className="text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
            >
              {document.processingStatus === 'uploaded' ? 'Process' : 'Reprocess'}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function GroupSection({
  group,
  collapsed,
  onToggle,
  onOpenDocument,
  onReprocess,
  processingIds,
  processErrors,
}: {
  group: DocumentWorkspaceGroup;
  collapsed: boolean;
  onToggle: () => void;
  onOpenDocument: (href: string) => void;
  onReprocess: (documentId: string) => void;
  processingIds: Set<string>;
  processErrors: Record<string, string>;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-[#1A1A3E] bg-[#0E0E2A]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1A1A3E] px-4 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[#F5F7FA]">
              {group.projectName}
            </h3>
            {group.projectCode ? (
              <span className="rounded-full border border-[#1A1A3E] bg-[#111827] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#C7D2E3]">
                {group.projectCode}
              </span>
            ) : null}
            {group.isUnlinked ? (
              <span className="rounded-full border border-[#1A1A3E] bg-[#111827] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#C7D2E3]">
                Unlinked
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-[#8B94A3]">
            <span>{group.totalDocuments} docs</span>
            {group.needsReviewCount > 0 ? (
              <span className="text-amber-300">
                {group.needsReviewCount} need review
              </span>
            ) : null}
            {group.unresolvedFindingCount > 0 ? (
              <span className="text-red-300">
                {group.unresolvedFindingCount} findings
              </span>
            ) : null}
            {group.blockedCount > 0 ? (
              <span className="text-red-300">
                {group.blockedCount} blocked
              </span>
            ) : null}
            <span>Updated {formatTimestamp(group.lastUpdatedAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {group.projectHref ? (
            <Link
              href={group.projectHref}
              className="rounded-md border border-[#2F3B52] bg-[#111827] px-3 py-2 text-[11px] font-medium text-[#C7D2E3] hover:border-[#3B82F6]/40 hover:text-[#F5F7FA]"
            >
              Open Project
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
        </div>
      </div>

      {!collapsed ? (
        <div>
          {group.documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              showProject={false}
              onOpen={() => onOpenDocument(document.documentHref)}
              onReprocess={() => onReprocess(document.id)}
              isProcessing={processingIds.has(document.id)}
              processError={processErrors[document.id] ?? null}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function UploadModal({
  orgId,
  onClose,
  onUploaded,
  onUnauthorized,
}: {
  orgId: string;
  onClose: () => void;
  onUploaded: (params: {
    doc: UploadedDocRow;
    analyzePromise: Promise<Response>;
  }) => void;
  onUnauthorized?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [domain, setDomain] = useState('');
  const [projectId, setProjectId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('projects')
      .select('id, name')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => {
        if (data) setProjects(data as ProjectOption[]);
      });
  }, [orgId]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFile(picked);

    if (picked && !title.trim()) {
      setTitle(picked.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!file) {
      setError('Select a file.');
      return;
    }

    if (!title.trim()) {
      setError('Title is required.');
      return;
    }

    setUploading(true);

    try {
      const {
        data: { session: uploadSession },
      } = await supabase.auth.getSession();

      const form = new FormData();
      form.append('title', title.trim());
      form.append('documentType', documentType);
      form.append('domain', domain.trim());
      form.append('orgId', orgId);
      form.append('projectId', projectId);
      form.append('file', file);

      const uploadRes = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: uploadSession?.access_token
          ? { Authorization: `Bearer ${uploadSession.access_token}` }
          : {},
        body: form,
      });

      if (uploadRes.status === 401) {
        onUnauthorized?.();
        return;
      }

      const uploadJson = await uploadRes.json().catch(() => null);
      if (!uploadRes.ok || !uploadJson?.ok || !uploadJson?.doc) {
        const message =
          uploadJson?.error?.message ||
          (typeof uploadJson?.error === 'string' ? uploadJson.error : null) ||
          `Upload failed (${uploadRes.status})`;
        setError(message);
        return;
      }

      const insertedDoc = uploadJson.doc as UploadedDocRow;
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const processPromise = fetch('/api/documents/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ documentId: insertedDoc.id }),
      });

      onUploaded({
        doc: insertedDoc,
        analyzePromise: processPromise,
      });
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : 'An unexpected error occurred.',
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#F5F7FA]">
            Upload Document
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-[#8B94A3] hover:text-[#F5F7FA]"
            aria-label="Close"
          >
            x
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Q1 Compliance Report"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3A3F5A] outline-none focus:border-[#8B5CFF]"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Document Type
            </label>
            <select
              aria-label="Document Type"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
            >
              <option value="">Select type...</option>
              {DOC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {titleize(type)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Domain{' '}
              <span className="font-normal text-[#8B94A3]">
                (optional - used for rule matching)
              </span>
            </label>
            <input
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="e.g. debris_ops, logistics, finance"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3A3F5A] outline-none focus:border-[#8B5CFF]"
            />
          </div>

          {projects.length > 0 ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
                Project{' '}
                <span className="font-normal text-[#8B94A3]">(optional)</span>
              </label>
              <select
                aria-label="Project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
              >
                <option value="">None</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              File <span className="text-red-400">*</span>
            </label>
            <input
              aria-label="File"
              type="file"
              accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-[#8B5CFF] file:px-3 file:py-1 file:text-[10px] file:font-medium file:text-white hover:file:bg-[#7A4FE8]"
            />
            <p className="mt-1 text-[10px] text-[#3A3F5A]">
              PDF, DOCX, TXT, PNG, JPG, CSV, XLSX
            </p>
          </div>

          {error ? <p className="text-[11px] text-red-400">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading}
              className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const orgId = organizationId;

  const [documents, setDocuments] = useState<DocumentWorkspaceDocRow[]>([]);
  const [reviews, setReviews] = useState<DocumentWorkspaceReviewRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [workspaceWarning, setWorkspaceWarning] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [processErrors, setProcessErrors] = useState<Record<string, string>>({});

  const [workspaceMode, setWorkspaceMode] =
    useState<DocumentWorkspaceMode>('all');
  const [layoutMode, setLayoutMode] = useState<'grouped' | 'list'>('grouped');
  const [searchValue, setSearchValue] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedDocumentType, setSelectedDocumentType] = useState('');
  const [selectedProcessingStatus, setSelectedProcessingStatus] = useState('');
  const [selectedAttention, setSelectedAttention] =
    useState<DocumentWorkspaceAttentionFilter>('');
  const [selectedRecent, setSelectedRecent] =
    useState<DocumentWorkspaceRecentFilter>('');
  const [sortBy, setSortBy] =
    useState<DocumentWorkspaceSort>('updated_desc');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  );

  const loading = orgLoading || docsLoading;

  const fetchWorkspaceData = useCallback(async (currentOrgId: string) => {
    setDocsLoading(true);
    setDocsError(null);
    setWorkspaceWarning(null);

    try {
      const [documentsResult, reviewsResult] = await Promise.all([
        supabase
          .from('documents')
          .select(DOCUMENT_SELECT)
          .eq('organization_id', currentOrgId)
          .order('created_at', { ascending: false }),
        supabase
          .from('document_reviews')
          .select('document_id, status, reviewed_at')
          .eq('organization_id', currentOrgId),
      ]);

      if (documentsResult.error) {
        setDocsError('Failed to load documents.');
        setDocuments([]);
        setReviews([]);
        setDocsLoading(false);
        return;
      }

      setDocuments((documentsResult.data ?? []) as DocumentWorkspaceDocRow[]);

      if (reviewsResult.error) {
        setReviews([]);
        setWorkspaceWarning(
          'Document review state is unavailable. Needs Review filters may be incomplete.',
        );
      } else {
        setReviews((reviewsResult.data ?? []) as DocumentWorkspaceReviewRow[]);
      }
    } catch {
      setDocsError('Failed to load documents.');
      setDocuments([]);
      setReviews([]);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  const reprocessDoc = useCallback(async (docId: string) => {
    setProcessingIds((previous) => new Set(previous).add(docId));
    setProcessErrors((previous) => {
      const next = { ...previous };
      delete next[docId];
      return next;
    });

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setProcessErrors((previous) => ({
          ...previous,
          [docId]: 'Authentication required.',
        }));
        return;
      }

      const response = await fetch('/api/documents/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ documentId: docId }),
      });

      if (redirectIfUnauthorized(response, router.replace)) {
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setProcessErrors((previous) => ({
          ...previous,
          [docId]: body?.message ?? 'Failed',
        }));
        return;
      }

      const finalStatus = (body?.processing_status as string) ?? 'decisioned';
      setDocuments((previous) =>
        previous.map((document) =>
          document.id === docId
            ? {
                ...document,
                processing_status: finalStatus,
              }
            : document,
        ),
      );

      if (orgId) {
        await fetchWorkspaceData(orgId);
      }
    } catch {
      setProcessErrors((previous) => ({
        ...previous,
        [docId]: 'Failed',
      }));
    } finally {
      setProcessingIds((previous) => {
        const next = new Set(previous);
        next.delete(docId);
        return next;
      });
    }
  }, [fetchWorkspaceData, orgId, router]);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      return;
    }

    void fetchWorkspaceData(organizationId);
  }, [fetchWorkspaceData, organizationId, orgLoading]);

  const workspaceItems = useMemo(
    () => buildDocumentWorkspaceItems({ documents, reviews }),
    [documents, reviews],
  );

  const filteredWorkspaceItems = useMemo(
    () =>
      filterDocumentWorkspaceItems(workspaceItems, {
        search: searchValue,
        mode: workspaceMode,
        projectId: selectedProjectId,
        documentType: selectedDocumentType,
        processingStatus: selectedProcessingStatus,
        attention: selectedAttention,
        recent: selectedRecent,
      }),
    [
      searchValue,
      selectedAttention,
      selectedDocumentType,
      selectedProcessingStatus,
      selectedProjectId,
      selectedRecent,
      workspaceItems,
      workspaceMode,
    ],
  );

  const sortedWorkspaceItems = useMemo(
    () => sortDocumentWorkspaceItems(filteredWorkspaceItems, sortBy),
    [filteredWorkspaceItems, sortBy],
  );

  const groupedWorkspaceItems = useMemo(
    () => groupDocumentWorkspaceItems(filteredWorkspaceItems, sortBy),
    [filteredWorkspaceItems, sortBy],
  );

  const workspaceSummary = useMemo(
    () => summarizeDocumentWorkspaceItems(workspaceItems),
    [workspaceItems],
  );

  const filteredSummary = useMemo(
    () => summarizeDocumentWorkspaceItems(filteredWorkspaceItems),
    [filteredWorkspaceItems],
  );

  const projectOptions = useMemo(() => {
    const entries = new Map<
      string,
      { value: string; label: string; projectName: string }
    >();

    for (const item of workspaceItems) {
      if (!item.projectId || entries.has(item.projectId)) {
        continue;
      }

      entries.set(item.projectId, {
        value: item.projectId,
        label: item.projectCode
          ? `${item.projectName} / ${item.projectCode}`
          : (item.projectName ?? 'Unnamed Project'),
        projectName: item.projectName ?? 'Unnamed Project',
      });
    }

    const options = Array.from(entries.values())
      .sort((left, right) => left.projectName.localeCompare(right.projectName))
      .map((option) => ({
        value: option.value,
        label: option.label,
      }));

    return [
      { value: '', label: 'All projects' },
      ...options,
      { value: '__unlinked', label: 'Unlinked documents' },
    ];
  }, [workspaceItems]);

  const documentTypeOptions = useMemo(() => {
    const entries = new Map<string, string>();

    for (const item of workspaceItems) {
      if (item.documentType) {
        entries.set(item.documentType, item.documentTypeLabel);
      }
    }

    return [
      { value: '', label: 'All document types' },
      ...Array.from(entries.entries())
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [workspaceItems]);

  const processingStatusOptions = useMemo(() => {
    const entries = new Map<string, string>();

    for (const item of workspaceItems) {
      entries.set(item.processingStatus, item.processingStatusLabel);
    }

    return [
      { value: '', label: 'All processing states' },
      ...Array.from(entries.entries())
        .sort((left, right) => left[1].localeCompare(right[1]))
        .map(([value, label]) => ({ value, label })),
    ];
  }, [workspaceItems]);

  const modeMeta = useMemo(
    () =>
      WORKSPACE_MODES.find((mode) => mode.key === workspaceMode) ??
      WORKSPACE_MODES[0],
    [workspaceMode],
  );

  const hasWorkspaceScope =
    workspaceMode !== 'all' ||
    searchValue.trim().length > 0 ||
    selectedProjectId !== '' ||
    selectedDocumentType !== '' ||
    selectedProcessingStatus !== '' ||
    selectedAttention !== '' ||
    selectedRecent !== '';
  const visibleSummary = hasWorkspaceScope ? filteredSummary : workspaceSummary;

  useEffect(() => {
    setCollapsedGroups((previous) => {
      const next: Record<string, boolean> = {};

      for (const group of groupedWorkspaceItems) {
        next[group.key] = previous[group.key] ?? false;
      }

      return next;
    });
  }, [groupedWorkspaceItems]);

  const clearWorkspaceScope = useCallback(() => {
    setWorkspaceMode('all');
    setSearchValue('');
    setSelectedProjectId('');
    setSelectedDocumentType('');
    setSelectedProcessingStatus('');
    setSelectedAttention('');
    setSelectedRecent('');
  }, []);

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((previous) => ({
      ...previous,
      [groupKey]: !previous[groupKey],
    }));
  }, []);

  const handleOpenDocument = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );

  const handleRefresh = useCallback(() => {
    if (!orgId) {
      return;
    }

    void fetchWorkspaceData(orgId);
  }, [fetchWorkspaceData, orgId]);

  const handleUploaded = useCallback(
    ({
      doc,
      analyzePromise,
    }: {
      doc: UploadedDocRow;
      analyzePromise: Promise<Response>;
    }) => {
      setModalOpen(false);
      setDocuments((previous) => [
        {
          id: doc.id,
          title: doc.title,
          name: doc.name,
          document_type: doc.document_type,
          processing_status:
            doc.processing_status === 'uploaded'
              ? 'processing'
              : doc.processing_status,
          processing_error: null,
          created_at: doc.created_at,
          processed_at: null,
          domain: null,
          project_id: null,
          intelligence_trace: null,
          projects: null,
        },
        ...previous.filter((existing) => existing.id !== doc.id),
      ]);
      setProcessingIds((previous) => new Set(previous).add(doc.id));
      setProcessErrors((previous) => {
        const next = { ...previous };
        delete next[doc.id];
        return next;
      });

      void analyzePromise
        .then(async (response) => {
          if (redirectIfUnauthorized(response, router.replace)) {
            return;
          }

          const body = await response.json().catch(() => ({}));

          if (!response.ok) {
            setProcessErrors((previous) => ({
              ...previous,
              [doc.id]:
                (body as { message?: string }).message ??
                `Process failed (${response.status})`,
            }));
            return;
          }

          const finalStatus =
            (body as { processing_status?: string }).processing_status ??
            'decisioned';
          setDocuments((previous) =>
            previous.map((document) =>
              document.id === doc.id
                ? {
                    ...document,
                    processing_status: finalStatus,
                  }
                : document,
            ),
          );

          if (orgId) {
            await fetchWorkspaceData(orgId);
          }
        })
        .catch((error) => {
          setProcessErrors((previous) => ({
            ...previous,
            [doc.id]:
              error instanceof Error ? error.message : 'Process failed.',
          }));
        })
        .finally(() => {
          setProcessingIds((previous) => {
            const next = new Set(previous);
            next.delete(doc.id);
            return next;
          });
        });
    },
    [fetchWorkspaceData, orgId, router],
  );

  const workspaceUnavailable = !orgLoading && !orgId;

  if (workspaceUnavailable) {
    return (
      <div className="space-y-4">
        <section className="flex items-start justify-between gap-4">
          <div>
            <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">
              Documents Workspace
            </h2>
            <p className="text-xs text-[#8B94A3]">
              A workspace context is required before documents can be loaded.
            </p>
          </div>
        </section>

        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-4 py-5">
          <p className="text-[11px] text-[#8B94A3]">
            No active organization is available for this session.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#5B6578]">
            Workspace / Documents
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#F5F7FA]">
            Documents Workspace
          </h2>
          <p className="mt-2 text-[12px] leading-6 text-[#8B94A3]">
            Scan the full document estate, pivot into project-centered review,
            and keep fast access to the canonical document detail route.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/platform/reviews#needs-review"
            className="rounded-md border border-[#2F3B52] bg-[#111827] px-3 py-2 text-[11px] font-medium text-[#C7D2E3] hover:border-[#3B82F6]/40 hover:text-[#F5F7FA]"
          >
            Review Queue
          </Link>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={!orgId || orgLoading}
            className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Upload Document
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[#1A1A3E] bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.16),_transparent_32%),linear-gradient(180deg,_#12122E_0%,_#0E0E2A_100%)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#1A1A3E] pb-4">
          <div className="max-w-2xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B94A3]">
              Operational rollup
            </p>
            <p className="mt-2 text-[12px] leading-6 text-[#C7D2E3]">
              {modeMeta.description}
            </p>
          </div>
          <div className="rounded-full border border-[#2F3B52] bg-[#0A0A20] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#C7D2E3]">
            {visibleSummary.totalDocuments} documents in view
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <WorkspaceMetric
            label="Documents"
            value={visibleSummary.totalDocuments}
            detail={
              hasWorkspaceScope
                ? 'Matching the current working slice.'
                : 'Total records available to this workspace.'
            }
          />
          <WorkspaceMetric
            label="Projects"
            value={visibleSummary.totalProjects}
            detail={
              visibleSummary.unlinkedCount > 0
                ? `${visibleSummary.unlinkedCount} unlinked document${visibleSummary.unlinkedCount === 1 ? '' : 's'} remain outside a project.`
                : 'All visible documents are project-linked.'
            }
          />
          <WorkspaceMetric
            label="Needs Review"
            value={visibleSummary.needsReviewCount}
            detail="Documents still carrying review, task, or finding pressure."
          />
          <WorkspaceMetric
            label="Blocked"
            value={visibleSummary.blockedCount}
            detail="Failed or blocked records that may need operator intervention."
          />
          <WorkspaceMetric
            label="Unlinked"
            value={visibleSummary.unlinkedCount}
            detail="Records not yet attached to an operational project."
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[#1A1A3E] bg-[#0E0E2A]">
        <div className="border-b border-[#1A1A3E] px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B94A3]">
                Workspace modes
              </p>
              <p className="mt-2 text-[11px] leading-5 text-[#8B94A3]">
                Shift between global scan, grouped project review, and focused
                document slices without changing document identity or routing.
              </p>
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-[#1A1A3E] bg-[#111827] p-1">
              <LayoutToggleButton
                active={layoutMode === 'grouped'}
                label="Grouped by Project"
                onClick={() => setLayoutMode('grouped')}
              />
              <LayoutToggleButton
                active={layoutMode === 'list'}
                label="Global List"
                onClick={() => setLayoutMode('list')}
              />
            </div>
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            {WORKSPACE_MODES.map((mode) => (
              <ModeButton
                key={mode.key}
                active={mode.key === workspaceMode}
                label={mode.label}
                description={mode.description}
                onClick={() => setWorkspaceMode(mode.key)}
              />
            ))}
          </div>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <label className="block flex-1">
              <span className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
                Search
              </span>
              <input
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search title, project, code, type, or domain"
                className="w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[12px] text-[#F5F7FA] placeholder:text-[#3A3F5A] outline-none focus:border-[#8B5CFF]"
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect
                label="Sort"
                value={sortBy}
                onChange={(value) => setSortBy(value as DocumentWorkspaceSort)}
                options={SORT_OPTIONS}
                minWidthClass="min-w-[170px]"
              />
              <button
                type="button"
                onClick={handleRefresh}
                disabled={!orgId || loading}
                className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh
              </button>
              {hasWorkspaceScope ? (
                <button
                  type="button"
                  onClick={clearWorkspaceScope}
                  className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
                >
                  Reset Workspace
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Project"
              value={selectedProjectId}
              onChange={setSelectedProjectId}
              options={projectOptions}
              minWidthClass="min-w-[190px]"
            />
            <FilterSelect
              label="Type"
              value={selectedDocumentType}
              onChange={setSelectedDocumentType}
              options={documentTypeOptions}
            />
            <FilterSelect
              label="Status"
              value={selectedProcessingStatus}
              onChange={setSelectedProcessingStatus}
              options={processingStatusOptions}
            />
            <FilterSelect
              label="Attention"
              value={selectedAttention}
              onChange={(value) =>
                setSelectedAttention(value as DocumentWorkspaceAttentionFilter)
              }
              options={ATTENTION_OPTIONS}
              minWidthClass="min-w-[180px]"
            />
            <FilterSelect
              label="Recent"
              value={selectedRecent}
              onChange={(value) =>
                setSelectedRecent(value as DocumentWorkspaceRecentFilter)
              }
              options={RECENT_OPTIONS}
              minWidthClass="min-w-[170px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-[#1A1A3E] pt-4 text-[11px] text-[#8B94A3]">
            <span className="font-medium text-[#F5F7FA]">
              {filteredWorkspaceItems.length} matching document
              {filteredWorkspaceItems.length === 1 ? '' : 's'}
            </span>
            <span>
              {groupedWorkspaceItems.length} visible section
              {groupedWorkspaceItems.length === 1 ? '' : 's'}
            </span>
            {filteredSummary.needsReviewCount > 0 ? (
              <span className="text-amber-300">
                {filteredSummary.needsReviewCount} need review
              </span>
            ) : null}
            {filteredSummary.blockedCount > 0 ? (
              <span className="text-red-300">
                {filteredSummary.blockedCount} blocked
              </span>
            ) : null}
            {filteredSummary.unlinkedCount > 0 ? (
              <span className="text-[#C7D2E3]">
                {filteredSummary.unlinkedCount} unlinked
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {workspaceWarning ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[11px] text-amber-200">
          {workspaceWarning}
        </div>
      ) : null}

      {docsError ? (
        <section className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-medium text-red-300">
                {docsError}
              </p>
              <p className="mt-1 text-[11px] text-red-200/90">
                The document workspace could not be loaded for this
                organization.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!orgId || loading}
              className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-[11px] font-medium text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </section>
      ) : loading ? (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <LoadingSkeleton />
        </section>
      ) : workspaceItems.length === 0 ? (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-4 py-6">
          <p className="text-[12px] font-medium text-[#F5F7FA]">
            No documents have been loaded yet.
          </p>
          <p className="mt-1 text-[11px] text-[#8B94A3]">
            Upload a source document to start building project-linked document
            intelligence.
          </p>
        </section>
      ) : filteredWorkspaceItems.length === 0 ? (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] px-4 py-6">
          <p className="text-[12px] font-medium text-[#F5F7FA]">
            No documents match the current workspace view.
          </p>
          <p className="mt-1 text-[11px] text-[#8B94A3]">
            Adjust the filters or reset the workspace to return to the full
            document scan.
          </p>
          <button
            type="button"
            onClick={clearWorkspaceScope}
            className="mt-4 rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
          >
            Reset Workspace
          </button>
        </section>
      ) : layoutMode === 'grouped' ? (
        <div className="space-y-3">
          {groupedWorkspaceItems.map((group) => (
            <GroupSection
              key={group.key}
              group={group}
              collapsed={collapsedGroups[group.key] ?? false}
              onToggle={() => toggleGroup(group.key)}
              onOpenDocument={handleOpenDocument}
              onReprocess={reprocessDoc}
              processingIds={processingIds}
              processErrors={processErrors}
            />
          ))}
        </div>
      ) : (
        <section className="overflow-hidden rounded-lg border border-[#1A1A3E] bg-[#0E0E2A]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1A1A3E] px-4 py-4">
            <div>
              <h3 className="text-sm font-semibold text-[#F5F7FA]">
                Global Document Scan
              </h3>
              <p className="mt-1 text-[11px] text-[#8B94A3]">
                Fast document-by-document scanning across the active workspace.
              </p>
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B94A3]">
              Sorted by{' '}
              {SORT_OPTIONS.find((option) => option.value === sortBy)?.label}
            </span>
          </div>

          <div>
            {sortedWorkspaceItems.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                showProject
                onOpen={() => handleOpenDocument(document.documentHref)}
                onReprocess={() => reprocessDoc(document.id)}
                isProcessing={processingIds.has(document.id)}
                processError={processErrors[document.id] ?? null}
              />
            ))}
          </div>
        </section>
      )}

      {modalOpen && orgId ? (
        <UploadModal
          orgId={orgId}
          onClose={() => setModalOpen(false)}
          onUploaded={handleUploaded}
          onUnauthorized={() => router.replace('/login')}
        />
      ) : null}
    </div>
  );
}

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
import { useRouter, useSearchParams } from 'next/navigation';
import {
  buildDocumentWorkspaceItems,
  filterDocumentWorkspaceItems,
  sortDocumentWorkspaceItems,
  summarizeDocumentWorkspaceItems,
  type DocumentReviewStatus,
  type DocumentWorkspaceDecisionRow,
  type DocumentWorkspaceDocRow,
  type DocumentWorkspaceItem,
  type DocumentWorkspaceReviewRow,
  type DocumentWorkspaceTaskRow,
  type DocumentWorkspaceTone,
} from '@/lib/documentWorkspace';
import { buildProjectDocumentsForgeHref } from '@/lib/documentNavigation';
import { UPLOAD_DOCUMENT_TYPES } from '@/lib/documentTypes';
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

type ContractOption = {
  id: string;
  title: string | null;
  name: string;
};

const DOC_TYPES = UPLOAD_DOCUMENT_TYPES;

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
      return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'info':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    default:
      return 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]';
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded: 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]',
    processing: 'border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
    extracted: 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]',
    decisioned: 'border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]',
    failed: 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]',
  };

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
        map[status] ?? 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]'
      }`}
    >
      {titleize(status)}
    </span>
  );
}

function ReviewBadge({ status }: { status: DocumentReviewStatus }) {
  const map: Record<DocumentReviewStatus, string> = {
    not_reviewed: 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]',
    in_review: 'border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]',
    approved: 'border-[var(--ef-success-a40)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]',
    needs_correction: 'border-[var(--ef-warning-a40)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
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
    <div className="border-l border-[var(--ef-surface-elevated)] pl-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ef-text-primary)]">
        {value}
      </p>
      <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">{detail}</p>
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
    <label className="flex items-center gap-2 text-[11px] text-[var(--ef-text-muted)]">
      <span className="font-medium text-[var(--ef-text-primary)]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${minWidthClass} rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-2 py-1.5 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]`}
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

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={`document-skeleton-${index}`}
          className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-4"
        >
          <div className="h-3 w-32 animate-pulse rounded bg-[var(--ef-surface-elevated)]" />
          <div className="mt-3 h-3 w-64 animate-pulse rounded bg-[var(--ef-surface-elevated)]" />
          <div className="mt-3 h-3 w-48 animate-pulse rounded bg-[var(--ef-surface-elevated)]" />
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
  openHref,
  onOpen,
  onReprocess,
  isProcessing,
  processError,
}: {
  document: DocumentWorkspaceItem;
  openHref: string;
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
      className="grid gap-4 border-b border-[var(--ef-surface-elevated)] px-4 py-4 text-left transition-colors hover:bg-[var(--ef-surface-elevated)] last:border-b-0 md:grid-cols-[minmax(0,2.1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-start"
    >
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Document Name
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={openHref}
            onClick={(event) => event.stopPropagation()}
            className="text-[13px] font-semibold text-[var(--ef-text-primary)] hover:text-[var(--ef-purple-primary)]"
          >
            {document.title}
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
          {document.fileName}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <WorkspaceStatusBadge
            label={document.workspaceStatusLabel}
            tone={document.workspaceTone}
          />
          {document.blockedCount > 0 ? <StatusBadge status="failed" /> : null}
        </div>
        {document.processingError ? (
          <p className="mt-2 text-[11px] text-[var(--ef-critical)]">
            Processing error: {document.processingError}
          </p>
        ) : null}
        {processError ? (
          <p className="mt-2 text-[11px] text-[var(--ef-critical)]">
            Reprocess failed: {processError}
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Project
        </p>
        {document.projectId && document.projectName ? (
          <Link
            href={buildProjectDocumentsForgeHref(document.projectId, document.id)}
            onClick={(event) => event.stopPropagation()}
            className="text-[12px] font-medium text-[var(--ef-text-primary)] hover:text-[var(--ef-purple-primary)]"
          >
            {document.projectCode
              ? `${document.projectName} / ${document.projectCode}`
              : document.projectName}
          </Link>
        ) : (
          <span className="text-[12px] text-[var(--ef-text-muted)]">Unlinked document</span>
        )}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Type
        </p>
        <p className="text-[12px] text-[var(--ef-text-secondary)]">
          {document.documentTypeLabel}
        </p>
        {document.domain ? (
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            {titleize(document.domain)}
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Status
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={document.processingStatus} />
        </div>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Needs Review
        </p>
        {document.needsReview ? (
          <span className="inline-flex rounded-full border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-warning-soft)]">
            Needs Review
          </span>
        ) : document.reviewStatus === 'approved' ? (
          <ReviewBadge status="approved" />
        ) : (
          <span className="inline-flex rounded-full border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-success-soft)]">
            Clear
          </span>
        )}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Unresolved Execution
        </p>
        <div className="space-y-1 text-[11px] text-[var(--ef-text-muted)]">
          <p>
            {document.unresolvedFindingCount > 0
              ? `${document.unresolvedFindingCount} finding${document.unresolvedFindingCount === 1 ? '' : 's'}`
              : 'No open findings'}
          </p>
          <p>
            {document.pendingActionCount > 0
              ? `${document.pendingActionCount} action${document.pendingActionCount === 1 ? '' : 's'}`
              : 'No open actions'}
          </p>
        </div>
      </div>

      <div onClick={(event) => event.stopPropagation()}>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] md:hidden">
          Last Updated
        </p>
        <p className="text-[12px] text-[var(--ef-text-secondary)]">
          {formatTimestamp(document.latestActivityAt)}
        </p>
        {canReprocess ? (
          isProcessing ? (
            <span className="mt-2 inline-block text-[11px] text-[var(--ef-text-muted)]">
              Processing...
            </span>
          ) : (
            <button
              type="button"
              onClick={onReprocess}
              className="mt-2 text-[11px] font-medium text-[var(--ef-purple-glow)] hover:text-[var(--ef-purple-primary)]"
            >
              {document.processingStatus === 'uploaded' ? 'Process' : 'Reprocess'}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function UploadModal({
  orgId,
  onClose,
  onUploaded,
  onUnauthorized,
  initialProjectId,
}: {
  orgId: string;
  onClose: () => void;
  onUploaded: (params: {
    doc: UploadedDocRow;
    analyzePromise: Promise<Response>;
  }) => void;
  onUnauthorized?: () => void;
  initialProjectId?: string | null;
}) {
  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [domain, setDomain] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [contractOptions, setContractOptions] = useState<ContractOption[]>([]);
  const [governingContractId, setGoverningContractId] = useState('');
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

  useEffect(() => {
    if (initialProjectId) {
      setProjectId(initialProjectId);
    }
  }, [initialProjectId]);

  useEffect(() => {
    if (documentType !== 'price_sheet') {
      setGoverningContractId('');
      setContractOptions([]);
      return;
    }

    if (!projectId) {
      setGoverningContractId('');
      setContractOptions([]);
      return;
    }

    let cancelled = false;
    supabase
      .from('documents')
      .select('id, title, name')
      .eq('organization_id', orgId)
      .eq('project_id', projectId)
      .eq('document_type', 'contract')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        const options = (data ?? []) as ContractOption[];
        setContractOptions(options);
        setGoverningContractId((current) =>
          current && options.some((option) => option.id === current) ? current : '',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [documentType, orgId, projectId]);

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

      if (documentType === 'price_sheet' && projectId && governingContractId) {
        const relationshipRes = await fetch(`/api/projects/${projectId}/document-precedence`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token ?? ''}`,
          },
          body: JSON.stringify({
            action: 'link_relationship',
            sourceDocumentId: insertedDoc.id,
            targetDocumentId: governingContractId,
            relationshipType: 'attached_to',
          }),
        });

        if (relationshipRes.status === 401) {
          onUnauthorized?.();
          return;
        }

        if (!relationshipRes.ok) {
          const relationshipJson = await relationshipRes.json().catch(() => null);
          setError(
            relationshipJson?.error ||
            relationshipJson?.message ||
            `Governing contract link failed (${relationshipRes.status})`,
          );
          return;
        }
      }

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
      <div className="w-full max-w-md rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--ef-text-primary)]">
            Upload Document
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]"
            aria-label="Close"
          >
            x
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
              Title <span className="text-[var(--ef-critical)]">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Q1 Compliance Report"
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
              Document Type
            </label>
            <select
              aria-label="Document Type"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
            >
              <option value="">Select type...</option>
              {DOC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {titleize(type)}
                </option>
              ))}
            </select>
          </div>

          {documentType === 'price_sheet' && projectId ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
                Governing Contract
              </label>
              <select
                aria-label="Governing Contract"
                value={governingContractId}
                onChange={(event) => setGoverningContractId(event.target.value)}
                className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
              >
                <option value="">None</option>
                {contractOptions.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    {contract.title?.trim() || contract.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
              Domain{' '}
              <span className="font-normal text-[var(--ef-text-muted)]">
                (optional - used for rule matching)
              </span>
            </label>
            <input
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="e.g. debris_ops, logistics, finance"
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]"
            />
          </div>

          {projects.length > 0 ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
                Project{' '}
                <span className="font-normal text-[var(--ef-text-muted)]">(optional)</span>
              </label>
              <select
                aria-label="Project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
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
            <label className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
              File <span className="text-[var(--ef-critical)]">*</span>
            </label>
            <input
              aria-label="File"
              type="file"
              accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)] file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-[var(--ef-purple-primary)] file:px-3 file:py-1 file:text-[10px] file:font-medium file:text-white hover:file:bg-[var(--ef-purple-glow)]"
            />
            <p className="mt-1 text-[10px] text-[var(--ef-text-faint)]">
              PDF, DOCX, TXT, PNG, JPG, CSV, XLSX
            </p>
          </div>

          {error ? <p className="text-[11px] text-[var(--ef-critical)]">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-2 text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading}
              className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:opacity-50"
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
  const searchParams = useSearchParams();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const orgId = organizationId;

  const [documents, setDocuments] = useState<DocumentWorkspaceDocRow[]>([]);
  const [reviews, setReviews] = useState<DocumentWorkspaceReviewRow[]>([]);
  const [decisions, setDecisions] = useState<DocumentWorkspaceDecisionRow[]>([]);
  const [tasks, setTasks] = useState<DocumentWorkspaceTaskRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [workspaceWarnings, setWorkspaceWarnings] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const preset = searchParams.get('projectId');
    if (preset) {
      setSelectedProjectId(preset);
    }
    if (searchParams.get('openUpload') === '1') {
      setModalOpen(true);
    }
  }, [searchParams]);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [processErrors, setProcessErrors] = useState<Record<string, string>>({});

  const [searchValue, setSearchValue] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedDocumentType, setSelectedDocumentType] = useState('');
  const [selectedProcessingStatus, setSelectedProcessingStatus] = useState('');

  const loading = orgLoading || docsLoading;

  const fetchWorkspaceData = useCallback(async (currentOrgId: string) => {
    setDocsLoading(true);
    setDocsError(null);
    setWorkspaceWarnings([]);

    try {
      const [documentsResult, reviewsResult, decisionsResult, tasksResult] = await Promise.all([
        supabase
          .from('documents')
          .select(DOCUMENT_SELECT)
          .eq('organization_id', currentOrgId)
          .order('created_at', { ascending: false }),
        supabase
          .from('document_reviews')
          .select('document_id, status, reviewed_at')
          .eq('organization_id', currentOrgId),
        supabase
          .from('decisions')
          .select('id, document_id, status, severity, details, last_detected_at, created_at')
          .eq('organization_id', currentOrgId)
          .in('status', ['open', 'in_review', 'needs_review']),
        supabase
          .from('workflow_tasks')
          .select('id, document_id, decision_id, status, priority, created_at')
          .eq('organization_id', currentOrgId)
          .in('status', ['open', 'in_progress', 'blocked']),
      ]);

      if (documentsResult.error) {
        setDocsError('Failed to load documents.');
        setDocuments([]);
        setReviews([]);
        setDecisions([]);
        setTasks([]);
        setDocsLoading(false);
        return;
      }

      setDocuments((documentsResult.data ?? []) as DocumentWorkspaceDocRow[]);

      if (reviewsResult.error) {
        setReviews([]);
      } else {
        setReviews((reviewsResult.data ?? []) as DocumentWorkspaceReviewRow[]);
      }

      if (decisionsResult.error) {
        setDecisions([]);
      } else {
        setDecisions((decisionsResult.data ?? []) as DocumentWorkspaceDecisionRow[]);
      }

      if (tasksResult.error) {
        setTasks([]);
      } else {
        setTasks((tasksResult.data ?? []) as DocumentWorkspaceTaskRow[]);
      }
    } catch {
      setDocsError('Failed to load documents.');
      setDocuments([]);
      setReviews([]);
      setDecisions([]);
      setTasks([]);
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
    () => buildDocumentWorkspaceItems({ documents, reviews, decisions, tasks }),
    [decisions, documents, reviews, tasks],
  );

  const filteredWorkspaceItems = useMemo(
    () =>
      filterDocumentWorkspaceItems(workspaceItems, {
        search: searchValue,
        mode: 'all',
        projectId: selectedProjectId,
        documentType: selectedDocumentType,
        processingStatus: selectedProcessingStatus,
        attention: '',
        recent: '',
      }),
    [
      searchValue,
      selectedDocumentType,
      selectedProcessingStatus,
      selectedProjectId,
      workspaceItems,
    ],
  );

  const sortedWorkspaceItems = useMemo(
    () => sortDocumentWorkspaceItems(filteredWorkspaceItems, 'updated_desc'),
    [filteredWorkspaceItems],
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

  const hasWorkspaceScope =
    searchValue.trim().length > 0 ||
    selectedProjectId !== '' ||
    selectedDocumentType !== '' ||
    selectedProcessingStatus !== '';
  const visibleItems = hasWorkspaceScope
    ? sortedWorkspaceItems
    : sortDocumentWorkspaceItems(workspaceItems, 'updated_desc');
  const visibleSummary = hasWorkspaceScope ? filteredSummary : workspaceSummary;
  const unresolvedExecutionCount = useMemo(
    () =>
      visibleItems.reduce(
        (total, item) => total + item.pendingActionCount,
        0,
      ),
    [visibleItems],
  );

  const clearWorkspaceScope = useCallback(() => {
    setSearchValue('');
    setSelectedProjectId('');
    setSelectedDocumentType('');
    setSelectedProcessingStatus('');
  }, []);

  const handleOpenDocument = useCallback(
    (document: DocumentWorkspaceItem) => {
      router.push(
        document.projectId
          ? buildProjectDocumentsForgeHref(document.projectId, document.id)
          : document.documentHref,
      );
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
            <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">
              Documents Workspace
            </h2>
            <p className="text-xs text-[var(--ef-text-muted)]">
              A workspace context is required before documents can be loaded.
            </p>
          </div>
        </section>

        <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-5">
          <p className="text-[11px] text-[var(--ef-text-muted)]">
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-text-faint)]">
            Workspace / Documents
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-[var(--ef-text-primary)]">
            Documents Workspace
          </h2>
          <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-muted)]">
            Scan, review, and manage all project documents.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/platform/reviews#needs-review"
            className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:border-[var(--ef-purple-primary-a40)] hover:text-[var(--ef-text-primary)]"
          >
            Review Queue
          </Link>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            disabled={!orgId || orgLoading}
            className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Upload Document
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[var(--ef-surface-elevated)] bg-[radial-gradient(circle_at_top_left,_var(--ef-purple-primary-a16),_transparent_32%),linear-gradient(180deg,_var(--ef-surface-elevated)_0%,_var(--ef-background-secondary)_100%)] p-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <WorkspaceMetric
            label="Total Documents"
            value={visibleSummary.totalDocuments}
            detail={
              hasWorkspaceScope
                ? 'Matching the current search and filter view.'
                : 'All documents currently available in this workspace.'
            }
          />
          <WorkspaceMetric
            label="Needs Review"
            value={visibleSummary.needsReviewCount}
            detail="Documents still waiting on operator review or follow-up."
          />
          <WorkspaceMetric
            label="Unresolved Execution"
            value={unresolvedExecutionCount}
            detail="Open execution work still tied to visible document records."
          />
          <WorkspaceMetric
            label="Blocked Documents"
            value={visibleSummary.blockedCount}
            detail="Failed or blocked records that may need operator intervention."
          />
          <WorkspaceMetric
            label="Unlinked Documents"
            value={visibleSummary.unlinkedCount}
            detail="Records not yet attached to an operational project."
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <label className="block flex-1">
              <span className="mb-1 block text-[11px] font-medium text-[var(--ef-text-primary)]">
                Search
              </span>
              <input
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search title, project, code, type, or domain"
                className="w-full rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[12px] text-[var(--ef-text-primary)] placeholder:text-[var(--ef-text-faint)] outline-none focus:border-[var(--ef-purple-primary)]"
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={!orgId || loading}
                className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh
              </button>
              {hasWorkspaceScope ? (
                <button
                  type="button"
                  onClick={clearWorkspaceScope}
                  className="rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]"
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
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--ef-surface-elevated)] pt-4 text-[11px] text-[var(--ef-text-muted)]">
            <span className="font-medium text-[var(--ef-text-primary)]">
              {visibleItems.length} matching document
              {visibleItems.length === 1 ? '' : 's'}
            </span>
            {filteredSummary.needsReviewCount > 0 ? (
              <span className="text-[var(--ef-warning-soft)]">
                {filteredSummary.needsReviewCount} need review
              </span>
            ) : null}
            {filteredSummary.blockedCount > 0 ? (
              <span className="text-[var(--ef-critical-soft)]">
                {filteredSummary.blockedCount} blocked
              </span>
            ) : null}
            {filteredSummary.unlinkedCount > 0 ? (
              <span className="text-[var(--ef-text-secondary)]">
                {filteredSummary.unlinkedCount} unlinked
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {workspaceWarnings.length > 0 ? (
        <div className="grid gap-2">
          {workspaceWarnings.map((warning) => (
            <div
              key={warning}
              className="rounded-lg border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-4 py-3 text-[11px] text-[var(--ef-warning-soft)]"
            >
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {docsError ? (
        <section className="rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-medium text-[var(--ef-critical-soft)]">
                {docsError}
              </p>
              <p className="mt-1 text-[11px] text-[var(--ef-critical-soft)]">
                The document workspace could not be loaded for this
                organization.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!orgId || loading}
              className="rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2 text-[11px] font-medium text-[var(--ef-critical-soft)] hover:bg-[var(--ef-critical-a20)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </section>
      ) : loading ? (
        <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
          <LoadingSkeleton />
        </section>
      ) : workspaceItems.length === 0 ? (
        <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-6">
          <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">
            No documents have been loaded yet.
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            Upload a source document to start building project-linked document
            intelligence.
          </p>
        </section>
      ) : filteredWorkspaceItems.length === 0 ? (
        <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-6">
          <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">
            No documents match the current workspace view.
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            Adjust the filters or reset the workspace to return to the full
            document scan.
          </p>
          <button
            type="button"
            onClick={clearWorkspaceScope}
            className="mt-4 rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]"
          >
            Reset Workspace
          </button>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="border-b border-[var(--ef-surface-elevated)] px-4 py-4">
            <div className="hidden gap-4 md:grid md:grid-cols-[minmax(0,2.1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)]">
              {[
                'Document Name',
                'Project',
                'Type',
                'Status',
                'Needs Review',
                'Unresolved Execution',
                'Last Updated',
              ].map((label) => (
                <p
                  key={label}
                  className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]"
                >
                  {label}
                </p>
              ))}
            </div>
          </div>

          <div>
            {visibleItems.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                openHref={
                  document.projectId
                    ? buildProjectDocumentsForgeHref(document.projectId, document.id)
                    : document.documentHref
                }
                onOpen={() => handleOpenDocument(document)}
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
          initialProjectId={searchParams.get('projectId')}
        />
      ) : null}
    </div>
  );
}

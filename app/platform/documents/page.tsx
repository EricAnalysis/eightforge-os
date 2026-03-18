'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocRow = {
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

// ─── Constants ────────────────────────────────────────────────────────────────

const DOC_TYPES = [
  'contract',
  'invoice',
  'report',
  'policy',
  'procedure',
  'specification',
  'other',
] as const;

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded:    'bg-[#1A1A3E] text-[#8B94A3]',
    processing:  'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse',
    extracted:   'bg-sky-500/20 text-sky-400 border border-sky-500/40',
    decisioned:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed:      'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ─── Upload modal ─────────────────────────────────────────────────────────────

function UploadModal({
  orgId,
  onClose,
  onUploaded,
  onUnauthorized,
}: {
  orgId: string;
  onClose: () => void;
  onUploaded: (params: {
    doc: DocRow;
    analyzePromise: Promise<Response>;
  }) => void;
  onUnauthorized?: () => void;
}) {
  const [title, setTitle]               = useState('');
  const [documentType, setDocumentType] = useState('');
  const [domain, setDomain]             = useState('');
  const [projectId, setProjectId]       = useState('');
  const [file, setFile]                 = useState<File | null>(null);
  const [projects, setProjects]         = useState<ProjectOption[]>([]);
  const [uploading, setUploading]       = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Load projects for the optional selector
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    // Auto-populate title from filename if the field is still empty
    if (picked && !title.trim()) {
      setTitle(picked.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
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
      const { data: { session: uploadSession } } = await supabase.auth.getSession();

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
        const msg =
          uploadJson?.error?.message ||
          (typeof uploadJson?.error === 'string' ? uploadJson.error : null) ||
          `Upload failed (${uploadRes.status})`;
        setError(msg);
        return;
      }

      const insertedDoc = uploadJson.doc as DocRow;

      const { data: { session } } = await supabase.auth.getSession();
      const newDocId = insertedDoc.id;

      const processPromise = fetch('/api/documents/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ documentId: newDocId }),
      });

          onUploaded({
        doc: insertedDoc,
        analyzePromise: processPromise,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(msg);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-5 shadow-xl">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#F5F7FA]">Upload Document</span>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-[#8B94A3] hover:text-[#F5F7FA]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">

          {/* Title */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q1 Compliance Report"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]"
            />
          </div>

          {/* Document Type */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Document Type
            </label>
            <select
              aria-label="Document Type"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
            >
              <option value="">Select type…</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Domain — determines which rules fire during processing */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              Domain{' '}
              <span className="font-normal text-[#8B94A3]">(optional — used for rule matching)</span>
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. debris_ops, logistics, finance"
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] placeholder:text-[#3a3f5a] outline-none focus:border-[#8B5CFF]"
            />
          </div>

          {/* Project (only shown when projects exist) */}
          {projects.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
                Project{' '}
                <span className="font-normal text-[#8B94A3]">(optional)</span>
              </label>
              <select
                aria-label="Project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
              >
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* File picker */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F5F7FA]">
              File <span className="text-red-400">*</span>
            </label>
            <input
              aria-label="File"
              type="file"
              accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.csv,.xlsx"
              onChange={handleFileChange}
              className="block w-full rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-2 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] file:mr-3 file:rounded file:border-0 file:bg-[#8B5CFF] file:px-3 file:py-1 file:text-[10px] file:font-medium file:text-white file:cursor-pointer hover:file:bg-[#7A4FE8]"
            />
            <p className="mt-1 text-[10px] text-[#3a3f5a]">PDF, DOCX, TXT, PNG, JPG, CSV, XLSX</p>
          </div>

          {/* Error */}
          {error && (
            <p className="text-[11px] text-red-400">{error}</p>
          )}

          {/* Actions */}
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
              className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const orgId = organizationId;

  const [docs, setDocs]           = useState<DocRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [processErrors, setProcessErrors] = useState<Record<string, string>>({});

  const loading = orgLoading || docsLoading;

  const reprocessDoc = async (docId: string) => {
    setProcessingIds((prev) => new Set(prev).add(docId));
    setProcessErrors((prev) => { const n = { ...prev }; delete n[docId]; return n; });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setProcessErrors((prev) => ({ ...prev, [docId]: 'Auth required' }));
        return;
      }
      const res = await fetch('/api/documents/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ documentId: docId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProcessErrors((prev) => ({ ...prev, [docId]: body?.message ?? 'Failed' }));
        return;
      }
      // Update the row's processing_status optimistically, then refresh
      const finalStatus = (body?.processing_status as string) ?? 'decisioned';
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, processing_status: finalStatus } : d));
      if (orgId) fetchDocs(orgId);
    } catch {
      setProcessErrors((prev) => ({ ...prev, [docId]: 'Failed' }));
    } finally {
      setProcessingIds((prev) => { const n = new Set(prev); n.delete(docId); return n; });
    }
  };

  const fetchDocs = async (orgId: string) => {
    setDocsLoading(true);
    setDocsError(null);
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, name, document_type, processing_status, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    if (error) {
      setDocsError('Failed to load documents.');
      setDocs([]);
    } else {
      setDocs(data as DocRow[]);
    }
    setDocsLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !orgId) return;
    fetchDocs(orgId);
  }, [orgId, orgLoading]);

  return (
    <div className="space-y-4">

      {/* Page header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Documents</h2>
          <p className="text-xs text-[#8B94A3]">
            Manage documents processed by EightForge OS. Upload contracts,
            reports, and operational files for extraction and analysis.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
          >
            Upload Document
          </button>
        </div>
      </section>

      {/* Document list */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-3">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Document list</div>

        {docsError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{docsError}</p>
          </div>
        ) : loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : docs.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[12px] font-medium text-[#F5F7FA]">No documents yet</p>
            <p className="mt-1 text-[11px] text-[#8B94A3]">
              Upload a document to begin extracting decisions and generating workflow tasks.
            </p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="mt-4 rounded-md bg-[#8B5CFF] px-4 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
            >
              Upload your first document
            </button>
          </div>
        ) : (
          <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
            <thead className="border-b border-[#1A1A3E] text-left">
              <tr>
                <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Title</th>
                <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Type</th>
                <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Status</th>
                <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Created</th>
                <th className="py-2 font-medium text-[#F5F7FA]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr
                  key={doc.id}
                  onClick={() => router.push(`/platform/documents/${doc.id}`)}
                  className="cursor-pointer border-b border-[#1A1A3E] last:border-0 hover:bg-[#12122E]"
                >
                  <td className="py-2 pr-3 text-[#F5F7FA]">
                    {doc.title ?? doc.name}
                  </td>
                  <td className="py-2 pr-3">
                    {doc.document_type
                      ? doc.document_type.charAt(0).toUpperCase() + doc.document_type.slice(1)
                      : <span className="text-[#3a3f5a]">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={doc.processing_status} />
                  </td>
                  <td className="py-2 pr-3">
                    {new Date(doc.created_at).toLocaleString()}
                  </td>
                  <td
                    className="py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center gap-3">
                      <a
                        href={`/platform/documents/${doc.id}`}
                        className="text-[#8B5CFF] hover:underline"
                      >
                        View
                      </a>
                      {(doc.processing_status === 'uploaded' || doc.processing_status === 'failed' || doc.processing_status === 'extracted') && (
                        processingIds.has(doc.id) ? (
                          <span className="text-[11px] text-[#8B94A3]">Processing…</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => reprocessDoc(doc.id)}
                            className="text-[11px] text-[#8B5CFF] hover:underline"
                          >
                            {doc.processing_status === 'uploaded' ? 'Process' : 'Reprocess'}
                          </button>
                        )
                      )}
                      {processErrors[doc.id] && (
                        <span className="text-[10px] text-red-400" title={processErrors[doc.id]}>!</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Upload modal */}
      {modalOpen && orgId && (
        <UploadModal
          orgId={orgId}
          onClose={() => setModalOpen(false)}
          onUnauthorized={() => router.replace('/login')}
          onUploaded={({ doc, analyzePromise }) => {
            setModalOpen(false);
            setDocs((prev) => [{ ...doc, processing_status: 'processing' }, ...prev]);
            fetchDocs(orgId);

            analyzePromise
              .then((res) => {
                if (redirectIfUnauthorized(res, router.replace)) return;
                fetchDocs(orgId);
              })
              .catch(() => {
                fetchDocs(orgId);
              });
          }}
        />
      )}

      {/* Loading org: show feedback while organization is loading */}
      {modalOpen && !organizationId && orgLoading && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className="w-full max-w-md rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-5 shadow-xl">
            <p className="mb-4 text-sm text-[#F5F7FA]">Loading organization…</p>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-md px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F5F7FA]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  status: string;
  created_at: string;
};

type ProjectOption = {
  id: string;
  name: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET = 'documents';

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
    uploaded:   'bg-[#1A1F27] text-[#8B94A3]',
    processing: 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse',
    processed:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed:     'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ─── Upload modal ─────────────────────────────────────────────────────────────

function UploadModal({
  organizationId,
  onClose,
  onUploaded,
}: {
  organizationId: string;
  onClose: () => void;
  onUploaded: (params: {
    doc: DocRow;
    analyzePromise: Promise<Response>;
  }) => void;
}) {
  const [title, setTitle]               = useState('');
  const [documentType, setDocumentType] = useState('');
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
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => {
        if (data) setProjects(data as ProjectOption[]);
      });
  }, [organizationId]);

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

    if (!file)         { setError('Select a file.'); return; }
    if (!title.trim()) { setError('Title is required.'); return; }

    setUploading(true);
    try {
      const filePath = `${organizationId}/${Date.now()}-${file.name}`;

      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, file);

      if (storageError) {
        setError(storageError.message);
        return;
      }

      const { data: insertedDoc, error: dbError } = await supabase
        .from('documents')
        .insert({
          organization_id: organizationId,
          project_id:      projectId || null,
          title:           title.trim(),
          name:            file.name,        // file_name
          storage_path:    filePath,         // file_path
          document_type:   documentType || null,
          status:          'uploaded',
        })
        .select('id, title, name, document_type, status, created_at')
        .single();

      if (dbError || !insertedDoc) {
        setError(dbError?.message ?? 'Upload failed. Please try again.');
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const newDocId = (insertedDoc as DocRow).id;

      const analyzePromise = fetch(`/api/documents/${newDocId}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
      });

      onUploaded({
        doc: insertedDoc as DocRow,
        analyzePromise,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-[#1A1F27] bg-[#0F1115] p-5 shadow-xl">

        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-[#F1F3F5]">Upload Document</span>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-[#8B94A3] hover:text-[#F1F3F5]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">

          {/* Title */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F1F3F5]">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q1 Compliance Report"
              className="block w-full rounded-md border border-[#1A1F27] bg-[#0A0C10] px-3 py-2 text-[11px] text-[#F1F3F5] placeholder:text-[#3a3f4a] outline-none focus:border-[#7C5CFF]"
            />
          </div>

          {/* Document Type */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[#F1F3F5]">
              Document Type
            </label>
            <select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              className="block w-full rounded-md border border-[#1A1F27] bg-[#0A0C10] px-3 py-2 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
            >
              <option value="">Select type…</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Project (only shown when projects exist) */}
          {projects.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-[#F1F3F5]">
                Project{' '}
                <span className="font-normal text-[#8B94A3]">(optional)</span>
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="block w-full rounded-md border border-[#1A1F27] bg-[#0A0C10] px-3 py-2 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
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
            <label className="mb-1 block text-[11px] font-medium text-[#F1F3F5]">
              File <span className="text-red-400">*</span>
            </label>
            <input
              type="file"
              onChange={handleFileChange}
              className="block w-full rounded-md border border-[#1A1F27] bg-[#0A0C10] px-3 py-2 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF] file:mr-3 file:rounded file:border-0 file:bg-[#1A1F27] file:px-2 file:py-1 file:text-[10px] file:text-[#F1F3F5] file:cursor-pointer"
            />
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
              className="rounded-md px-3 py-2 text-[11px] font-medium text-[#8B94A3] hover:text-[#F1F3F5]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading || !file || !title.trim()}
              className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0] disabled:opacity-50"
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

  const [docs, setDocs]           = useState<DocRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const loading = orgLoading || docsLoading;

  const fetchDocs = async (orgId: string) => {
    setDocsLoading(true);
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, name, document_type, status, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    if (!error && data) setDocs(data as DocRow[]);
    setDocsLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !organizationId) return;
    fetchDocs(organizationId);
  }, [organizationId, orgLoading]);

  return (
    <div className="space-y-4">

      {/* Page header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Documents</h2>
          <p className="text-xs text-[#8B94A3]">
            Manage documents processed by EightForge OS. Upload contracts,
            reports, and operational files for extraction and analysis.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
          >
            Upload Document
          </button>
        </div>
      </section>

      {/* Document list */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Document list</div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No documents yet. Upload a document to get started.
          </p>
        ) : (
          <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
            <thead className="border-b border-[#1A1F27] text-left">
              <tr>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Title</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Type</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Created</th>
                <th className="py-2 font-medium text-[#F1F3F5]"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr
                  key={doc.id}
                  onClick={() => router.push(`/platform/documents/${doc.id}`)}
                  className="cursor-pointer border-b border-[#1A1F27] last:border-0 hover:bg-[#13171E]"
                >
                  <td className="py-2 pr-3 text-[#F1F3F5]">
                    {doc.title ?? doc.name}
                  </td>
                  <td className="py-2 pr-3">
                    {doc.document_type
                      ? doc.document_type.charAt(0).toUpperCase() + doc.document_type.slice(1)
                      : <span className="text-[#3a3f4a]">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={doc.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {new Date(doc.created_at).toLocaleString()}
                  </td>
                  <td
                    className="py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <a
                      href={`/platform/documents/${doc.id}`}
                      className="text-[#7C5CFF] hover:underline"
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Upload modal */}
      {modalOpen && organizationId && (
        <UploadModal
          organizationId={organizationId}
          onClose={() => setModalOpen(false)}
          onUploaded={({ doc, analyzePromise }) => {
            setModalOpen(false);
            setDocs((prev) => [{ ...doc, status: 'processing' }, ...prev]);
            if (organizationId) fetchDocs(organizationId);

            analyzePromise
              .then(() => {
                if (organizationId) fetchDocs(organizationId);
              })
              .catch(() => {
                if (organizationId) fetchDocs(organizationId);
              });
          }}
        />
      )}
    </div>
  );
}

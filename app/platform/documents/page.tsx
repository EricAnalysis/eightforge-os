'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

type DocRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
};

const bucket = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET ?? 'documents';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    processing: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    processed: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed: 'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function DocumentsPage() {
  const { organization } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);

  const refreshDocs = async (orgId: string) => {
    const { data, error } = await supabase
      .from('documents')
      .select('id, name, status, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setDocs(data as DocRow[]);
    }
  };

  useEffect(() => {
    if (!organizationId) return;
    refreshDocs(organizationId);
  }, [organizationId]);

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!files || files.length === 0) {
      setError('No file selected.');
      return;
    }
    if (!organizationId) {
      setError('No organization found.');
      return;
    }

    const file = files[0];
    setUploading(true);

    try {
      const path = `${organizationId}/${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(path, file);

      if (uploadError) {
        setError(uploadError.message);
        return;
      }

      const { error: insertError } = await supabase.from('documents').insert({
        organization_id: organizationId,
        name: file.name,
        storage_path: path,
        status: 'uploaded',
        created_at: new Date().toISOString(),
      });

      if (insertError) {
        setError(insertError.message);
      } else {
        await refreshDocs(organizationId);
        setFiles(null);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">
          Document Intelligence
        </h2>
        <p className="text-xs text-[#8B94A3]">
          Inbox for PDFs, contracts, and reports processed by EightForge OS.
        </p>
      </section>

      {/* Upload form */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <form
          onSubmit={handleUpload}
          className="flex flex-col gap-3 text-xs text-[#F1F3F5]"
        >
          <div>
            <label htmlFor="doc-upload" className="mb-1 block text-[#F1F3F5]">
              Upload document
            </label>
            <input
              id="doc-upload"
              type="file"
              accept=".pdf"
              onChange={(e) => setFiles(e.target.files)}
              className="block w-full rounded-md border border-[#1A1F27] bg-[#0F1115] px-3 py-2 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={uploading || !files || !organizationId}
              className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0] disabled:opacity-60"
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            {!organizationId && (
              <span className="text-[11px] text-amber-400">
                Upload disabled: no organization found.
              </span>
            )}
            {organizationId && !files?.length && (
              <span className="text-[11px] text-[#8B94A3]">
                Select a PDF to enable Upload.
              </span>
            )}
            {organizationId && files?.length ? (
              <span className="text-[11px] text-[#8B94A3]">
                Ready — {files[0].name}
              </span>
            ) : null}
            {error && (
              <span className="text-[11px] text-red-400">
                {error}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* Document list */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F1F3F5]">
          Document inbox
        </div>
        {docs.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No documents yet. Upload a PDF to get started.
          </p>
        ) : (
          <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
            <thead className="border-b border-[#1A1F27] text-left">
              <tr>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Name</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status</th>
                <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Created At</th>
                <th className="py-2 font-medium text-[#F1F3F5]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b border-[#1A1F27]">
                  <td className="py-2 pr-3">{doc.name}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={doc.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {new Date(doc.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 text-[#8B94A3]">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

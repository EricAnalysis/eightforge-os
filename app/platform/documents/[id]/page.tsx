'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const bucket = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET ?? 'documents';

type DocumentDetail = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  storage_path: string;
};

async function getSignedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

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

function filenameFromPath(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

export default function DocumentDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fileUnavailable, setFileUnavailable] = useState(false);

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, name, status, created_at, storage_path')
        .eq('id', id)
        .single();

      if (error || !data) {
        setDoc(null);
        setLoading(false);
        return;
      }
      setDoc(data as DocumentDetail);
      setLoading(false);

      if (data.storage_path) {
        const url = await getSignedUrl(data.storage_path);
        if (url) {
          setViewUrl(url);
          setDownloadUrl(url);
        } else {
          setFileUnavailable(true);
        }
      } else {
        setFileUnavailable(true);
      }
    };
    load();
  }, [id]);

  const handleAnalyze = () => {
    console.log('Analyze document', id);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        <Link
          href="/platform/documents"
          className="text-[11px] text-[#7C5CFF] hover:underline"
        >
          Back to Documents
        </Link>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="space-y-4">
        <p className="text-[11px] text-[#F1F3F5]">Document not found.</p>
        <Link
          href="/platform/documents"
          className="text-[11px] text-[#7C5CFF] hover:underline"
        >
          Back to Documents
        </Link>
      </div>
    );
  }

  const filename = doc.storage_path ? filenameFromPath(doc.storage_path) : '—';

  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-[#F1F3F5]">
          {doc.name}
        </h2>
        <Link
          href="/platform/documents"
          className="text-[11px] text-[#7C5CFF] hover:underline"
        >
          Back to Documents
        </Link>
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F1F3F5]">
          Metadata
        </div>
        <dl className="space-y-1 text-[11px] text-[#8B94A3]">
          <div>
            <span className="text-[#F1F3F5]">Created:</span>{' '}
            {new Date(doc.created_at).toLocaleString()}
          </div>
          <div>
            <span className="text-[#F1F3F5]">Status:</span>{' '}
            <StatusBadge status={doc.status} />
          </div>
          <div>
            <span className="text-[#F1F3F5]">Storage path:</span> {doc.storage_path || '—'}
          </div>
          <div>
            <span className="text-[#F1F3F5]">Filename:</span> {filename}
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F1F3F5]">
          File actions
        </div>
        {fileUnavailable ? (
          <p className="text-[11px] text-red-400">File unavailable.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {viewUrl && (
              <a
                href={viewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
              >
                View File
              </a>
            )}
            {downloadUrl && (
              <a
                href={downloadUrl}
                download={filename}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-[#1A1F27] bg-[#0F1115] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#1A1F27]"
              >
                Download File
              </a>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-2 text-[11px] font-medium text-[#F1F3F5]">
          Analyze
        </div>
        <button
          type="button"
          onClick={handleAnalyze}
          className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
        >
          Analyze Document
        </button>
      </section>
    </div>
  );
}

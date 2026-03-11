'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import type { DocumentDecision } from '@/lib/types/decisions';

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET = 'documents';
const SIGNED_URL_EXPIRY = 300; // 5 minutes

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

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    uploaded:   'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    processing: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    processed:  'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    failed:     'bg-red-500/20 text-red-400 border border-red-500/40',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
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
      <span className="text-[#F1F3F5]">{children}</span>
    </div>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

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
    deterministic: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    ai_enriched: 'bg-purple-500/20 text-purple-300 border border-purple-500/40',
    manual: 'bg-blue-500/20 text-blue-300 border border-blue-500/40',
  };
  const cls = map[source] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
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
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (orgLoading) return;
    if (!organizationId) return;

    const load = async () => {
      setDoc(null);
      setSignedUrl(null);
      setFileError(false);
      setExtractions([]);
      setDecisions([]);
      setNotFound(false);
      setLoading(true);
      setExtractionsLoading(true);
      setDecisionsLoading(true);

      const [docResult, extractionsResult, decisionsResult] = await Promise.all([
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
      ]);

      if (docResult.error || !docResult.data) {
        setDoc(null);
        setSignedUrl(null);
        setFileError(false);
        setExtractions([]);
        setNotFound(true);
        setLoading(false);
        setExtractionsLoading(false);
        setDecisionsLoading(false);
        return;
      }

      const data = docResult.data;
      setDoc(data as DocumentDetail);
      setLoading(false);

      if (!extractionsResult.error && extractionsResult.data) {
        setExtractions(extractionsResult.data as ExtractionRow[]);
      }
      setExtractionsLoading(false);

      if (!decisionsResult.error && decisionsResult.data) {
        setDecisions(decisionsResult.data as DecisionRow[]);
      }
      setDecisionsLoading(false);

      // Generate signed URL for the private bucket
      if (data.storage_path) {
        const { data: urlData, error: urlError } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(data.storage_path, SIGNED_URL_EXPIRY);

        if (!urlError && urlData?.signedUrl) {
          setSignedUrl(urlData.signedUrl);
        } else {
          setFileError(true);
        }
      } else {
        setFileError(true);
      }
    };

    load();
  }, [id, organizationId, orgLoading]);

  const handleAnalyze = async () => {
    if (!doc || !organizationId || analyzing) return;
    setAnalyzing(true);
    setAnalyzeMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setAnalyzeMsg({ type: 'error', text: 'Analysis failed. Please try again.' });
        return;
      }

      const res = await fetch(`/api/documents/${id}/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          body?.error === 'Document not found'
            ? 'Document not found.'
            : body?.error === 'Unable to download file from storage'
              ? 'Unable to access file for analysis.'
              : body?.error === 'Server analysis is not configured'
                ? 'Server analysis is not configured.'
                : 'Analysis failed. Please try again.';
        setAnalyzeMsg({ type: 'error', text: msg });
        return;
      }

      if (body?.success && body?.extraction) {
        setExtractions((prev) => [body.extraction as ExtractionRow, ...prev]);
      }

      const { data: decisionRows } = await supabase
        .from('document_decisions')
        .select('id, decision_type, decision_value, confidence, source, created_at')
        .eq('document_id', id)
        .order('created_at', { ascending: true });
      if (decisionRows) setDecisions(decisionRows as DecisionRow[]);

      setAnalyzeMsg({ type: 'success', text: 'Analysis complete. New extraction added.' });
    } finally {
      setAnalyzing(false);
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading || orgLoading) {
    return (
      <div className="space-y-3">
        <Link
          href="/platform/documents"
          className="text-[11px] text-[#7C5CFF] hover:underline"
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
          className="text-[11px] text-[#7C5CFF] hover:underline"
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Page header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1">
            <Link
              href="/platform/documents"
              className="text-[11px] text-[#7C5CFF] hover:underline"
            >
              ← Documents
            </Link>
          </div>
          <h2 className="text-sm font-semibold text-[#F1F3F5]">{displayTitle}</h2>
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
              className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
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

      {/* Metadata */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Details</div>
        <div className="space-y-2">
          <MetaRow label="Title">{displayTitle}</MetaRow>
          <MetaRow label="File name">{doc.name}</MetaRow>
          <MetaRow label="Document type">
            {doc.document_type
              ? doc.document_type.charAt(0).toUpperCase() + doc.document_type.slice(1)
              : <span className="text-[#3a3f4a]">—</span>}
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
              : <span className="text-[#3a3f4a]">—</span>}
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
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">File</div>
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
              className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
            >
              View File
            </a>
            <a
              href={signedUrl}
              download={filename}
              rel="noopener noreferrer"
              className="rounded-md border border-[#1A1F27] px-3 py-2 text-[11px] font-medium text-[#F1F3F5] hover:bg-[#1A1F27]"
            >
              Download
            </a>
          </div>
        ) : (
          <p className="text-[11px] text-[#8B94A3]">Generating secure link…</p>
        )}
      </section>

      {/* Extractions */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Extractions</div>
        {extractionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading extractions…</p>
        ) : extractions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No extractions yet.</p>
        ) : (
          <div className="space-y-3">
            {extractions.map((ex) => (
              <div key={ex.id} className="rounded-md border border-[#1A1F27] bg-[#0A0C10] p-3">
                <p className="mb-2 text-[10px] text-[#8B94A3]">
                  {new Date(ex.created_at).toLocaleString()}
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-[#F1F3F5]">
                  {JSON.stringify(ex.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Decisions */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Decisions</div>
        {decisionsLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading decisions…</p>
        ) : decisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No decisions yet. Run analysis to generate decisions.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[11px]">
              <thead className="text-[#8B94A3]">
                <tr className="border-b border-[#1A1F27]">
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">Confidence</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="text-[#F1F3F5]">
                {decisions.map((d) => (
                  <tr key={d.id} className="border-b border-[#1A1F27] last:border-b-0">
                    <td className="py-2 pr-3">{titleize(d.decision_type)}</td>
                    <td className="py-2 pr-3">
                      {d.decision_value ? titleize(d.decision_value) : <span className="text-[#3a3f4a]">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {typeof d.confidence === 'number'
                        ? `${Math.round(d.confidence * 100)}%`
                        : <span className="text-[#3a3f4a]">—</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <DecisionSourceBadge source={d.source} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Analyze</div>
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={analyzing}
          className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {analyzing ? 'Analyzing…' : 'Analyze Document'}
        </button>
        {analyzeMsg && (
          <p
            className={`mt-2 text-[11px] ${
              analyzeMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {analyzeMsg.text}
          </p>
        )}
      </section>
    </div>
  );
}

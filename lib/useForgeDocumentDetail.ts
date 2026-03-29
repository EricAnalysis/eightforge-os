'use client';

/**
 * Minimal hook that fetches document detail, extraction blob, and signed file URL
 * for the Forge Structure stage. Reuses the existing API endpoints and builds a
 * DocumentIntelligenceViewModel so CenterPanelStructure can render the full
 * DocumentIntelligenceWorkspace without duplicating any Fact Workspace logic.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { buildDocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import type { DocumentFactOverrideRecord } from '@/lib/documentFactOverrides';
import type { DocumentFactAnchorRecord } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewRecord } from '@/lib/documentFactReviews';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';

type ExtractionRow = {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
};

type DocumentApiDetail = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  storage_path: string;
  project_id: string | null;
  projects?: { id: string; name: string } | { id: string; name: string }[] | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
  relatedDocs?: RelatedDocInput[];
  factOverrides?: DocumentFactOverrideRecord[];
  factAnchors?: DocumentFactAnchorRecord[];
  factReviews?: DocumentFactReviewRecord[];
};

export type ForgeDocumentDetailState = {
  model: DocumentIntelligenceViewModel | null;
  signedUrl: string | null;
  fileExt: string;
  filename: string;
  loading: boolean;
  error: string | null;
};

function resolveProjectName(
  projects: DocumentApiDetail['projects'],
): string | null {
  if (!projects) return null;
  if (Array.isArray(projects)) return projects[0]?.name ?? null;
  return projects.name ?? null;
}

function parseExecutionTrace(
  raw: DocumentApiDetail['intelligence_trace'],
): DocumentExecutionTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return raw as DocumentExecutionTrace;
}

export function useForgeDocumentDetail(
  documentId: string | null,
  orgId: string | null,
  /** Increment to reload detail after the same document is reprocessed in place. */
  reloadNonce: number = 0,
): ForgeDocumentDetailState {
  const [doc, setDoc] = useState<DocumentApiDetail | null>(null);
  const [extractions, setExtractions] = useState<ExtractionRow[]>([]);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [fileExt, setFileExt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId || !orgId) {
      setDoc(null);
      setExtractions([]);
      setSignedUrl(null);
      setFileExt('');
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setDoc(null);
      setExtractions([]);
      setSignedUrl(null);
      setFileExt('');

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const authHeaders: Record<string, string> = session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {};

        const orgParam = `?orgId=${encodeURIComponent(orgId)}`;

        const [docRes, extractionsResult, fileRes] = await Promise.all([
          fetch(`/api/documents/${documentId}${orgParam}`, { headers: authHeaders }),
          supabase
            .from('document_extractions')
            .select('id, data, created_at')
            .eq('document_id', documentId)
            .is('field_key', null)
            .order('created_at', { ascending: false }),
          fetch(`/api/documents/${documentId}/file${orgParam}`, { headers: authHeaders }),
        ]);

        if (cancelled) return;

        if (docRes.ok) {
          const docData = (await docRes.json().catch(() => null)) as DocumentApiDetail | null;
          if (docData && !cancelled) setDoc(docData);
        } else {
          const body = await docRes.json().catch(() => ({})) as { error?: string };
          if (!cancelled) setError(body?.error ?? 'Failed to load document');
        }

        if (!extractionsResult.error && extractionsResult.data && !cancelled) {
          setExtractions(extractionsResult.data as ExtractionRow[]);
        }

        if (fileRes.ok) {
          const fileBody = await fileRes.json().catch(() => ({})) as {
            signedUrl?: string;
            ext?: string;
          };
          if (!cancelled && fileBody.signedUrl) {
            setSignedUrl(fileBody.signedUrl);
            setFileExt(fileBody.ext ?? '');
          }
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load document');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [documentId, orgId, reloadNonce]);

  const preferredExtraction = useMemo(
    () =>
      extractions.length > 0
        ? pickPreferredExtractionBlob(extractions)
        : null,
    [extractions],
  );

  const executionTrace = useMemo(
    () => parseExecutionTrace(doc?.intelligence_trace ?? null),
    [doc],
  );

  const model = useMemo((): DocumentIntelligenceViewModel | null => {
    if (!doc) return null;
    try {
      return buildDocumentIntelligenceViewModel({
        documentId: doc.id,
        documentType: doc.document_type,
        documentName: doc.name,
        documentTitle: doc.title,
        projectName: resolveProjectName(doc.projects),
        preferredExtraction: preferredExtraction ?? null,
        relatedDocs: (doc.relatedDocs ?? []) as RelatedDocInput[],
        normalizedDecisions: [],
        extractionGaps: [],
        auditNotes: [],
        nodeTraces: [],
        executionTrace,
        extractionHistory: extractions,
        factOverrides: doc.factOverrides ?? [],
        factAnchors: doc.factAnchors ?? [],
        factReviews: doc.factReviews ?? [],
        reviewedDecisionIds: [],
      });
    } catch {
      return null;
    }
  }, [doc, executionTrace, extractions, preferredExtraction]);

  const filename = doc?.storage_path.split('/').at(-1) ?? doc?.name ?? '';

  return {
    model,
    signedUrl,
    fileExt,
    filename,
    loading,
    error,
  };
}

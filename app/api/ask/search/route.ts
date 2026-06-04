import { NextResponse } from 'next/server';
import { sanitizeAskQuestion } from '@/lib/ask/sqlGuardrails';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { AskAnswerContract, AskMatchedRecord } from '@/lib/ask/globalCommand';

type ProjectSearchRow = {
  id: string;
  name: string | null;
  code: string | null;
  status: string | null;
};

type DocumentSearchRow = {
  id: string;
  title: string | null;
  name: string | null;
  document_type: string | null;
  processing_status: string | null;
  project_id: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function includesQuery(values: Array<string | null | undefined>, query: string): boolean {
  const needle = query.toLowerCase();
  return values.some((value) => normalize(value).includes(needle));
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await request.json().catch(() => ({}));
  const question = sanitizeAskQuestion(body?.query ?? body?.question);
  if (!question) return jsonError('query is required', 400);

  const [projectsResult, documentsResult] = await Promise.all([
    admin
      .from('projects')
      .select('id, name, code, status')
      .eq('organization_id', actor.actor.organizationId)
      .limit(100),
    admin
      .from('documents')
      .select('id, title, name, document_type, processing_status, project_id')
      .eq('organization_id', actor.actor.organizationId)
      .limit(100),
  ]);

  if (projectsResult.error) return jsonError('Failed to search projects', 500);
  if (documentsResult.error) return jsonError('Failed to search documents', 500);

  const projectMatches: AskMatchedRecord[] = ((projectsResult.data ?? []) as ProjectSearchRow[])
    .filter((project) => includesQuery([project.name, project.code, project.status], question))
    .slice(0, 8)
    .map((project) => ({
      type: 'project',
      label: project.name ?? project.code ?? 'Untitled project',
      context: [project.code, project.status].filter(Boolean).join(' / ') || undefined,
      href: `/platform/projects/${encodeURIComponent(project.id)}`,
      source: 'projects',
    }));

  const documentMatches: AskMatchedRecord[] = ((documentsResult.data ?? []) as DocumentSearchRow[])
    .filter((document) =>
      includesQuery(
        [document.title, document.name, document.document_type, document.processing_status],
        question,
      ),
    )
    .slice(0, 8)
    .map((document) => ({
      type: 'document',
      label: document.title ?? document.name ?? 'Untitled document',
      context: [document.document_type, document.processing_status].filter(Boolean).join(' / ') || undefined,
      href: `/platform/documents/${encodeURIComponent(document.id)}`,
      source: 'documents',
    }));

  const matchedRecords = [...projectMatches, ...documentMatches].slice(0, 10);
  const dataFound = matchedRecords.length > 0;

  const response: AskAnswerContract = {
    scope: 'search',
    question,
    answer: dataFound
      ? `Found ${matchedRecords.length} matching record${matchedRecords.length === 1 ? '' : 's'} across projects and documents.`
      : 'No matching project or document records were found for this query.',
    evidence: matchedRecords.map((record) => ({
      label: record.label,
      href: record.href,
      source: record.source,
    })),
    sources: ['projects', 'documents'],
    checkedSources: ['projects table', 'documents table'],
    nextActions: [
      { label: 'Open Documents', href: '/platform/documents' },
      { label: 'Open Projects', href: '/platform/projects' },
    ],
    matchedRecords,
    availability: dataFound ? 'available' : 'unavailable',
    dataFound,
    generatedBy: 'search',
  };

  return NextResponse.json(response);
}

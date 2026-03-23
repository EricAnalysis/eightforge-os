import { NextResponse } from 'next/server';
import { buildGuardedQueryPlan, sanitizeAskQuestion, sanitizeScopedIdentifier } from '@/lib/ask/sqlGuardrails';
import { resolveProjectTemplate } from '@/lib/ask/queryTemplates';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';

type ProjectRow = {
  id: string;
  name: string;
};

type ProjectDocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
};

type ProjectDecisionRow = {
  id: string;
  document_id: string | null;
  title: string;
  status: string;
  severity: string;
};

type ProjectTaskRow = {
  id: string;
  document_id: string | null;
  title: string;
  status: string;
  priority: string;
  description: string | null;
};

const OPEN_DECISION_STATUSES = new Set(['open', 'in_review']);
const OPEN_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked']);

function parseTrace(value: ProjectDocumentRow['intelligence_trace']): DocumentExecutionTrace | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return candidate as DocumentExecutionTrace;
}

function documentLabel(document: ProjectDocumentRow): string {
  return document.title ?? document.name;
}

function firstMatchingDecision(
  trace: DocumentExecutionTrace | null,
  matcher: (decision: DocumentExecutionTrace['decisions'][number]) => boolean,
) {
  if (!trace) return null;
  return trace.decisions.find(matcher) ?? null;
}

function unsupportedResponse(answer: string) {
  return NextResponse.json({
    status: 'unsupported',
    answer,
    support: [],
  });
}

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const projectId = sanitizeScopedIdentifier(body?.projectId);
  const question = sanitizeAskQuestion(body?.question);

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const template = resolveProjectTemplate(question);
  if (!template) {
    return unsupportedResponse(
      'Supported project questions cover invoices over ceiling, tickets missing quantity support, documents pending review, and open actions.',
    );
  }

  const plan = buildGuardedQueryPlan('project', template, projectId);

  const { data: projectData, error: projectError } = await admin
    .from('projects')
    .select('id, name')
    .eq('organization_id', actor.actor.organizationId)
    .eq('id', projectId)
    .maybeSingle();

  if (projectError || !projectData) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const project = projectData as ProjectRow;
  const { data: documentsData } = await admin
    .from('documents')
    .select('id, title, name, document_type, processing_status, intelligence_trace')
    .eq('organization_id', actor.actor.organizationId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  const documents = (documentsData ?? []) as ProjectDocumentRow[];
  const documentIds = documents.map((document) => document.id);

  const [decisionsData, tasksData] = await Promise.all([
    documentIds.length > 0
      ? admin
          .from('decisions')
          .select('id, document_id, title, status, severity')
          .eq('organization_id', actor.actor.organizationId)
          .in('document_id', documentIds)
      : Promise.resolve({ data: [], error: null }),
    documentIds.length > 0
      ? admin
          .from('workflow_tasks')
          .select('id, document_id, title, status, priority, description')
          .eq('organization_id', actor.actor.organizationId)
          .in('document_id', documentIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const decisions = (decisionsData.data ?? []) as ProjectDecisionRow[];
  const tasks = (tasksData.data ?? []) as ProjectTaskRow[];
  const openDecisionsByDocument = new Map<string, ProjectDecisionRow[]>();
  const openTasksByDocument = new Map<string, ProjectTaskRow[]>();

  for (const decision of decisions.filter((row) => row.document_id && OPEN_DECISION_STATUSES.has(row.status))) {
    const docId = decision.document_id as string;
    const current = openDecisionsByDocument.get(docId) ?? [];
    current.push(decision);
    openDecisionsByDocument.set(docId, current);
  }

  for (const task of tasks.filter((row) => row.document_id && OPEN_TASK_STATUSES.has(row.status))) {
    const docId = task.document_id as string;
    const current = openTasksByDocument.get(docId) ?? [];
    current.push(task);
    openTasksByDocument.set(docId, current);
  }

  switch (template.id) {
    case 'project_invoices_exceed_contract_ceiling': {
      const support = documents
        .map((document) => {
          const trace = parseTrace(document.intelligence_trace ?? null);
          const match = firstMatchingDecision(
            trace,
            (decision) =>
              decision.rule_id === 'invoice_contract_ceiling_exceeded' ||
              decision.title.toLowerCase().includes('exceeds contract ceiling'),
          );
          if (!match) return null;
          return `${documentLabel(document)}: ${match.detail}`;
        })
        .filter((value): value is string => value != null)
        .slice(0, 8);

      return NextResponse.json({
        status: 'answered',
        answer: support.length > 0
          ? `${support.length} invoice record${support.length === 1 ? '' : 's'} currently exceed the linked contract ceiling in ${project.name}.`
          : `No invoice trace in ${project.name} currently records a contract ceiling exceedance.`,
        support,
        trace: plan,
      });
    }

    case 'project_tickets_missing_quantity_support': {
      const support = documents
        .map((document) => {
          const trace = parseTrace(document.intelligence_trace ?? null);
          const match = firstMatchingDecision(
            trace,
            (decision) =>
              decision.rule_id === 'ticket_quantity_missing' ||
              decision.title.toLowerCase().includes('missing quantity support'),
          );
          if (!match) return null;
          const action = match.primary_action?.description ? ` ${match.primary_action.description}` : '';
          return `${documentLabel(document)}: ${match.detail}${action}`;
        })
        .filter((value): value is string => value != null)
        .slice(0, 8);

      return NextResponse.json({
        status: 'answered',
        answer: support.length > 0
          ? `${support.length} ticket support record${support.length === 1 ? '' : 's'} still have quantity gaps in ${project.name}.`
          : `No ticket trace in ${project.name} currently records missing quantity support.`,
        support,
        trace: plan,
      });
    }

    case 'project_documents_pending_review': {
      const support = documents
        .map((document) => {
          const openDecisions = openDecisionsByDocument.get(document.id) ?? [];
          const openTasks = openTasksByDocument.get(document.id) ?? [];
          if (document.processing_status && document.processing_status !== 'decisioned') {
            return `${documentLabel(document)}: status ${document.processing_status.replace(/_/g, ' ')}.`;
          }
          if (openDecisions.length > 0) {
            return `${documentLabel(document)}: ${openDecisions.length} open decision${openDecisions.length === 1 ? '' : 's'}.`;
          }
          if (openTasks.length > 0) {
            return `${documentLabel(document)}: ${openTasks.length} open action${openTasks.length === 1 ? '' : 's'}.`;
          }
          return null;
        })
        .filter((value): value is string => value != null)
        .slice(0, 10);

      return NextResponse.json({
        status: 'answered',
        answer: support.length > 0
          ? `${support.length} document${support.length === 1 ? '' : 's'} in ${project.name} are still pending review.`
          : `All linked documents in ${project.name} are currently decisioned with no open review queue items.`,
        support,
        trace: plan,
      });
    }

    case 'project_open_actions': {
      const byDocumentId = new Map(documents.map((document) => [document.id, document]));
      const support = tasks
        .filter((task) => OPEN_TASK_STATUSES.has(task.status))
        .slice(0, 10)
        .map((task) => {
          const document = task.document_id ? byDocumentId.get(task.document_id) : null;
          const prefix = document ? `${documentLabel(document)}: ` : '';
          return `${prefix}${task.description?.trim() || task.title}`;
        });

      return NextResponse.json({
        status: 'answered',
        answer: support.length > 0
          ? `${support.length} open action${support.length === 1 ? '' : 's'} are currently queued in ${project.name}.`
          : `No open workflow actions are currently queued in ${project.name}.`,
        support,
        trace: plan,
      });
    }
  }
}

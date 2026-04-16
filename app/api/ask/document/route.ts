import { NextResponse } from 'next/server';
import { buildGuardedQueryPlan, sanitizeAskQuestion, sanitizeScopedIdentifier } from '@/lib/ask/sqlGuardrails';
import { factLabel, factTerms, resolveDocumentTemplate, type AskFactKey } from '@/lib/ask/queryTemplates';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';
import type { EvidenceObject } from '@/lib/extraction/types';

type DocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
};

type DecisionRow = {
  id: string;
  title: string;
  status: string;
  severity: string;
  details?: Record<string, unknown> | null;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
};

const OPEN_DECISION_STATUSES = new Set(['open', 'in_review']);
const OPEN_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked']);
const MONEY_FACTS = new Set<AskFactKey>(['billed_amount', 'contract_ceiling', 'approved_amount']);

function parseTrace(value: DocumentRow['intelligence_trace']): DocumentExecutionTrace | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return candidate as DocumentExecutionTrace;
}

function documentLabel(document: DocumentRow): string {
  return document.title ?? document.name;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function formatFactValue(factKey: AskFactKey, value: unknown): string {
  if (typeof value === 'number') {
    return MONEY_FACTS.has(factKey) ? formatCurrency(value) : value.toLocaleString('en-US');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return 'Structured value';
    }
  }
  return 'Missing';
}

function evidenceLocationLabel(evidence: EvidenceObject): string {
  const parts: string[] = [];
  if (typeof evidence.location.page === 'number') parts.push(`p.${evidence.location.page}`);
  if (typeof evidence.location.sheet === 'string' && evidence.location.sheet.length > 0) parts.push(evidence.location.sheet);
  if (typeof evidence.location.row === 'number') parts.push(`row ${evidence.location.row}`);
  if (typeof evidence.location.section === 'string' && evidence.location.section.length > 0) parts.push(evidence.location.section);
  if (typeof evidence.location.label === 'string' && evidence.location.label.length > 0) parts.push(evidence.location.label);
  return parts.length > 0 ? parts.join(' • ') : 'Source context limited';
}

function matchingEvidence(trace: DocumentExecutionTrace | null, factKey: AskFactKey): EvidenceObject[] {
  if (!trace?.evidence) return [];
  const terms = factTerms(factKey);
  return trace.evidence.filter((evidence) => {
    const haystack = [
      evidence.description,
      evidence.text,
      evidence.value == null ? '' : String(evidence.value),
      evidence.location.label,
      evidence.location.section,
      evidence.location.nearby_text,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

function primaryActionDescription(details: Record<string, unknown> | null | undefined): string | null {
  const primaryAction = details?.primary_action;
  if (!primaryAction || typeof primaryAction !== 'object') return null;
  const description = (primaryAction as { description?: unknown }).description;
  return typeof description === 'string' && description.trim().length > 0 ? description.trim() : null;
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
  const documentId = sanitizeScopedIdentifier(body?.documentId);
  const question = sanitizeAskQuestion(body?.question);

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const template = resolveDocumentTemplate(question);
  if (!template) {
    return unsupportedResponse(
      'Supported document questions cover review status, missing support, next actions, invoice numbers, billed amounts, contract ceilings, contractor identity, and approved amounts.',
    );
  }

  const plan = buildGuardedQueryPlan('document', template, documentId);

  const [documentResult, decisionsResult, tasksResult] = await Promise.all([
    admin
      .from('documents')
      .select('id, title, name, document_type, processing_status, intelligence_trace')
      .eq('organization_id', actor.actor.organizationId)
      .eq('id', documentId)
      .maybeSingle(),
    admin
      .from('decisions')
      .select('id, title, status, severity, details')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId),
    admin
      .from('workflow_tasks')
      .select('id, title, status, priority, description')
      .eq('organization_id', actor.actor.organizationId)
      .eq('document_id', documentId),
  ]);

  if (documentResult.error || !documentResult.data) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }

  const document = documentResult.data as DocumentRow;
  const trace = parseTrace(document.intelligence_trace ?? null);
  const decisions = (decisionsResult.data ?? []) as DecisionRow[];
  const tasks = (tasksResult.data ?? []) as TaskRow[];
  const openDecisions = decisions.filter((row) => OPEN_DECISION_STATUSES.has(row.status));
  const openTasks = tasks.filter((row) => OPEN_TASK_STATUSES.has(row.status));

  switch (template.id) {
    case 'document_pending_review': {
      const support: string[] = [];

      if (document.processing_status && document.processing_status !== 'decisioned') {
        support.push(`${documentLabel(document)} is currently ${document.processing_status.replace(/_/g, ' ')}.`);
      }
      support.push(...openDecisions.slice(0, 4).map((row) => `Open decision: ${row.title} (${row.severity}).`));
      support.push(...openTasks.slice(0, 4).map((row) => `Open action: ${row.title} (${row.priority}).`));
      if ((trace?.extraction_gaps?.length ?? 0) > 0) {
        support.push(`Extraction gaps recorded: ${trace?.extraction_gaps?.length ?? 0}.`);
      }

      const answer = support.length > 0
        ? `${documentLabel(document)} is still pending review.`
        : `${documentLabel(document)} does not currently have open review items recorded.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_missing_evidence': {
      const support: string[] = [];
      const gaps = trace?.extraction_gaps ?? [];
      const missingContext = trace?.decisions.flatMap((decision) =>
        (decision.missing_source_context ?? []).map((item) => `${decision.title}: ${item}`),
      ) ?? [];

      support.push(...gaps.slice(0, 5).map((gap) => `${gap.category}: ${gap.message}`));
      support.push(...missingContext.slice(0, 5));

      const answer = support.length > 0
        ? `Missing support is still recorded for ${documentLabel(document)}.`
        : `No explicit extraction gaps or missing source context are recorded for ${documentLabel(document)}.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_next_actions': {
      const support: string[] = [];
      support.push(...openTasks.slice(0, 5).map((task) => task.description?.trim() || task.title));

      if (support.length === 0 && trace) {
        const fallbackActions = trace.decisions
          .filter((decision) => decision.family !== 'confirmed')
          .map((decision) => decision.primary_action?.description)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        support.push(...fallbackActions.slice(0, 5));
      }

      const answer = support.length > 0
        ? `Next actions are available for ${documentLabel(document)}.`
        : `No open action is recorded for ${documentLabel(document)} right now.`;

      return NextResponse.json({
        status: 'answered',
        answer,
        support,
        trace: plan,
      });
    }

    case 'document_fact_lookup': {
      const factKey = template.params?.fact_key;
      if (!factKey || !trace) {
        return NextResponse.json({
          status: 'unsupported',
          answer: 'This document does not have a persisted fact trace yet.',
          support: [],
          trace: plan,
        });
      }

      const value = trace.facts[factKey];
      const support: string[] = [];
      const factName = factLabel(factKey);

      if (value == null || value === '') {
        support.push(`No grounded ${factName.toLowerCase()} is present in the document trace.`);
        return NextResponse.json({
          status: 'answered',
          answer: `${factName} is missing from the grounded document facts.`,
          support,
          trace: plan,
        });
      }

      support.push(`${factName}: ${formatFactValue(factKey, value)}`);
      const evidence = matchingEvidence(trace, factKey).slice(0, 3);
      if (evidence.length > 0) {
        support.push(
          ...evidence.map((item) => `${item.description} (${evidenceLocationLabel(item)}).`),
        );
      } else {
        support.push(`No direct evidence object is stored for ${factName.toLowerCase()}.`);
      }

      return NextResponse.json({
        status: 'answered',
        answer: `${factName} resolves to ${formatFactValue(factKey, value)}.`,
        support,
        trace: plan,
      });
    }
  }
}

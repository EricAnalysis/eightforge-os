import type { AskScope, ResolvedAskTemplate } from '@/lib/ask/queryTemplates';

export interface GuardedQueryPlan {
  scope: AskScope;
  template_id: ResolvedAskTemplate['id'];
  template_label: string;
  allowed_tables: string[];
  filters: string[];
  query_plan: string;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function sanitizeAskQuestion(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const sanitized = collapseWhitespace(input);
  if (sanitized.length === 0 || sanitized.length > 240) return null;
  return sanitized;
}

export function sanitizeScopedIdentifier(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const sanitized = collapseWhitespace(input);
  return /^[A-Za-z0-9_-]{1,128}$/.test(sanitized) ? sanitized : null;
}

export function buildGuardedQueryPlan(
  scope: AskScope,
  template: ResolvedAskTemplate,
  scopedId: string,
): GuardedQueryPlan {
  switch (template.id) {
    case 'document_pending_review':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents', 'decisions', 'workflow_tasks'],
        filters: [`documents.id = ${scopedId}`, 'status in open review states'],
        query_plan: 'documents -> decisions/workflow_tasks for one document',
      };
    case 'document_missing_evidence':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents'],
        filters: [`documents.id = ${scopedId}`, 'intelligence_trace extraction_gaps and missing_source_context only'],
        query_plan: 'documents.intelligence_trace gaps for one document',
      };
    case 'document_next_actions':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents', 'workflow_tasks', 'decisions'],
        filters: [`documents.id = ${scopedId}`, 'open workflow tasks or unresolved primary actions only'],
        query_plan: 'workflow_tasks with document fallback to trace primary actions',
      };
    case 'document_fact_lookup':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents'],
        filters: [`documents.id = ${scopedId}`, `trace fact ${template.params?.fact_key ?? 'unknown'}`],
        query_plan: 'documents.intelligence_trace fact lookup with cited evidence only',
      };
    case 'project_invoices_exceed_contract_ceiling':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents'],
        filters: [`documents.project_id = ${scopedId}`, 'invoice traces with contract ceiling mismatch decisions only'],
        query_plan: 'project documents filtered to invoice trace ceiling decisions',
      };
    case 'project_tickets_missing_quantity_support':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents'],
        filters: [`documents.project_id = ${scopedId}`, 'ticket traces with missing quantity decisions only'],
        query_plan: 'project documents filtered to ticket quantity-support gaps',
      };
    case 'project_documents_pending_review':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents', 'decisions', 'workflow_tasks'],
        filters: [`documents.project_id = ${scopedId}`, 'documents not decisioned or with open queue items only'],
        query_plan: 'project documents plus open decision/task queue',
      };
    case 'project_open_actions':
      return {
        scope,
        template_id: template.id,
        template_label: template.label,
        allowed_tables: ['documents', 'workflow_tasks'],
        filters: [`documents.project_id = ${scopedId}`, 'workflow_tasks in open states only'],
        query_plan: 'project workflow_tasks in open states',
      };
  }
}

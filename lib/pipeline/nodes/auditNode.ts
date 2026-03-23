import type {
  ActionNodeOutput,
  AuditNodeOutput,
  PipelineAuditNote,
  PipelineDecision,
  PipelineFact as Fact,
} from '@/lib/pipeline/types';
import type { DetectedEntity } from '@/lib/types/documentIntelligence';

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function confidenceAverage(values: number[]): number | undefined {
  const filtered = values.filter((value) => value > 0);
  if (filtered.length === 0) return undefined;
  return Number((filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(3));
}

function factOrNull(facts: Record<string, Fact>, key: string): Fact | null {
  return facts[key] ?? null;
}

function buildKeyFacts(input: ActionNodeOutput): AuditNodeOutput['key_facts'] {
  const facts = input.primaryDocument.fact_map;
  const keysByFamily: Record<string, string[]> = {
    contract: ['contractor_name', 'contract_ceiling', 'rate_schedule_present', 'executed_date'],
    invoice: ['invoice_number', 'billed_amount', 'contractor_name', 'invoice_date'],
    payment_recommendation: ['invoice_reference', 'approved_amount', 'contractor_name'],
    ticket: ['ticket_row_count', 'missing_quantity_rows', 'missing_rate_rows'],
    spreadsheet: ['sheet_count', 'sheet_names'],
  };
  const selectedKeys = keysByFamily[input.primaryDocument.family] ?? [];
  return selectedKeys
    .map((key) => factOrNull(facts, key))
    .filter((fact): fact is Fact => fact != null && fact.value != null)
    .slice(0, 6)
    .map((fact) => ({
      id: fact.id,
      label: fact.label,
      value: fact.display_value,
    }));
}

function buildEntities(input: ActionNodeOutput): AuditNodeOutput['entities'] {
  const entities: DetectedEntity[] = buildKeyFacts(input).map((fact) => ({
    key: fact.id,
    label: fact.label,
    value: String(fact.value),
    status: 'neutral',
  }));

  const actionable = input.decisions.find((decision) => decision.family !== 'confirmed');
  if (actionable) {
    entities.unshift({
      key: 'status',
      label: 'Status',
      value: 'Needs review',
      status: actionable.severity === 'critical' ? 'critical' : 'warning',
      tooltip: actionable.title,
    });
  } else {
    entities.unshift({
      key: 'status',
      label: 'Status',
      value: 'Evidence ready',
      status: 'ok',
    });
  }

  return entities.slice(0, 6);
}

function decisionAuditNotes(decisions: PipelineDecision[]): PipelineAuditNote[] {
  return decisions
    .filter((decision) => decision.family !== 'confirmed')
    .map((decision) => {
      const refs = (decision.source_refs ?? []).join(', ') || '—';
      const gaps =
        (decision.missing_source_context ?? []).filter((g) => g.trim().length > 0).join('; ') || '—';
      return {
        id: `audit:decision:${decision.id}`,
        stage: 'audit' as const,
        status:
          decision.severity === 'critical'
            ? 'critical' as const
            : decision.severity === 'warning'
              ? 'warning' as const
              : 'info' as const,
        message: `${decision.title} — ${decision.reason ?? decision.detail} · Scope: ${decision.reconciliation_scope ?? 'unspecified'} · Evidence / xref ids: ${refs} · Open: ${gaps} · ${Math.round(decision.confidence * 100)}%`,
        evidence_refs: decision.source_refs,
        fact_refs: decision.fact_refs,
      };
    });
}

function buildQuestions(input: ActionNodeOutput): AuditNodeOutput['suggested_questions'] {
  switch (input.primaryDocument.family) {
    case 'contract':
      return [
        { id: 'q:contract:ceiling', question: 'Where is the contract ceiling evidenced?', intent: 'facts' },
        { id: 'q:contract:rates', question: 'Which pages contain the rate schedule?', intent: 'facts' },
      ];
    case 'invoice':
      return [
        { id: 'q:invoice:support', question: 'What support is still missing for this invoice?', intent: 'action' },
        { id: 'q:invoice:mismatch', question: 'Does the invoice amount match the payment recommendation?', intent: 'comparison' },
      ];
    case 'payment_recommendation':
      return [
        { id: 'q:payrec:ceiling', question: 'Is the payment recommendation bounded by a contract ceiling?', intent: 'risk' },
        { id: 'q:payrec:invoice', question: 'Which invoice does this payment recommendation reference?', intent: 'facts' },
      ];
    case 'ticket':
      return [
        { id: 'q:ticket:quantity', question: 'Which ticket rows are missing quantity support?', intent: 'risk' },
        { id: 'q:ticket:rate', question: 'Which ticket rows are missing rate support?', intent: 'risk' },
      ];
    default:
      return [];
  }
}

export function auditNode(input: ActionNodeOutput): AuditNodeOutput {
  const actionable = input.decisions.find((decision) => decision.family !== 'confirmed');
  const familyLabel = titleize(input.primaryDocument.family);
  const nextAction = input.actions[0]?.title ?? 'No action required.';
  const citationCount = input.decisions.reduce(
    (sum, decision) => sum + (decision.source_refs?.length ?? 0),
    0,
  );
  const summary = {
    headline: actionable
      ? `${familyLabel} needs review: ${actionable.title}.`
      : `${familyLabel} evidence is ready for operator review.`,
    nextAction,
    confidence: confidenceAverage([
      input.confidence,
      ...input.decisions.map((decision) => decision.confidence),
    ]),
    traceHint:
      input.decisions.length > 0
        ? `${input.decisions.length} decision record(s), ${citationCount} evidence id(s) linked.`
        : undefined,
  };

  return {
    ...input,
    audit_notes: [...input.audit_notes, ...decisionAuditNotes(input.decisions)],
    node_traces: [],
    summary,
    key_facts: buildKeyFacts(input),
    entities: buildEntities(input),
    suggested_questions: buildQuestions(input),
  };
}

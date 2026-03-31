import { actionNode } from '@/lib/pipeline/nodes/actionNode';
import { auditNode } from '@/lib/pipeline/nodes/auditNode';
import { decisionNode } from '@/lib/pipeline/nodes/decisionNode';
import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import { analyzeContractIntelligence } from '@/lib/contracts/analyzeContractIntelligence';
import type {
  DocumentPipelineResult,
  ExtractNodeInput,
  PipelineDecision,
  PipelineNodeTrace,
} from '@/lib/pipeline/types';
import type {
  DocumentFamily,
  DocumentIntelligenceOutput,
  GeneratedDecision,
  IntelligenceIssue,
  TriggeredWorkflowTask,
} from '@/lib/types/documentIntelligence';

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function trace(
  node: PipelineNodeTrace['node'],
  summary: string,
  counts: Partial<PipelineNodeTrace>,
): PipelineNodeTrace {
  return {
    node,
    status: 'completed',
    summary,
    gap_count: counts.gap_count ?? 0,
    evidence_count: counts.evidence_count,
    fact_count: counts.fact_count,
    decision_count: counts.decision_count,
    action_count: counts.action_count,
  };
}

function decisionStatus(decision: PipelineDecision): GeneratedDecision['status'] {
  if (decision.family === 'missing') return 'missing';
  if (decision.family === 'mismatch') return 'mismatch';
  if (decision.family === 'risk') return 'risky';
  return 'passed';
}

function decisionSeverity(decision: PipelineDecision): NonNullable<GeneratedDecision['severity']> {
  if (decision.severity === 'critical') return 'critical';
  if (decision.severity === 'warning') return 'high';
  return 'low';
}

function taskPriority(priority: TriggeredWorkflowTask['priority']): 'low' | 'medium' | 'high' {
  if (priority === 'P1') return 'high';
  if (priority === 'P2') return 'medium';
  return 'low';
}

function toGeneratedDecision(
  decision: PipelineDecision,
  relatedTaskIds: string[],
): GeneratedDecision {
  return {
    id: decision.id,
    type: decision.rule_id ?? decision.field_key ?? decision.title,
    status: decisionStatus(decision),
    title: decision.title,
    explanation: decision.detail,
    reason: decision.reason ?? decision.detail,
    severity: decisionSeverity(decision),
    primary_action: decision.primary_action,
    suggested_actions: decision.suggested_actions,
    confidence: decision.confidence,
    relatedTaskIds: relatedTaskIds.length > 0 ? relatedTaskIds : undefined,
    family: decision.family,
    detail: decision.detail,
    field_key: decision.field_key,
    expected_location: decision.expected_location,
    observed_value: decision.observed_value,
    expected_value: decision.expected_value,
    impact: decision.impact,
    fact_refs: decision.fact_refs,
    source_refs: decision.source_refs,
    rule_id: decision.rule_id,
    normalized_severity: decision.severity,
    normalization_mode: 'structured',
    evidence_objects: decision.evidence_objects,
    missing_source_context: decision.missing_source_context,
    reconciliation_scope: decision.reconciliation_scope,
  };
}

function toIssues(decisions: GeneratedDecision[]): IntelligenceIssue[] {
  return decisions
    .filter((decision) => decision.status !== 'passed')
    .slice(0, 5)
    .map((decision) => ({
      id: decision.id,
      title: decision.title,
      severity:
        decision.severity === 'critical' ? 'critical' :
        decision.severity === 'high' ? 'high' :
        decision.severity === 'low' ? 'low' :
        'medium',
      summary: decision.detail ?? decision.explanation,
      action: decision.primary_action?.description ?? decision.action ?? 'No action generated',
    }));
}

export function runDocumentPipeline(input: ExtractNodeInput): DocumentPipelineResult {
  const extracted = extractNode(input);
  const normalized = normalizeNode(extracted);
  const analyzed = {
    ...normalized,
    contractAnalysis: analyzeContractIntelligence({
      primaryDocument: normalized.primaryDocument,
      relatedDocuments: normalized.relatedDocuments,
    }),
  };
  const decided = decisionNode(analyzed);
  const actioned = actionNode(decided);
  const audited = auditNode(actioned);

  audited.node_traces = [
    trace('extract', `Collected ${extracted.evidence.length} evidence object${extracted.evidence.length === 1 ? '' : 's'}.`, {
      gap_count: extracted.gaps.length,
      evidence_count: extracted.evidence.length,
    }),
    trace('normalize', `Normalized ${normalized.primaryDocument.facts.length} primary facts.`, {
      gap_count: normalized.gaps.length,
      evidence_count: normalized.evidence.length,
      fact_count: normalized.primaryDocument.facts.length,
    }),
    trace(
      'decision',
      `Generated ${decided.decisions.length} decision record${decided.decisions.length === 1 ? '' : 's'}; `
        + `${decided.decisions.reduce((n, d) => n + (d.source_refs?.length ?? 0), 0)} evidence id(s) linked.`,
      {
        gap_count: decided.gaps.length,
        decision_count: decided.decisions.length,
        evidence_citation_count: decided.decisions.reduce((n, d) => n + (d.source_refs?.length ?? 0), 0),
      },
    ),
    trace('action', `Generated ${actioned.actions.length} action record${actioned.actions.length === 1 ? '' : 's'}.`, {
      gap_count: actioned.gaps.length,
      action_count: actioned.actions.length,
    }),
    trace('audit', `Prepared ${audited.audit_notes.length} audit note${audited.audit_notes.length === 1 ? '' : 's'}.`, {
      gap_count: audited.gaps.length,
    }),
  ];

  return {
    ...audited,
    handled: audited.primaryDocument.family !== 'generic',
  };
}

export function pipelineResultToIntelligence(
  result: DocumentPipelineResult,
): DocumentIntelligenceOutput {
  const decisionTaskIds = result.decision_task_ids;
  const decisions = result.decisions.map((decision) =>
    toGeneratedDecision(decision, decisionTaskIds.get(decision.id) ?? []),
  );
  const tasks: TriggeredWorkflowTask[] = result.actions.map((task) => ({
    id: task.id,
    title: task.title,
    priority:
      task.priority === 'high' ? 'P1' :
      task.priority === 'medium' ? 'P2' :
      'P3',
    reason: task.expected_outcome,
    status: 'open',
    autoCreated: true,
    flow_type: task.flow_type,
  }));

  return {
    classification: {
      family: result.primaryDocument.family as DocumentFamily,
      label: titleize(result.primaryDocument.family),
      confidence: result.summary.confidence,
    },
    summary: result.summary,
    keyFacts: result.key_facts,
    issues: toIssues(decisions),
    entities: result.entities,
    decisions,
    tasks,
    normalizedDecisions: result.decisions,
    flowTasks: result.actions,
    facts: result.facts,
    suggestedQuestions: result.suggested_questions,
    extracted: result.extracted,
    evidence: result.evidence,
    extractionGaps: result.gaps,
    auditNotes: result.audit_notes,
    nodeTraces: result.node_traces,
    contractAnalysis: result.contractAnalysis ?? null,
  };
}

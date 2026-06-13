// lib/rules/adapter.ts
// Maps RuleOutput[] → the existing DocumentIntelligenceOutput contract.
// This is the bridge between the rule engine and the canonical intelligence path.
// No server imports — client-safe.

import type {
  RuleOutput,
  RuleEvaluationResult,
} from './types.ts';
import { TASK_TITLES } from './types.ts';
import type {
  GeneratedDecision,
  TriggeredWorkflowTask,
  DetectedEntity,
  DocumentSummary,
  IntelligenceStatus,
  DecisionSeverity,
  TaskPriority,
} from '../types/documentIntelligence';

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapDecisionType(d: RuleOutput['decision']): IntelligenceStatus {
  switch (d) {
    case 'PASS': return 'passed';
    case 'INFO': return 'info';
    case 'WARN': return 'risky';
    case 'BLOCK': return 'mismatch';
    case 'MISSING': return 'missing';
  }
}

function mapSeverity(s: RuleOutput['severity']): DecisionSeverity {
  switch (s) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
  }
}

function mapPriority(p: RuleOutput['priority']): TaskPriority {
  switch (p) {
    case 'P1': return 'P1';
    case 'P2': return 'P2';
    case 'P3':
    case 'P4':
    default: return 'P3';
  }
}

let _counter = 0;
function stableId(prefix: string): string {
  _counter += 1;
  return `${prefix}_${_counter}`;
}

export function resetIdCounter(): void {
  _counter = 0;
}

// ─── Core mapping ────────────────────────────────────────────────────────────

export interface RuleOutputMapped {
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
  blockers: RuleOutput[];
  findings: RuleOutput[];
}

export function mapRuleOutputs(outputs: RuleOutput[]): RuleOutputMapped {
  resetIdCounter();

  const decisions: GeneratedDecision[] = [];
  const tasks: TriggeredWorkflowTask[] = [];
  const blockers: RuleOutput[] = [];
  const findings: RuleOutput[] = outputs;

  for (const o of outputs) {
    if (o.blockProcessing) {
      blockers.push(o);
    }

    const taskId = o.taskType ? stableId('task') : undefined;

    if (o.taskType && o.decision !== 'PASS') {
      tasks.push({
        id: taskId!,
        title: TASK_TITLES[o.taskType] ?? o.finding,
        priority: mapPriority(o.priority),
        reason: o.reason,
        suggestedOwner: o.ownerSuggestion,
        status: 'open',
        autoCreated: true,
        dedupeKey: `taskType:${o.taskType}`,
      });
    }

    decisions.push({
      id: stableId('dec'),
      type: o.ruleId.toLowerCase().replace(/-/g, '_'),
      status: mapDecisionType(o.decision),
      title: o.finding,
      explanation: o.reason,
      severity: mapSeverity(o.severity),
      action: o.taskType ? (TASK_TITLES[o.taskType] ?? o.finding) : undefined,
      confidence: 1,
      evidence: o.evidence,
      relatedTaskIds: taskId ? [taskId] : undefined,
    });
  }

  return { decisions, tasks, blockers, findings };
}

// ─── Summary builder ─────────────────────────────────────────────────────────

export function buildRuleSummary(
  result: RuleEvaluationResult,
  mapped: RuleOutputMapped,
): DocumentSummary {
  const hasBlocker = mapped.blockers.length > 0;
  const hasWarn = result.outputs.some(o => o.decision === 'WARN');
  const hasMissing = result.outputs.some(o => o.decision === 'MISSING');
  const hasIssue = hasBlocker || hasWarn || hasMissing;

  if (!hasIssue) {
    return {
      headline: 'No action required.',
      nextAction: 'All checks passed for this document.',
    };
  }

  const topOutput = mapped.blockers[0]
    ?? result.outputs.find(o => o.decision === 'WARN')
    ?? result.outputs.find(o => o.decision === 'MISSING')
    ?? result.outputs[0];

  const headline = hasBlocker
    ? `Blocked: ${topOutput.finding}`
    : `Needs review: ${topOutput.finding}`;

  const nextAction = mapped.tasks.length > 0
    ? `Resolve ${mapped.tasks.length} flagged item${mapped.tasks.length > 1 ? 's' : ''} before proceeding.`
    : 'Review flagged findings.';

  return { headline, nextAction };
}

// ─── Chip builder ────────────────────────────────────────────────────────────

export function buildRuleChips(
  result: RuleEvaluationResult,
  mapped: RuleOutputMapped,
): DetectedEntity[] {
  const chips: DetectedEntity[] = [];

  if (mapped.blockers.length > 0) {
    chips.push({
      key: 'blockers',
      label: 'Blockers',
      value: `${mapped.blockers.length}`,
      status: 'critical',
      tooltip: mapped.blockers.map(b => b.finding).join('; '),
    });
  }

  const warns = result.outputs.filter(o => o.decision === 'WARN').length;
  if (warns > 0) {
    chips.push({
      key: 'warnings',
      label: 'Warnings',
      value: `${warns}`,
      status: 'warning',
    });
  }

  const missing = result.outputs.filter(o => o.decision === 'MISSING').length;
  if (missing > 0) {
    chips.push({
      key: 'missing',
      label: 'Missing',
      value: `${missing}`,
      status: 'warning',
    });
  }

  if (chips.length === 0) {
    chips.push({
      key: 'status',
      label: 'Status',
      value: 'All checks passed',
      status: 'ok',
    });
  }

  return chips;
}

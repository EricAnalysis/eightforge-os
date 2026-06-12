'use client';

import type { EvidenceObject } from '@/lib/extraction/types';
import type { GeneratedDecision, ReviewErrorType } from '@/lib/types/documentIntelligence';

type DecisionDisplayGroup =
  | 'critical_risk'
  | 'mismatch'
  | 'missing'
  | 'risk'
  | 'confirmed'
  | 'info';

const GROUP_ORDER: DecisionDisplayGroup[] = [
  'critical_risk',
  'mismatch',
  'missing',
  'risk',
  'confirmed',
  'info',
];

const GROUP_CONFIG: Record<DecisionDisplayGroup, {
  icon: string;
  color: string;
  label: string;
}> = {
  critical_risk: {
    icon: '!',
    color: 'text-[var(--ef-critical)] bg-[var(--ef-critical-a10)] border-[var(--ef-critical-a20)]',
    label: 'Critical Risk',
  },
  mismatch: {
    icon: 'x',
    color: 'text-[var(--ef-critical)] bg-[var(--ef-critical-a10)] border-[var(--ef-critical-a20)]',
    label: 'Mismatch',
  },
  missing: {
    icon: 'o',
    color: 'text-[var(--ef-text-muted)] bg-white/5 border-[var(--ef-border-white-10)]',
    label: 'Missing',
  },
  risk: {
    icon: '!',
    color: 'text-[var(--ef-warning)] bg-[var(--ef-warning-bg)] border-[var(--ef-warning-a20)]',
    label: 'Risk',
  },
  confirmed: {
    icon: 'ok',
    color: 'text-[var(--ef-success)] bg-[var(--ef-success-bg)] border-[var(--ef-success-a20)]',
    label: 'Confirmed',
  },
  info: {
    icon: 'i',
    color: 'text-[var(--ef-purple-accent)] bg-[var(--ef-purple-primary-a10)] border-[var(--ef-purple-primary-a20)]',
    label: 'Info',
  },
};

function inferDecisionFamily(decision: GeneratedDecision): 'missing' | 'mismatch' | 'risk' | 'confirmed' {
  if (
    decision.family === 'missing' ||
    decision.family === 'mismatch' ||
    decision.family === 'risk' ||
    decision.family === 'confirmed'
  ) {
    return decision.family;
  }

  if (decision.status === 'missing') return 'missing';
  if (decision.status === 'mismatch') return 'mismatch';
  if (decision.status === 'risky') return 'risk';
  return 'confirmed';
}

function inferDecisionSeverity(decision: GeneratedDecision): 'info' | 'warning' | 'critical' {
  if (
    decision.normalized_severity === 'info' ||
    decision.normalized_severity === 'warning' ||
    decision.normalized_severity === 'critical'
  ) {
    return decision.normalized_severity;
  }

  if (decision.severity === 'critical') return 'critical';
  if (decision.severity === 'high' || decision.severity === 'medium') return 'warning';
  if (decision.severity === 'low') {
    return decision.status === 'passed' || decision.status === 'info' ? 'info' : 'warning';
  }

  if (decision.status === 'mismatch') return 'critical';
  if (decision.status === 'missing' || decision.status === 'risky') return 'warning';
  return 'info';
}

function displayGroupForDecision(decision: GeneratedDecision): DecisionDisplayGroup {
  const family = inferDecisionFamily(decision);
  const severity = inferDecisionSeverity(decision);

  if (family === 'risk' && severity === 'critical') return 'critical_risk';
  if (family === 'mismatch') return 'mismatch';
  if (family === 'missing') return 'missing';
  if (family === 'risk') return 'risk';
  if (family === 'confirmed' && severity === 'info') {
    return decision.status === 'info' ? 'info' : 'confirmed';
  }

  return family === 'confirmed' ? 'confirmed' : 'info';
}

function groupRank(group: DecisionDisplayGroup): number {
  return GROUP_ORDER.indexOf(group);
}

function sortDecisions(a: GeneratedDecision, b: GeneratedDecision): number {
  const groupDelta = groupRank(displayGroupForDecision(a)) - groupRank(displayGroupForDecision(b));
  if (groupDelta !== 0) return groupDelta;

  const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
  if (confidenceDelta !== 0) return confidenceDelta;

  return a.title.localeCompare(b.title);
}

type DecisionFeedbackState = {
  status: 'correct' | 'incorrect';
  reviewErrorType?: ReviewErrorType | null;
};

function reviewErrorLabel(reviewErrorType: ReviewErrorType | null | undefined): string {
  if (reviewErrorType === 'extraction_error') return 'Extraction error';
  if (reviewErrorType === 'rule_error') return 'Rule error';
  if (reviewErrorType === 'edge_case') return 'Edge case';
  return 'Incorrect';
}

function decisionReason(decision: GeneratedDecision): string {
  return decision.reason ?? decision.detail ?? decision.explanation;
}

function primaryActionLabel(decision: GeneratedDecision): string {
  return decision.primary_action?.description ?? decision.action ?? '';
}

function evidenceLocationLabel(evidence: EvidenceObject): string {
  const parts: string[] = [];
  if (typeof evidence.location.page === 'number') parts.push(`p.${evidence.location.page}`);
  if (typeof evidence.location.sheet === 'string' && evidence.location.sheet.length > 0) {
    parts.push(evidence.location.sheet);
  }
  if (typeof evidence.location.row === 'number') parts.push(`row ${evidence.location.row}`);
  if (typeof evidence.location.column === 'string' && evidence.location.column.length > 0) {
    parts.push(`col ${evidence.location.column}`);
  }
  if (typeof evidence.location.section === 'string' && evidence.location.section.length > 0) {
    parts.push(evidence.location.section);
  }
  if (typeof evidence.location.label === 'string' && evidence.location.label.length > 0) {
    parts.push(evidence.location.label);
  }
  return parts.length > 0 ? parts.join(' • ') : 'Source context limited';
}

function evidenceExcerpt(evidence: EvidenceObject): string | null {
  if (typeof evidence.text === 'string' && evidence.text.trim().length > 0) {
    return evidence.text.trim();
  }
  if (evidence.value != null) {
    return String(evidence.value);
  }
  if (typeof evidence.location.nearby_text === 'string' && evidence.location.nearby_text.trim().length > 0) {
    return evidence.location.nearby_text.trim();
  }
  return null;
}

function DecisionRow({
  decision,
  group,
  projectContextLabel,
  reviewable,
  feedback,
  feedbackError,
  onReviewDecision,
}: {
  decision: GeneratedDecision;
  group: DecisionDisplayGroup;
  projectContextLabel?: string;
  reviewable: boolean;
  feedback?: DecisionFeedbackState;
  feedbackError?: string;
  onReviewDecision?: (decisionId: string, input: {
    isCorrect: boolean;
    reviewErrorType?: ReviewErrorType | null;
  }) => void;
}) {
  const config = GROUP_CONFIG[group];
  const taskCount = decision.relatedTaskIds?.length ?? 0;
  const primaryAction = primaryActionLabel(decision);
  const suggestedActions = decision.suggested_actions ?? [];
  const evidenceObjects = decision.evidence_objects ?? [];
  const missingSourceContext = decision.missing_source_context ?? [];
  const actionResolvable = decision.primary_action?.resolvable === true;

  return (
    <div className="flex items-start gap-3 border-b border-white/5 py-3 last:border-0">
      <span
        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-bold uppercase ${config.color}`}
        aria-label={config.label}
      >
        {config.icon}
      </span>
      <div className="min-w-0 flex-1">
        {projectContextLabel && (
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-faint)]">
            {projectContextLabel}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-white">{decision.title}</p>
          {typeof decision.confidence === 'number' && (
            <span className="text-[10px] text-[var(--ef-text-faint)]">
              {Math.round(decision.confidence * 100)}%
            </span>
          )}
          {taskCount > 0 && (
            <span className="inline-flex items-center rounded border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-1.5 py-0.5 text-[10px] text-[var(--ef-warning)]">
              {taskCount} task{taskCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--ef-text-muted)]">
          {decisionReason(decision)}
        </p>
        {evidenceObjects.length > 0 && (
          <div className="mt-2 space-y-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
                Cited spans
              </span>
              <span className="text-[10px] text-[var(--ef-text-faint)]">
                {evidenceObjects.length} cited
              </span>
            </div>
            {evidenceObjects.slice(0, 3).map((evidence) => {
              const excerpt = evidenceExcerpt(evidence);
              return (
                <div key={evidence.id} className="rounded border border-white/6 bg-[var(--ef-background-primary)] px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-[var(--ef-border-white-10)] bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--ef-text-secondary)]">
                      {evidenceLocationLabel(evidence)}
                    </span>
                    <span className="text-[10px] text-[var(--ef-text-faint)]">
                      {Math.round(evidence.confidence * 100)}%
                    </span>
                    {evidence.weak && (
                      <span className="rounded border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-1.5 py-0.5 text-[10px] text-[var(--ef-warning-soft)]">
                        weak signal
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] font-medium text-[var(--ef-text-primary)]">
                    {evidence.description}
                  </p>
                  {excerpt && (
                    <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                      {excerpt}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {(decision.source_refs ?? []).length > 0 && (
          <div className="mt-2 rounded border border-white/6 bg-[var(--ef-background-primary)] px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
              Evidence ids
            </p>
            <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-[var(--ef-text-faint)]">
              {(decision.source_refs ?? []).slice(0, 8).join(' · ')}
              {(decision.source_refs ?? []).length > 8 ? ' · …' : ''}
            </p>
          </div>
        )}
        {missingSourceContext.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
              Missing source context
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {missingSourceContext.map((item) => (
                <span
                  key={item}
                  className="rounded border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] text-[var(--ef-warning-soft)]"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}
        {primaryAction && (
          <div className="mt-2 rounded-lg border border-[var(--ef-purple-primary-a20)] bg-[var(--ef-purple-primary-a08)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-purple-glow)]">
                Primary action
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${actionResolvable ? 'bg-[var(--ef-success-bg)] text-[var(--ef-success)]' : 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]'}`}>
                {actionResolvable ? 'In product' : 'Manual step'}
              </span>
            </div>
            <p className="mt-1 text-xs font-medium text-[var(--ef-text-primary)]">{primaryAction}</p>
            {decision.primary_action?.expected_outcome && (
              <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
                {decision.primary_action.expected_outcome}
              </p>
            )}
            {suggestedActions.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {suggestedActions.map((action) => (
                  <p key={action.id} className="text-[11px] text-[var(--ef-text-secondary)]">
                    Next: {action.description}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {reviewable && onReviewDecision && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onReviewDecision(decision.id, { isCorrect: true })}
              className="rounded border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-2 py-1 text-[10px] text-[var(--ef-success)] hover:bg-[var(--ef-success-a20)]"
            >
              Correct
            </button>
            <button
              type="button"
              onClick={() => onReviewDecision(decision.id, { isCorrect: false, reviewErrorType: 'extraction_error' })}
              className="rounded border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-2 py-1 text-[10px] text-[var(--ef-critical-soft)] hover:bg-[var(--ef-critical-a20)]"
            >
              Extraction error
            </button>
            <button
              type="button"
              onClick={() => onReviewDecision(decision.id, { isCorrect: false, reviewErrorType: 'rule_error' })}
              className="rounded border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-a20)]"
            >
              Rule error
            </button>
            <button
              type="button"
              onClick={() => onReviewDecision(decision.id, { isCorrect: false, reviewErrorType: 'edge_case' })}
              className="rounded border border-[var(--ef-border-white-10)] bg-white/5 px-2 py-1 text-[10px] text-[var(--ef-text-secondary)] hover:bg-white/10"
            >
              Edge case
            </button>
            {feedback && (
              <span className={`text-[10px] ${feedback.status === 'correct' ? 'text-[var(--ef-success)]' : 'text-[var(--ef-critical-soft)]'}`}>
                {feedback.status === 'correct'
                  ? 'Marked correct'
                  : `Marked incorrect: ${reviewErrorLabel(feedback.reviewErrorType)}`}
              </span>
            )}
            {feedbackError && (
              <span className="text-[10px] text-[var(--ef-critical)]">{feedbackError}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupHeader({
  group,
  count,
}: {
  group: DecisionDisplayGroup;
  count: number;
}) {
  const config = GROUP_CONFIG[group];
  const textColor = config.color.split(' ')[0];
  return (
    <div className="flex items-center gap-1.5 px-5 pb-0.5 pt-3">
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${textColor}`}>
        {config.label}
      </span>
      <span className="text-[10px] text-[var(--ef-text-faint)]">({count})</span>
    </div>
  );
}

interface DecisionsSectionProps {
  decisions: GeneratedDecision[];
  projectContextLabel?: string;
  unavailableMessage?: string;
  reviewableDecisionIds?: string[];
  feedbackById?: Record<string, DecisionFeedbackState>;
  feedbackErrorById?: Record<string, string>;
  onReviewDecision?: (decisionId: string, input: {
    isCorrect: boolean;
    reviewErrorType?: ReviewErrorType | null;
  }) => void;
}

export function DecisionsSection({
  decisions,
  projectContextLabel,
  unavailableMessage,
  reviewableDecisionIds,
  feedbackById,
  feedbackErrorById,
  onReviewDecision,
}: DecisionsSectionProps) {
  if (unavailableMessage) {
    return (
      <div className="rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
        <div className="border-b border-white/8 px-5 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
            Decisions
          </h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm italic text-[var(--ef-warning-soft)]">
            {unavailableMessage}
          </p>
        </div>
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
        <div className="border-b border-white/8 px-5 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
            Decisions
          </h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm italic text-[var(--ef-text-muted)]">
            No issues detected. Document looks complete.
          </p>
        </div>
      </div>
    );
  }

  const sortedDecisions = [...decisions].sort(sortDecisions);
  const lowValueDecisions = sortedDecisions.filter((decision) => {
    const group = displayGroupForDecision(decision);
    return group === 'confirmed' || group === 'info';
  });
  const hiddenLowValueDecisions = lowValueDecisions.length > 3
    ? lowValueDecisions.slice(3)
    : [];
  const visibleLowValueIds = new Set(
    (lowValueDecisions.length > 3 ? lowValueDecisions.slice(0, 3) : lowValueDecisions).map(
      (decision) => decision.id,
    ),
  );
  const reviewableIds = new Set(reviewableDecisionIds ?? []);

  const groups = GROUP_ORDER
    .map((group) => ({
      group,
      items: sortedDecisions.filter((decision) => {
        if (group !== displayGroupForDecision(decision)) return false;
        if (group === 'confirmed' || group === 'info') {
          return visibleLowValueIds.has(decision.id);
        }
        return true;
      }),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <div className="rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
          Decisions
        </h3>
        <span className="ml-auto text-[10px] text-[var(--ef-text-faint)]">{decisions.length} total</span>
      </div>
      <div className="divide-y divide-white/5">
        {groups.map(({ group, items }) => (
          <div key={group}>
            <GroupHeader group={group} count={items.length} />
            <div className="px-5">
              {items.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  group={group}
                  projectContextLabel={projectContextLabel}
                  reviewable={reviewableIds.has(decision.id)}
                  feedback={feedbackById?.[decision.id]}
                  feedbackError={feedbackErrorById?.[decision.id]}
                  onReviewDecision={onReviewDecision}
                />
              ))}
            </div>
          </div>
        ))}

        {hiddenLowValueDecisions.length > 0 && (
          <details className="px-5 py-3">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-[var(--ef-text-muted)] hover:text-[var(--ef-text-secondary)]">
              Show {hiddenLowValueDecisions.length} more low-value items
            </summary>
            <div className="mt-3">
              {hiddenLowValueDecisions.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  group={displayGroupForDecision(decision)}
                  projectContextLabel={projectContextLabel}
                  reviewable={reviewableIds.has(decision.id)}
                  feedback={feedbackById?.[decision.id]}
                  feedbackError={feedbackErrorById?.[decision.id]}
                  onReviewDecision={onReviewDecision}
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

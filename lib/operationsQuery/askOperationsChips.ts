import { DECISION_OPEN_STATUSES } from '@/lib/overdue';
import { resolveProjectValidatorSummary } from '@/lib/projectOverview';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

/** NTE billed ÷ ceiling utilization above which we surface the NTE chip. */
const NTE_UTILIZATION_WARN = 0.85;

export type AskOperationsChipSeverity = 'critical' | 'warning' | 'info';

export type AskOperationsChip = {
  query: string;
  severity: AskOperationsChipSeverity;
};

export type AskOperationsPortfolioSignals = {
  hasBlockedProjects: boolean;
  hasHighRiskProjects: boolean;
  hasNteRisk: boolean;
  hasApprovalBlockers: boolean;
  hasValidatorFlags: boolean;
};

const SEVERITY_RANK: Record<AskOperationsChipSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const DEFAULT_CHIPS: AskOperationsChip[] = [
  { query: 'Which project is approaching NTE?', severity: 'warning' },
  { query: 'What needs attention today?', severity: 'warning' },
  { query: 'Which projects are blocked?', severity: 'critical' },
  { query: 'Which project has the most flags?', severity: 'warning' },
];

function attentionScore(rollup: OperationalQueueModel['project_rollups'][0]['rollup']): number {
  return (
    rollup.blocked_count * 4
    + rollup.unresolved_finding_count * 2
    + rollup.anomaly_count * 3
    + rollup.needs_review_document_count
  );
}

/**
 * Live portfolio booleans from the same operational model as Ask Operations.
 */
export function computeAskOperationsPortfolioSignals(
  model: OperationalQueueModel,
): AskOperationsPortfolioSignals {
  const rollups = model.project_rollups;

  const hasBlockedProjects =
    model.intelligence.blocked_count > 0
    || rollups.some((r) => r.rollup.status.key === 'blocked' || r.rollup.blocked_count > 0);

  const hasHighRiskProjects = model.intelligence.high_risk_count > 0;

  const hasNteRisk = rollups.some((r) => {
    const s = resolveProjectValidatorSummary(r.project);
    const nte = s.nte_amount;
    const billed = s.total_billed;
    const util =
      nte != null && nte > 0 && billed != null && Number.isFinite(billed) ? billed / nte : null;
    return util != null && util > NTE_UTILIZATION_WARN;
  });

  const hasApprovalBlockers = rollups.some((r) =>
    r.rollup.pending_actions.some(
      (a) => a.approval_status === 'blocked' || a.approval_status === 'needs_review',
    ),
  );

  const hasValidatorFlags = rollups.some((r) => r.rollup.unresolved_finding_count > 0);

  return {
    hasBlockedProjects,
    hasHighRiskProjects,
    hasNteRisk,
    hasApprovalBlockers,
    hasValidatorFlags,
  };
}

function hasCriticalOpenDecisions(model: OperationalQueueModel): boolean {
  return model.decisions.some(
    (d) => d.severity === 'critical' && DECISION_OPEN_STATUSES.includes(d.status),
  );
}

function hasAttentionPressure(
  model: OperationalQueueModel,
  signals: AskOperationsPortfolioSignals,
): boolean {
  if (hasCriticalOpenDecisions(model)) return true;
  return model.project_rollups.some((r) => {
    const full = attentionScore(r.rollup);
    if (full <= 0) return false;
    if (signals.hasBlockedProjects) {
      const withoutBlocked =
        r.rollup.unresolved_finding_count * 2
        + r.rollup.anomaly_count * 3
        + r.rollup.needs_review_document_count;
      return withoutBlocked > 0;
    }
    return true;
  });
}

function hasPendingInvoiceReview(model: OperationalQueueModel): boolean {
  return model.decisions.some(
    (d) =>
      d.project_id != null
      && (d.review_status === 'in_review' || d.review_status === 'needs_correction'),
  );
}

/**
 * Signal-aware chips (max `maxChips`), severity-ordered: critical → warning → info.
 * Falls back to static defaults when no signals fire.
 */
export function buildAskOperationsQueryChips(
  model: OperationalQueueModel | null,
  maxChips = 5,
): AskOperationsChip[] {
  if (!model) {
    return DEFAULT_CHIPS.slice(0, maxChips);
  }

  const signals = computeAskOperationsPortfolioSignals(model);

  const candidates: AskOperationsChip[] = [];

  if (signals.hasBlockedProjects) {
    candidates.push({ query: 'Which projects are blocked?', severity: 'critical' });
  }
  if (signals.hasApprovalBlockers) {
    candidates.push({ query: 'Which projects have approval blockers?', severity: 'critical' });
  }
  if (signals.hasNteRisk) {
    candidates.push({ query: 'Which projects approaching NTE?', severity: 'warning' });
  }
  if (signals.hasHighRiskProjects) {
    candidates.push({ query: 'Which projects have high risk decisions?', severity: 'warning' });
  }
  if (signals.hasValidatorFlags) {
    candidates.push({ query: 'Which projects have new flags?', severity: 'warning' });
  }
  if (hasAttentionPressure(model, signals)) {
    candidates.push({ query: 'What needs attention today?', severity: 'warning' });
  }
  if (hasPendingInvoiceReview(model)) {
    candidates.push({ query: 'Which invoices are waiting on review?', severity: 'info' });
  }

  const active = candidates.filter(
    (c, i, arr) => arr.findIndex((x) => x.query === c.query) === i,
  );

  if (active.length === 0) {
    return DEFAULT_CHIPS.slice(0, maxChips);
  }

  const sorted = [...active].sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return active.indexOf(a) - active.indexOf(b);
  });

  return sorted.slice(0, maxChips);
}

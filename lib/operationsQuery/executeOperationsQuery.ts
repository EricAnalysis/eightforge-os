import {
  logCoverageGap,
  openProjectLinks,
  openQueueRoutingAction,
  queuePrimaryNextAction,
} from '@/lib/operationsQuery/askOperationsExecutionAdapter';
import { buildAskOperationsResult, operationsMissing } from '@/lib/operationsQuery/buildResult';
import { parsePortfolioIntent } from '@/lib/operationsQuery/intent';
import type {
  AskOperationsResult,
  OperationsEvidenceRow,
  OperationsRoutingAction,
  PortfolioIntentType,
} from '@/lib/operationsQuery/types';
import { resolveProjectValidatorSummary } from '@/lib/projectOverview';
import type {
  OperationalDecisionQueueItem,
  OperationalIntelligenceSummary,
  OperationalProjectRollupItem,
  OperationalQueueModel,
} from '@/lib/server/operationalQueue';

function routesForProject(projectId: string): OperationsRoutingAction[] {
  const q = encodeURIComponent(projectId);
  return [
    { label: 'Open project', href: `/platform/projects/${projectId}` },
    { label: 'Open decision queue (this project)', href: `/platform/decisions?project=${q}` },
    { label: 'Open project decisions', href: `/platform/projects/${projectId}#project-decisions` },
    { label: 'Open project documents', href: `/platform/projects/${projectId}#project-documents` },
    { label: 'Open validator', href: `/platform/projects/${projectId}#project-validator` },
    { label: 'Open pending actions', href: `/platform/projects/${projectId}#project-actions` },
  ];
}

function rollupHref(rollups: OperationalProjectRollupItem[], projectId: string): string {
  return rollups.find((r) => r.project.id === projectId)?.href ?? `/platform/projects/${projectId}`;
}

function evidenceRow(
  rollups: OperationalProjectRollupItem[],
  p: OperationalProjectRollupItem,
  detail: string,
  sourceId: string,
): OperationsEvidenceRow {
  return {
    projectName: p.project.name,
    projectId: p.project.id,
    href: p.href,
    detail,
    sourceId,
  };
}

function formatStartDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function listBlockedProjects(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const blocked = rollups.filter(
    (r) => r.rollup.status.key === 'blocked' || r.rollup.blocked_count > 0,
  );
  if (blocked.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No projects are in blocked operational status in current rollups.',
      evidence: [],
      status: 'Verified',
      nextAction: queuePrimaryNextAction('blocked_projects'),
      confidenceLevel: 'HIGH',
      routingActions: [openQueueRoutingAction('blocked_projects')],
      projectIds: [],
      sourceIds: ['rollups:blocked:none'],
    });
  }
  const evidence = blocked.map((r) =>
    evidenceRow(
      rollups,
      r,
      `Blocked count ${r.rollup.blocked_count} · status ${r.rollup.status.label}`,
      `rollup:blocked:${r.project.id}`,
    ),
  );
  return buildAskOperationsResult({
    intentType,
    result: `${blocked.length} project(s) show blocked signals in operational rollups.`,
    evidence,
    status: 'Verified',
    nextAction: queuePrimaryNextAction('blocked_projects'),
    confidenceLevel: 'HIGH',
    routingActions: [
      openQueueRoutingAction('blocked_projects'),
      ...openProjectLinks(rollups, blocked.map((b) => b.project.id), 3),
    ],
    projectIds: blocked.map((b) => b.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function listInvoicesWaitingReview(
  decisions: OperationalDecisionQueueItem[],
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const waiting = decisions.filter(
    (d) =>
      d.project_id != null &&
      (d.review_status === 'in_review' || d.review_status === 'needs_correction'),
  );
  if (waiting.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No decisions are waiting on project review in the current operational queue.',
      evidence: [],
      status: 'Verified',
      nextAction: queuePrimaryNextAction('pending_invoices'),
      confidenceLevel: 'HIGH',
      routingActions: [openQueueRoutingAction('pending_invoices')],
      projectIds: [],
      sourceIds: ['decisions:review_wait:none'],
    });
  }
  const byProject = new Map<
    string,
    { count: number; label: string; sampleId: string }
  >();
  for (const d of waiting) {
    const pid = d.project_id as string;
    const cur = byProject.get(pid) ?? {
      count: 0,
      label: d.project_label ?? d.project_code ?? pid,
      sampleId: d.id,
    };
    cur.count += 1;
    byProject.set(pid, cur);
  }
  const evidence: OperationsEvidenceRow[] = [...byProject.entries()].map(([projectId, v]) => ({
    projectName: v.label,
    projectId,
    href: rollupHref(rollups, projectId),
    detail: `${v.count} decision(s) in review or needs correction (operational queue).`,
    sourceId: `decisions:review_wait:${projectId}`,
  }));
  return buildAskOperationsResult({
    intentType,
    result: `${waiting.length} queue decision(s) across ${byProject.size} project(s) are waiting on review.`,
    evidence,
    status: 'Verified',
    nextAction: queuePrimaryNextAction('pending_invoices'),
    confidenceLevel: 'HIGH',
    routingActions: [
      openQueueRoutingAction('pending_invoices'),
      ...openProjectLinks(rollups, [...byProject.keys()], 3),
    ],
    projectIds: [...byProject.keys()],
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function listApprovalBlockers(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const affected = rollups
    .map((r) => {
      const n = r.rollup.pending_actions.filter(
        (a) => a.approval_status === 'blocked' || a.approval_status === 'needs_review',
      ).length;
      return { r, n };
    })
    .filter((x) => x.n > 0);

  if (affected.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No approval-gate blockers are present on project rollups.',
      evidence: [],
      status: 'Verified',
      nextAction: queuePrimaryNextAction('approval_blockers'),
      confidenceLevel: 'HIGH',
      routingActions: [openQueueRoutingAction('approval_blockers')],
      projectIds: [],
      sourceIds: ['rollup:approval_block:none'],
    });
  }

  const evidence = affected.map(({ r, n }) =>
    evidenceRow(
      rollups,
      r,
      `${n} pending invoice / approval gate action(s) (blocked or needs review).`,
      `rollup:approval_block:${r.project.id}`,
    ),
  );
  return buildAskOperationsResult({
    intentType,
    result: `${affected.length} project(s) carry approval-gate pressure in rollup pending actions.`,
    evidence,
    status: 'Verified',
    nextAction: queuePrimaryNextAction('approval_blockers'),
    confidenceLevel: 'HIGH',
    routingActions: [
      openQueueRoutingAction('approval_blockers'),
      ...openProjectLinks(
        rollups,
        affected.map((x) => x.r.project.id),
        3,
      ),
    ],
    projectIds: affected.map((x) => x.r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function listHighRiskPortfolio(
  intelligence: OperationalIntelligenceSummary,
  intentType: PortfolioIntentType,
): AskOperationsResult {
  if (intelligence.high_risk_count === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No high-severity items are currently counted in portfolio intelligence.',
      evidence: [],
      status: 'Verified',
      nextAction: queuePrimaryNextAction('high_risk_projects'),
      confidenceLevel: 'HIGH',
      routingActions: [openQueueRoutingAction('high_risk_projects')],
      projectIds: [],
      sourceIds: ['intel:high_risk:none'],
    });
  }
  return buildAskOperationsResult({
    intentType,
    result: `Portfolio intelligence shows ${intelligence.high_risk_count} high-severity queue item(s).`,
    evidence: [],
    status: 'Derived',
    nextAction: queuePrimaryNextAction('high_risk_projects'),
    confidenceLevel: 'HIGH',
    routingActions: [openQueueRoutingAction('high_risk_projects')],
    projectIds: [],
    sourceIds: ['intel:high_risk:count'],
  });
}

function listOpenValidatorFindings(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const flagged = rollups.filter((r) => r.rollup.unresolved_finding_count > 0);
  if (flagged.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No projects show open validator-style finding counts on rollups.',
      evidence: [],
      status: 'Verified',
      nextAction: null,
      confidenceLevel: 'HIGH',
      routingActions: [{ label: 'Open projects', href: '/platform/projects' }],
      projectIds: [],
      sourceIds: ['rollup:flags:none'],
    });
  }
  const evidence = flagged.map((r) =>
    evidenceRow(
      rollups,
      r,
      `Unresolved finding count: ${r.rollup.unresolved_finding_count} (rollup).`,
      `rollup:flags_open:${r.project.id}`,
    ),
  );
  return buildAskOperationsResult({
    intentType,
    result: `${flagged.length} project(s) carry unresolved validator-style findings in rollups.`,
    evidence,
    status: 'Derived',
    nextAction: 'Open Validator on each project to triage findings.',
    confidenceLevel: 'HIGH',
    routingActions: [
      ...openProjectLinks(
        rollups,
        flagged.map((r) => r.project.id),
        3,
      ),
      { label: 'Open projects', href: '/platform/projects' },
    ],
    projectIds: flagged.map((r) => r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function listProjectsNeedingReview(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const needs = rollups.filter((r) => r.rollup.needs_review_document_count > 0);
  if (needs.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No projects show documents needing review in current rollups.',
      evidence: [],
      status: 'Verified',
      nextAction: queuePrimaryNextAction('projects_needing_review'),
      confidenceLevel: 'HIGH',
      routingActions: [openQueueRoutingAction('projects_needing_review')],
      projectIds: [],
      sourceIds: ['rollup:needs_review:none'],
    });
  }

  const evidence = needs.map((r) =>
    evidenceRow(
      rollups,
      r,
      `${r.rollup.needs_review_document_count} document(s) still need operator review (rollup).`,
      `rollup:needs_review:${r.project.id}`,
    ),
  );
  return buildAskOperationsResult({
    intentType,
    result: `${needs.length} project(s) have documents in needs-review state.`,
    evidence,
    status: 'Verified',
    nextAction: queuePrimaryNextAction('projects_needing_review'),
    confidenceLevel: 'HIGH',
    routingActions: [
      openQueueRoutingAction('projects_needing_review'),
      ...openProjectLinks(
        rollups,
        needs.map((r) => r.project.id),
        3,
      ),
    ],
    projectIds: needs.map((r) => r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function rankNteApproach(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const scored = rollups
    .map((r) => {
      const s = resolveProjectValidatorSummary(r.project);
      const nte = s.nte_amount;
      const billed = s.total_billed;
      const util =
        nte != null && nte > 0 && billed != null && Number.isFinite(billed)
          ? billed / nte
          : null;
      return { r, util, nte, billed };
    })
    .filter((x) => x.util != null)
    .sort((a, b) => (b.util ?? 0) - (a.util ?? 0))
    .slice(0, 5);

  if (scored.length === 0) return operationsMissing(intentType);

  const evidence = scored.map(({ r, util, nte, billed }) =>
    evidenceRow(
      rollups,
      r,
      `NTE utilization ~${((util ?? 0) * 100).toFixed(1)}% (billed ${billed ?? '—'} vs NTE ${nte ?? '—'} from validation summary).`,
      `rank:nte:${r.project.id}`,
    ),
  );
  const top = scored[0]!.r;
  return buildAskOperationsResult({
    intentType,
    result: `Highest NTE utilization: ${top.project.name} (~${((scored[0]!.util ?? 0) * 100).toFixed(1)}% of recorded NTE).`,
    evidence,
    status: 'Ranked',
    nextAction: queuePrimaryNextAction('approaching_nte'),
    confidenceLevel: 'HIGH',
    routingActions: [
      openQueueRoutingAction('approaching_nte'),
      ...openProjectLinks(
        rollups,
        scored.map((s) => s.r.project.id),
        3,
      ),
    ],
    projectIds: scored.map((s) => s.r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function rankHighestContract(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const ranked = rollups
    .map((r) => {
      const s = resolveProjectValidatorSummary(r.project);
      return { r, nte: s.nte_amount };
    })
    .filter((x) => x.nte != null && x.nte > 0)
    .sort((a, b) => (b.nte ?? 0) - (a.nte ?? 0))
    .slice(0, 5);

  if (ranked.length === 0) return operationsMissing(intentType);

  const evidence = ranked.map(({ r, nte }) =>
    evidenceRow(
      rollups,
      r,
      `Recorded NTE / ceiling from validation summary: ${nte?.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
      `rank:contract:${r.project.id}`,
    ),
  );
  const top = ranked[0]!.r;
  return buildAskOperationsResult({
    intentType,
    result: `Largest recorded contract ceiling (NTE): ${top.project.name}.`,
    evidence,
    status: 'Ranked',
    nextAction: 'Open the project overview to reconcile ceiling against governing documents.',
    confidenceLevel: 'HIGH',
    routingActions: routesForProject(top.project.id),
    projectIds: ranked.map((x) => x.r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function rankMostFlags(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const ranked = [...rollups]
    .sort((a, b) => b.rollup.unresolved_finding_count - a.rollup.unresolved_finding_count)
    .slice(0, 5)
    .filter((r) => r.rollup.unresolved_finding_count > 0);

  if (ranked.length === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No open validator-style finding counts are recorded on project rollups.',
      evidence: [],
      status: 'Derived',
      nextAction: null,
      confidenceLevel: 'MEDIUM',
      routingActions: [{ label: 'View projects', href: '/platform/projects' }],
      projectIds: [],
      sourceIds: ['rank:flags:none'],
    });
  }

  const evidence = ranked.map((r) =>
    evidenceRow(
      rollups,
      r,
      `Unresolved finding count: ${r.rollup.unresolved_finding_count} (rollup).`,
      `rank:flags:${r.project.id}`,
    ),
  );
  const top = ranked[0]!;
  return buildAskOperationsResult({
    intentType,
    result: `Most open findings (rollup): ${top.project.name} (${top.rollup.unresolved_finding_count}).`,
    evidence,
    status: 'Ranked',
    nextAction: 'Open Validator on that project to triage findings.',
    confidenceLevel: 'HIGH',
    routingActions: routesForProject(top.project.id),
    projectIds: ranked.map((r) => r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function rankUninvoicedExposure(
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const scored = rollups
    .map((r) => {
      const s = resolveProjectValidatorSummary(r.project);
      const nte = s.nte_amount;
      const billed = s.total_billed;
      const remaining =
        nte != null && billed != null && nte >= billed ? nte - billed : null;
      return { r, remaining, atRisk: s.total_at_risk };
    })
    .filter((x) => x.remaining != null && x.remaining > 0)
    .sort((a, b) => (b.remaining ?? 0) - (a.remaining ?? 0))
    .slice(0, 5);

  if (scored.length > 0) {
    const evidence = scored.map(({ r, remaining }) =>
      evidenceRow(
        rollups,
        r,
        `Remaining capacity vs billed (NTE − billed): ${(remaining ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
        `rank:uninvoiced:${r.project.id}`,
      ),
    );
    const top = scored[0]!.r;
    return buildAskOperationsResult({
      intentType,
      result: `Highest remaining capacity before NTE (structured): ${top.project.name}.`,
      evidence,
      status: 'Ranked',
      nextAction: 'Confirm uninvoiced exposure against invoices in the project workspace.',
      confidenceLevel: 'HIGH',
      routingActions: routesForProject(top.project.id),
      projectIds: scored.map((s) => s.r.project.id),
      sourceIds: evidence.map((e) => e.sourceId),
    });
  }

  const fallback = rollups
    .map((r) => {
      const s = resolveProjectValidatorSummary(r.project);
      return { r, atRisk: s.total_at_risk };
    })
    .filter((x) => x.atRisk != null && x.atRisk > 0)
    .sort((a, b) => (b.atRisk ?? 0) - (a.atRisk ?? 0))
    .slice(0, 5);

  if (fallback.length === 0) return operationsMissing(intentType);

  const evidence = fallback.map(({ r, atRisk }) =>
    evidenceRow(
      rollups,
      r,
      `At-risk amount (validation summary): ${(atRisk ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}.`,
      `rank:exposure_proxy:${r.project.id}`,
    ),
  );
  const top = fallback[0]!.r;
  return buildAskOperationsResult({
    intentType,
    result: `Uninvoiced exposure is not structured portfolio-wide; ranking by at-risk totals instead: ${top.project.name}.`,
    evidence,
    status: 'Derived',
    nextAction: 'Validate exposure figures in each project’s Validator and invoice summaries.',
    confidenceLevel: 'MEDIUM',
    routingActions: routesForProject(top.project.id),
    projectIds: fallback.map((f) => f.r.project.id),
    sourceIds: evidence.map((e) => e.sourceId),
  });
}

function signalImmediateAttention(
  rollups: OperationalProjectRollupItem[],
  model: OperationalQueueModel,
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const scored = rollups
    .map((r) => {
      const score =
        r.rollup.blocked_count * 4 +
        r.rollup.unresolved_finding_count * 2 +
        r.rollup.anomaly_count * 3 +
        r.rollup.needs_review_document_count;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const criticalDecisions = model.decisions.filter(
    (d) => d.severity === 'critical' && (d.status === 'open' || d.status === 'in_review'),
  ).length;

  if (scored.length === 0 && criticalDecisions === 0) {
    return buildAskOperationsResult({
      intentType,
      result: 'No high-signal operational pressure is present in current rollups or critical queue rows.',
      evidence: [],
      status: 'Signal',
      nextAction: queuePrimaryNextAction('high_risk_projects'),
      confidenceLevel: 'MEDIUM',
      routingActions: [
        openQueueRoutingAction('high_risk_projects'),
        { label: 'Open decision queue', href: '/platform/decisions' },
      ],
      projectIds: [],
      sourceIds: ['signal:attention:none'],
    });
  }

  const evidence = scored.map(({ r, score }) =>
    evidenceRow(
      rollups,
      r,
      `Attention score ${score} (blocked ${r.rollup.blocked_count}, findings ${r.rollup.unresolved_finding_count}, anomalies ${r.rollup.anomaly_count}, docs needing review ${r.rollup.needs_review_document_count}).`,
      `signal:attention:${r.project.id}`,
    ),
  );

  let result = `Top operational pressure: ${scored[0]?.r.project.name ?? '—'}.`;
  if (criticalDecisions > 0) {
    result = `${criticalDecisions} critical decision(s) in queue; ${result}`;
  }

  const secondaryProjects = openProjectLinks(
    rollups,
    scored.map((s) => s.r.project.id),
    3,
  );
  return buildAskOperationsResult({
    intentType,
    result,
    evidence,
    status: 'Signal',
    nextAction: queuePrimaryNextAction('high_risk_projects'),
    confidenceLevel: 'MEDIUM',
    routingActions: [
      openQueueRoutingAction('high_risk_projects'),
      ...secondaryProjects,
      ...(criticalDecisions > 0
        ? [{ label: 'Open decision queue', href: '/platform/decisions' } as const]
        : []),
    ],
    projectIds: scored.map((s) => s.r.project.id),
    sourceIds: [...evidence.map((e) => e.sourceId), `queue:critical:${criticalDecisions}`],
  });
}

function matchProjectNameToken(
  needle: string,
  rollups: OperationalProjectRollupItem[],
): OperationalProjectRollupItem | null {
  const n = needle.trim().toLowerCase();
  if (n.length < 2) return null;
  const exact = rollups.find((r) => r.project.name.toLowerCase() === n);
  if (exact) return exact;
  const contains = rollups.find(
    (r) =>
      r.project.name.toLowerCase().includes(n)
      || (r.project.code?.toLowerCase().includes(n) ?? false),
  );
  return contains ?? null;
}

function factProjectStart(
  rawInput: string,
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const m = rawInput.match(/when did\s+(.+?)\s+(?:start|begin)\b/i);
  const needle = m?.[1]?.replace(/[?.]$/g, '').trim() ?? '';
  const hit = needle ? matchProjectNameToken(needle, rollups) : null;
  if (!hit) return operationsMissing(intentType);

  const dateLabel = formatStartDate(hit.project.created_at);
  return buildAskOperationsResult({
    intentType,
    result: `${hit.project.name} started (project record): ${dateLabel}.`,
    evidence: [
      evidenceRow(
        rollups,
        hit,
        `created_at: ${hit.project.created_at}`,
        `fact:start:${hit.project.id}`,
      ),
    ],
    status: 'Verified',
    nextAction: 'Open the project overview to confirm dates against the contract record.',
    confidenceLevel: 'HIGH',
    routingActions: routesForProject(hit.project.id),
    projectIds: [hit.project.id],
    sourceIds: [`fact:start:${hit.project.id}`],
  });
}

function routeFromEmailHint(
  rawInput: string,
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const quoted =
    rawInput.match(/"([^"]{2,120})"/)?.[1]
    ?? rawInput.match(/'([^']{2,120})'/)?.[1]
    ?? null;
  const afterFor = rawInput.match(/\bfor\s+(.+)$/i)?.[1]?.replace(/[?.]$/g, '').trim() ?? '';
  const needle = quoted?.trim() || afterFor;

  if (!needle || needle.length < 2) return operationsMissing(intentType);

  const hit = matchProjectNameToken(needle, rollups);
  if (!hit) return operationsMissing(intentType);

  return buildAskOperationsResult({
    intentType,
    result: `Route to project: ${hit.project.name} (matched from query text).`,
    evidence: [
      evidenceRow(
        rollups,
        hit,
        `Match key: "${needle.slice(0, 80)}${needle.length > 80 ? '…' : ''}"`,
        `route:email:${hit.project.id}`,
      ),
    ],
    status: 'Derived',
    nextAction: 'Open the project overview and confirm against the email subject or body.',
    confidenceLevel: 'LOW',
    routingActions: routesForProject(hit.project.id),
    projectIds: [hit.project.id],
    sourceIds: [`route:email:${hit.project.id}`],
  });
}

function searchProjectName(
  rawInput: string,
  rollups: OperationalProjectRollupItem[],
  intentType: PortfolioIntentType,
): AskOperationsResult {
  const tokens = rawInput
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  for (const t of tokens) {
    const hit = matchProjectNameToken(t, rollups);
    if (hit) {
      return buildAskOperationsResult({
        intentType,
        result: `Matched project name token “${t}”: ${hit.project.name}.`,
        evidence: [
          evidenceRow(
            rollups,
            hit,
            `Token match on project name or code.`,
            `search:name:${hit.project.id}`,
          ),
        ],
        status: 'Derived',
        nextAction: 'Open the project to continue triage.',
        confidenceLevel: 'LOW',
        routingActions: routesForProject(hit.project.id),
        projectIds: [hit.project.id],
        sourceIds: [`search:name:${hit.project.id}`],
      });
    }
  }

  return operationsMissing(intentType);
}

function logAskOperationsTrace(query: string, result: AskOperationsResult) {
  console.info('[AskOperations]', {
    queryPreview: query.slice(0, 240),
    intentType: result.trace.intentType,
    confidenceLevel: result.trace.confidenceLevel,
    status: result.trace.status,
    projectIds: result.trace.projectIds,
    sourceIds: result.trace.sourceIds,
    routingAttached: result.trace.routingAttached,
  });
}

export function executeOperationsQuery(
  input: string,
  model: OperationalQueueModel | null,
): AskOperationsResult {
  const trimmed = input.trim();

  const result = ((): AskOperationsResult => {
    if (!model) {
      return operationsMissing('PORTFOLIO_SEARCH');
    }

    const intent = parsePortfolioIntent(input);
    if (!intent || !trimmed) {
      return operationsMissing('PORTFOLIO_SEARCH');
    }

    const rollups = model.project_rollups;
    const decisions = model.decisions;

    switch (intent.type) {
      case 'PORTFOLIO_LIST': {
        const n = intent.normalized;
        if (/\bcontract signatures\b/.test(n)) {
          return operationsMissing('PORTFOLIO_LIST');
        }
        if (/\bhigh risk\b/.test(n) && /\b(decisions?|projects?|queue|items?)\b/.test(n)) {
          return listHighRiskPortfolio(model.intelligence, intent.type);
        }
        if (/\binvoices?\b/.test(n) && /\b(waiting|pending)\b/.test(n) && /\breview\b/.test(n)) {
          return listInvoicesWaitingReview(decisions, rollups, intent.type);
        }
        if (
          /\b(approval|payment)\b[\s\S]{0,60}\b(blocker|blockers|blocked|gate|hold)\b/.test(n)
          || /\b(blocker|blockers)\b[\s\S]{0,40}\bapproval\b/.test(n)
        ) {
          return listApprovalBlockers(rollups, intent.type);
        }
        if (
          /\bprojects?\b[\s\S]{0,70}\b(need|needs|needing|requir(?:e|ing))\b[\s\S]{0,40}\breview\b/.test(n)
          || /\b(which|what) projects\b[\s\S]{0,60}\breview\b/.test(n)
        ) {
          return listProjectsNeedingReview(rollups, intent.type);
        }
        return listBlockedProjects(rollups, intent.type);
      }

      case 'PORTFOLIO_RANK': {
        const rn = intent.normalized;
        if (
          /\bnew flags\b/.test(rn)
          || (/\b(which|what) projects\b/.test(rn) && /\b(flags|findings)\b/.test(rn) && !/\bmost\b/.test(rn))
        ) {
          return listOpenValidatorFindings(rollups, intent.type);
        }
        if (/\bapproaching expiration\b/.test(intent.normalized) || /\bexpire\b/.test(intent.normalized)) {
          return operationsMissing('PORTFOLIO_RANK');
        }
        if (/\buninvoiced\b/.test(intent.normalized) || /\buninvoiced exposure\b/.test(intent.normalized)) {
          return rankUninvoicedExposure(rollups, intent.type);
        }
        if (
          /\bnte\b/.test(intent.normalized)
          || /not to exceed/.test(intent.normalized)
          || /\b(approaching|nearest|closest|usage|utilization)\b/.test(intent.normalized)
        ) {
          if (/\b(highest|largest|biggest|max)\b/.test(intent.normalized) && !/\bapproach\b/.test(intent.normalized)) {
            return rankHighestContract(rollups, intent.type);
          }
          return rankNteApproach(rollups, intent.type);
        }
        if (/\b(highest|largest|biggest|max)\b/.test(intent.normalized)) {
          return rankHighestContract(rollups, intent.type);
        }
        if (/\b(flag|flags|finding|findings|ticket)\b/.test(intent.normalized)) {
          return rankMostFlags(rollups, intent.type);
        }
        return operationsMissing('PORTFOLIO_RANK');
      }

      case 'PORTFOLIO_SIGNAL':
        return signalImmediateAttention(rollups, model, intent.type);

      case 'PORTFOLIO_ROUTE':
        return routeFromEmailHint(input, rollups, intent.type);

      case 'PORTFOLIO_FACT':
        return factProjectStart(input, rollups, intent.type);

      case 'PORTFOLIO_SEARCH':
        return searchProjectName(input, rollups, intent.type);

      default:
        return operationsMissing('PORTFOLIO_SEARCH');
    }
  })();

  if (result.confidenceLevel === 'NONE') {
    logCoverageGap({ query: trimmed, intentType: result.trace.intentType });
  }

  logAskOperationsTrace(trimmed, result);
  return result;
}

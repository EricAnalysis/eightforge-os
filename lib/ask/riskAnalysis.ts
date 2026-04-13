import type {
  ClassifiedQuestion,
  DecisionRecord,
  RiskAssessment,
  ValidatorFinding,
} from '@/lib/ask/types';

type RankedIssue = {
  issue: string;
  severity: string;
  blocked: boolean;
  exposure: number | null;
  ageDays: number;
  reasoning: string;
  score: number;
};

const RISK_PATTERNS = [
  'what should i fix first',
  'fix first',
  'biggest issue',
  'highest priority',
  'top priority',
  'priority issue',
];

const CLOSED_DECISION_STATUSES = new Set([
  'closed',
  'complete',
  'completed',
  'done',
  'dismissed',
  'resolved',
]);

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9$%/. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function questionText(question: ClassifiedQuestion): string {
  return normalizeText([question.originalQuestion, ...question.keywords].join(' '));
}

function severityWeight(severity: string): number {
  switch (normalizeText(severity)) {
    case 'critical':
      return 300;
    case 'warning':
      return 200;
    case 'info':
      return 100;
    default:
      return 140;
  }
}

function blockedWeight(blocked: boolean): number {
  return blocked ? 80 : 0;
}

function exposureWeight(exposure: number | null): number {
  if (exposure == null || exposure <= 0) return 0;
  if (exposure >= 1_000_000) return 40;
  if (exposure >= 100_000) return 30;
  if (exposure >= 10_000) return 20;
  return 10;
}

function ageWeight(ageDays: number): number {
  return Math.min(Math.max(ageDays, 0), 30);
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') return null;

  const parsed = Number(value.replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExposureFromText(text: string | null | undefined): number | null {
  if (!text) return null;

  const matches = Array.from(text.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g))
    .map((match) => parseNumeric(match[0]))
    .filter((value): value is number => value != null);

  if (matches.length === 0) return null;

  return Math.max(...matches);
}

function parseExposureFromDecision(decision: DecisionRecord): number | null {
  const details = decision.details;
  if (!details) {
    return parseExposureFromText(`${decision.title} ${decision.summary ?? ''}`);
  }

  const candidateKeys = [
    'financial_impact',
    'exposure',
    'billed_amount',
    'invoice_total',
    'total_amount',
    'current_amount_due',
    'approved_amount',
    'recommended_amount',
  ];

  for (const key of candidateKeys) {
    const numeric = parseNumeric(details[key]);
    if (numeric != null) {
      return numeric;
    }
  }

  return parseExposureFromText(
    [decision.title, decision.summary ?? '', JSON.stringify(details)]
      .filter(Boolean)
      .join(' '),
  );
}

function daysOld(timestamp: string | null | undefined, now: Date): number {
  if (!timestamp) return 0;

  const parsed = new Date(timestamp);
  const ms = now.getTime() - parsed.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;

  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatAge(ageDays: number): string {
  if (ageDays <= 0) return 'recorded today';
  if (ageDays === 1) return 'open for 1 day';
  return `open for ${ageDays} days`;
}

function buildReasoning(params: {
  severity: string;
  blocked: boolean;
  exposure: number | null;
  ageDays: number;
  origin: 'validator' | 'decision';
}): string {
  const parts = [
    `${params.severity} ${params.origin}`,
    params.blocked ? 'blocking progress' : null,
    params.exposure != null ? `exposure ${formatCurrency(params.exposure)}` : null,
    formatAge(params.ageDays),
  ].filter((value): value is string => Boolean(value));

  return parts.join(', ');
}

function decisionBlocksProject(decision: DecisionRecord): boolean {
  if (normalizeText(decision.status) === 'blocked') {
    return true;
  }

  const details = decision.details;
  if (!details) return false;

  return Boolean(
    details.blocks_project === true
    || details.blocked === true
    || details.is_blocking === true,
  );
}

function actionableDecisions(decisions: DecisionRecord[]): DecisionRecord[] {
  return decisions.filter((decision) => {
    const normalizedStatus = normalizeText(decision.status);
    return normalizedStatus.length > 0 && !CLOSED_DECISION_STATUSES.has(normalizedStatus);
  });
}

export function isRiskAnalysisQuestion(question: ClassifiedQuestion): boolean {
  return includesAny(questionText(question), RISK_PATTERNS);
}

export function rankProjectIssues(params: {
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
  now?: Date;
}): RiskAssessment[] {
  const now = params.now ?? new Date();
  const rankedIssues: RankedIssue[] = [];

  for (const finding of params.findings) {
    const exposure = parseExposureFromText(
      [finding.description, finding.blockedReason ?? '', finding.snippet ?? '']
        .filter(Boolean)
        .join(' '),
    );
    const ageDays = daysOld(finding.timestamp ?? finding.lastRun, now);
    const severity = normalizeText(finding.severity) || 'warning';
    const blocked = finding.blocksProject;

    rankedIssues.push({
      issue: finding.description,
      severity,
      blocked,
      exposure,
      ageDays,
      reasoning: buildReasoning({
        severity,
        blocked,
        exposure,
        ageDays,
        origin: 'validator',
      }),
      score:
        severityWeight(severity)
        + blockedWeight(blocked)
        + exposureWeight(exposure)
        + ageWeight(ageDays),
    });
  }

  for (const decision of actionableDecisions(params.decisions)) {
    const exposure = parseExposureFromDecision(decision);
    const ageDays = daysOld(decision.detectedAt ?? decision.createdAt, now);
    const severity = normalizeText(decision.severity) || 'warning';
    const blocked = decisionBlocksProject(decision);

    rankedIssues.push({
      issue: decision.title,
      severity,
      blocked,
      exposure,
      ageDays,
      reasoning: buildReasoning({
        severity,
        blocked,
        exposure,
        ageDays,
        origin: 'decision',
      }),
      score:
        severityWeight(severity)
        + blockedWeight(blocked)
        + exposureWeight(exposure)
        + ageWeight(ageDays),
    });
  }

  const deduped = new Map<string, RankedIssue>();

  for (const issue of rankedIssues) {
    const key = normalizeText(issue.issue);
    const current = deduped.get(key);
    if (!current || issue.score > current.score) {
      deduped.set(key, issue);
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;

      const severityDelta = severityWeight(right.severity) - severityWeight(left.severity);
      if (severityDelta !== 0) return severityDelta;

      return right.ageDays - left.ageDays;
    })
    .slice(0, 3)
    .map((issue, index) => ({
      issue: issue.issue,
      severity: issue.severity,
      rank: index + 1,
      reasoning: issue.reasoning,
    }));
}

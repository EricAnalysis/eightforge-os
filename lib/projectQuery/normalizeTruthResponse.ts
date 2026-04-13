import { buildProjectQueryResult } from '@/lib/projectQuery/buildResult';
import type {
  EvidenceAnchor,
  ProjectQueryConfidenceLevel,
  ProjectQueryResult,
  ProjectQueryStatus,
  ProjectQueryType,
} from '@/lib/projectQuery/types';
import type { TruthResultPayload } from '@/lib/truthQuery';

function mapTruthValidationToStatus(validationState: string): ProjectQueryStatus {
  const s = validationState.trim();
  if (s === 'Verified') return 'Verified';
  if (s === 'Requires Verification') return 'Signal';
  if (s === 'Needs Review') return 'Signal';
  if (s === 'Missing') return 'Missing';
  if (s === 'Unknown') return 'Missing';
  return 'Missing';
}

function truthConfidenceLevel(status: ProjectQueryStatus): ProjectQueryConfidenceLevel {
  if (status === 'Verified') return 'HIGH';
  if (status === 'Signal') return 'MEDIUM';
  if (status === 'Missing') return 'NONE';
  return 'LOW';
}

function buildTruthEvidenceAnchors(projectId: string, truth: TruthResultPayload): EvidenceAnchor[] {
  const anchors: EvidenceAnchor[] = [];
  const fallbackHref = `/platform/projects/${encodeURIComponent(projectId)}#project-overview`;

  if (truth.sourceHref) {
    anchors.push({
      label: truth.queryLabel,
      href: truth.sourceHref,
      locator: null,
      snippet: truth.gateImpact || truth.value || 'Validator record',
      sourceId: `truth:${truth.queryType}:${truth.value || '∅'}`,
      sourceKind: 'truth',
    });
  }
  for (const item of truth.evidence ?? []) {
    const ruleId = extractRuleIdFromDetail(item.detail);
    anchors.push({
      label: item.label,
      href: truth.sourceHref ?? fallbackHref,
      locator: item.kind,
      snippet: item.detail,
      sourceId: `truth_evidence:${item.kind}:${item.label}`,
      sourceKind: item.kind,
      ruleId,
    });
  }
  if (anchors.length === 0) {
    anchors.push({
      label: truth.queryLabel,
      href: fallbackHref,
      locator: truth.queryType,
      snippet: [truth.value, truth.gateImpact].filter(Boolean).join(' · ') || 'Truth query result',
      sourceId: `truth:${truth.queryType}:${truth.value || '∅'}`,
      sourceKind: 'truth',
    });
  }
  return anchors;
}

function extractRuleIdFromDetail(detail: string): string | null {
  const m = detail.match(/\brule(?:_id| id)?\s*[:#]\s*([^\s·,]+)/i);
  return m?.[1]?.trim() ?? null;
}

/**
 * Maps `/api/truth/query` JSON to the fixed ProjectQueryResult contract (client or server).
 */
export function truthPayloadToProjectResult(
  projectId: string,
  intentType: ProjectQueryType,
  payload: TruthResultPayload,
): ProjectQueryResult {
  const status = mapTruthValidationToStatus(payload.validationState);
  const evidence = buildTruthEvidenceAnchors(projectId, payload);

  const primary = [payload.queryLabel, payload.value].filter(Boolean).join(': ');
  const result =
    primary && payload.approvalLabel && payload.gateImpact
      ? `${primary}. ${payload.approvalLabel}. ${payload.gateImpact}`
      : primary || payload.gateImpact || payload.value || 'No structured evidence found in project documents.';

  return buildProjectQueryResult({
    projectId,
    type: intentType,
    status,
    result,
    evidence,
    nextAction: payload.nextAction?.trim() ? payload.nextAction : null,
    confidenceLevel: truthConfidenceLevel(status),
    sourceIds: evidence.map((e) => e.sourceId).filter(Boolean) as string[],
    precedenceApplied: true,
  });
}

import type {
  EvidenceAnchor,
  ProjectQueryConfidenceLevel,
  ProjectQueryResult,
  ProjectQueryStatus,
  ProjectQueryType,
} from '@/lib/projectQuery/types';

export function buildProjectQueryResult(args: {
  projectId: string;
  type: ProjectQueryType;
  status: ProjectQueryStatus;
  result: string;
  evidence: EvidenceAnchor[];
  nextAction: string | null;
  confidenceLevel: ProjectQueryConfidenceLevel;
  sourceIds?: string[];
  precedenceApplied?: boolean;
}): ProjectQueryResult {
  return {
    type: args.type,
    status: args.status,
    result: args.result,
    evidence: args.evidence,
    nextAction: args.nextAction,
    confidenceLevel: args.confidenceLevel,
    trace: {
      projectId: args.projectId,
      detectedType: args.type,
      status: args.status,
      confidenceLevel: args.confidenceLevel,
      sourceIds:
        args.sourceIds ?? (args.evidence.map((e) => e.sourceId).filter(Boolean) as string[]),
      precedenceApplied: Boolean(args.precedenceApplied),
    },
  };
}

export function projectQueryMissing(
  projectId: string,
  type: ProjectQueryType,
): ProjectQueryResult {
  return buildProjectQueryResult({
    projectId,
    type,
    status: 'Missing',
    result: 'No structured evidence found in project documents.',
    evidence: [],
    nextAction:
      'Try a fact, verify, list, or search query tied to a known document, invoice, rate, term, or blocker.',
    confidenceLevel: 'NONE',
    sourceIds: [],
    precedenceApplied: false,
  });
}

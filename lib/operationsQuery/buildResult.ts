import type {
  AskOperationsResult,
  AskOperationsTrace,
  OperationsConfidenceLevel,
  OperationsEvidenceRow,
  OperationsResultStatus,
  OperationsRoutingAction,
  PortfolioIntentType,
} from '@/lib/operationsQuery/types';

export function buildAskOperationsResult(args: {
  intentType: PortfolioIntentType;
  result: string;
  evidence: OperationsEvidenceRow[];
  status: OperationsResultStatus;
  nextAction: string | null;
  confidenceLevel: OperationsConfidenceLevel;
  routingActions: OperationsRoutingAction[];
  projectIds: string[];
  sourceIds: string[];
}): AskOperationsResult {
  const routingAttached = args.routingActions.length > 0;
  const trace: AskOperationsTrace = {
    intentType: args.intentType,
    status: args.status,
    confidenceLevel: args.confidenceLevel,
    projectIds: args.projectIds,
    sourceIds: args.sourceIds,
    routingAttached,
  };
  return {
    intentType: args.intentType,
    result: args.result,
    evidence: args.evidence,
    status: args.status,
    nextAction: args.nextAction,
    confidenceLevel: args.confidenceLevel,
    routingActions: args.routingActions,
    trace,
  };
}

export function operationsMissing(intentType: PortfolioIntentType): AskOperationsResult {
  return buildAskOperationsResult({
    intentType,
    result: 'No structured evidence found in operations data.',
    evidence: [],
    status: 'Missing',
    nextAction:
      'Try a project, blocker, invoice, expiration, flag, contract, or approval query tied to known operational data.',
    confidenceLevel: 'NONE',
    routingActions: [],
    projectIds: [],
    sourceIds: [],
  });
}

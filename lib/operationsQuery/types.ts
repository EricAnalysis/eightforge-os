export type PortfolioIntentType =
  | 'PORTFOLIO_FACT'
  | 'PORTFOLIO_RANK'
  | 'PORTFOLIO_SIGNAL'
  | 'PORTFOLIO_LIST'
  | 'PORTFOLIO_SEARCH'
  | 'PORTFOLIO_ROUTE';

export type OperationsResultStatus =
  | 'Verified'
  | 'Derived'
  | 'Ranked'
  | 'Signal'
  | 'Missing';

export type OperationsConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type OperationsEvidenceRow = {
  projectName: string;
  projectId: string | null;
  href: string;
  detail: string;
  sourceId: string;
};

/** Portfolio-level filtered queue / Command Center view (see askOperationsExecutionAdapter). */
export type OperationsQueueType =
  | 'blocked_projects'
  | 'high_risk_projects'
  | 'approaching_nte'
  | 'approval_blockers'
  | 'pending_invoices'
  | 'projects_needing_review';

export type OperationsRoutingAction = {
  label: string;
  href: string;
  /** When OPEN_QUEUE, `href` targets an existing filtered Command Center view. */
  routingKind?: 'OPEN_QUEUE' | 'LINK';
  queueType?: OperationsQueueType;
};

export type AskOperationsTrace = {
  intentType: PortfolioIntentType;
  status: OperationsResultStatus;
  confidenceLevel: OperationsConfidenceLevel;
  projectIds: string[];
  sourceIds: string[];
  routingAttached: boolean;
};

export type AskOperationsResult = {
  intentType: PortfolioIntentType;
  result: string;
  evidence: OperationsEvidenceRow[];
  status: OperationsResultStatus;
  nextAction: string | null;
  confidenceLevel: OperationsConfidenceLevel;
  routingActions: OperationsRoutingAction[];
  trace: AskOperationsTrace;
};

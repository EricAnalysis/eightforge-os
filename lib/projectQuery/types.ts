export type ProjectQueryType =
  | 'FACT'
  | 'DERIVE'
  | 'VERIFY'
  | 'LIST'
  | 'SEARCH'
  | 'SIGNAL';

export type ProjectQueryStatus =
  | 'Verified'
  | 'Derived'
  | 'Mismatch'
  | 'Missing'
  | 'Signal';

/** Deterministic confidence tier (no numeric score). */
export type ProjectQueryConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type EvidenceAnchor = {
  label: string;
  href: string;
  /**
   * Short locator (page/section/table row) when known.
   * For first-pass deterministic results, this may be a record pointer.
   */
  locator?: string | null;
  snippet: string;
  sourceId?: string | null;
  sourceKind?: string | null;
  /** When known, used to dedupe SIGNAL evidence with decision-backed rows. */
  ruleId?: string | null;
};

export type ProjectQueryTrace = {
  projectId: string;
  detectedType: ProjectQueryType;
  status: ProjectQueryStatus;
  confidenceLevel: ProjectQueryConfidenceLevel;
  sourceIds: string[];
  precedenceApplied: boolean;
};

export type ProjectQueryResult = {
  type: ProjectQueryType;
  status: ProjectQueryStatus;
  result: string;
  evidence: EvidenceAnchor[];
  nextAction: string | null;
  confidenceLevel: ProjectQueryConfidenceLevel;
  trace: ProjectQueryTrace;
};

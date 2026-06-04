export type ValidationStateLabel =
  | 'Confirmed'
  | 'Approved'
  | 'Approved with Warnings'
  | 'Blocked'
  | 'Requires Review'
  | 'Not Evaluated'
  | 'Not Found'
  | string;

export interface PortfolioHandoffContext {
  originalPortfolioQuery: string;
  projectId: string;
  projectName: string;
  signalReason: string;
  validationState: ValidationStateLabel;
  atRiskAmount: number | null;
  openBlockerCount: number;
  openWarningCount: number;
  openExecutionItemCount: number;
  snapshotIsStale: boolean;
  suggestedProjectQuery: string;
}

export function buildPortfolioHandoffContext(params: {
  originalPortfolioQuery: string;
  projectId: string;
  projectName: string;
  signalReason: string;
  validationState: ValidationStateLabel;
  atRiskAmount: number | null;
  openBlockerCount: number;
  openWarningCount: number;
  openExecutionItemCount: number;
  snapshotIsStale: boolean;
}): PortfolioHandoffContext {
  return {
    ...params,
    suggestedProjectQuery: `Why was this project surfaced for ${params.signalReason}, what evidence supports the risk, and what is the next action?`,
  };
}

export function encodePortfolioHandoffContext(context: PortfolioHandoffContext): string {
  return encodeURIComponent(JSON.stringify(context));
}

export function decodePortfolioHandoffContext(value: string | null): PortfolioHandoffContext | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<PortfolioHandoffContext>;
    if (!parsed.projectId || !parsed.projectName || !parsed.suggestedProjectQuery) return null;
    return {
      originalPortfolioQuery: parsed.originalPortfolioQuery ?? '',
      projectId: parsed.projectId,
      projectName: parsed.projectName,
      signalReason: parsed.signalReason ?? 'portfolio signal',
      validationState: parsed.validationState ?? 'Not Evaluated',
      atRiskAmount: typeof parsed.atRiskAmount === 'number' ? parsed.atRiskAmount : null,
      openBlockerCount: parsed.openBlockerCount ?? 0,
      openWarningCount: parsed.openWarningCount ?? 0,
      openExecutionItemCount: parsed.openExecutionItemCount ?? 0,
      snapshotIsStale: Boolean(parsed.snapshotIsStale),
      suggestedProjectQuery: parsed.suggestedProjectQuery,
    };
  } catch {
    return null;
  }
}

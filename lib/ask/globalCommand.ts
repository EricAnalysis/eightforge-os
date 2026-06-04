export type AskScope = 'project' | 'portfolio' | 'intelligence' | 'search';

export type AskAvailabilityStatus = 'available' | 'not_wired' | 'unavailable';

export type PortfolioSignalState =
  | 'Portfolio Blocked'
  | 'Portfolio Needs Review'
  | 'Portfolio Exposure'
  | 'Portfolio Ready'
  | 'No Verified Data';

export type AskEvidenceLink = {
  label: string;
  href: string;
  source?: string;
};

export type AskNextAction = {
  label: string;
  href?: string;
};

export type AskPortfolioProjectSignal = {
  projectId: string;
  projectName: string;
  readinessState: string;
  validationState: string;
  atRiskAmount: number;
  blockerCount: number;
  warningCount: number;
  openExecutionItemCount: number;
  isStale: boolean;
  stalenessLabel: string;
  signalReason: string;
  handoffHref: string;
};

export type AskPortfolioSections = {
  portfolioSignal: string;
  projectsAffected: AskPortfolioProjectSignal[];
  financialExposure: {
    totalAtRiskAmount: number;
    perProject: Array<{
      projectId: string;
      projectName: string;
      atRiskAmount: number;
    }>;
  };
  patternDetected: {
    label: string;
    affectedProjects: string[];
    exists: boolean;
  };
  recommendedAction: {
    label: string;
    projectName: string | null;
    workflowName: string;
    reason: string;
    href?: string;
  };
};

export type AskMatchedRecord = {
  type: 'project' | 'document' | 'decision' | 'invoice' | 'contract' | 'contractor' | 'ticket';
  label: string;
  context?: string;
  href: string;
  source?: string;
};

export type AskAnswerContract = {
  scope: AskScope;
  question: string;
  answer?: string;
  signal?: string;
  validationState?: string;
  portfolioSignalState?: PortfolioSignalState;
  gateImpact?: string;
  pattern?: string;
  operationalImpact?: string;
  recommendedAction?: string;
  evidence: AskEvidenceLink[];
  sources: string[];
  checkedSources: string[];
  nextActions: AskNextAction[];
  matchedRecords?: AskMatchedRecord[];
  availability: AskAvailabilityStatus;
  dataFound: boolean;
  generatedBy?: 'deterministic_aggregate' | 'existing_project_ask' | 'search' | 'safe_fallback';
  promptVersion?: string;
  portfolioSections?: AskPortfolioSections;
};

const PORTFOLIO_INTENT_PATTERN =
  /\b(all projects|cross[-\s]?project|workspace|portfolio|vendors?|total exposure|at risk|review load|blocked approvals?)\b/i;

const INTELLIGENCE_INTENT_PATTERN =
  /\b(patterns?|trends?|recurring|rule failures?|extraction quality|override frequency|overrides?|bottlenecks?|system improvement|least reliable|most corrected)\b/i;

const SEARCH_INTENT_PATTERN =
  /\b(find|open|search|locate|jump to|show me)\b.*\b(document|project|invoice|contract|contractor|vendor|ticket|decision)\b/i;

export function detectAskScope(pathname: string, query = ''): AskScope {
  const trimmed = query.trim();

  if (trimmed && SEARCH_INTENT_PATTERN.test(trimmed)) return 'search';
  if (trimmed && INTELLIGENCE_INTENT_PATTERN.test(trimmed)) return 'intelligence';
  if (trimmed && PORTFOLIO_INTENT_PATTERN.test(trimmed)) return 'portfolio';

  if (pathname.startsWith('/platform/reviews')) return 'intelligence';
  if (pathname.startsWith('/platform/portfolio')) return 'portfolio';
  if (pathname === '/platform') return 'portfolio';
  if (pathname.startsWith('/platform/decisions')) return 'portfolio';
  if (pathname.startsWith('/platform/documents')) return 'search';
  if (pathname.startsWith('/platform/workflows')) return 'portfolio';
  if (pathname.startsWith('/platform/workspace/projects/') || pathname.startsWith('/platform/projects/')) {
    return 'project';
  }

  return 'search';
}

export function scopeLabel(scope: AskScope): string {
  switch (scope) {
    case 'project':
      return 'Project';
    case 'portfolio':
      return 'Portfolio';
    case 'intelligence':
      return 'Intelligence';
    case 'search':
      return 'Search';
  }
}

export function buildSafeAskContract(params: {
  pathname: string;
  question: string;
  forcedScope?: AskScope;
}): AskAnswerContract {
  const scope = params.forcedScope ?? detectAskScope(params.pathname, params.question);
  const question = params.question.trim();

  if (scope === 'search') {
    return {
      scope,
      question,
      answer: 'This is routed as search intent. Use the existing navigation surfaces below to find project, document, decision, invoice, contract, contractor, vendor, or ticket records.',
      evidence: [],
      sources: ['Existing platform search/navigation surfaces'],
      checkedSources: ['projects', 'documents', 'decisions'],
      nextActions: [
        { label: 'Search documents', href: '/platform/documents' },
        { label: 'Search projects', href: '/platform/projects' },
        { label: 'Open Decision Queue', href: '/platform/decisions' },
      ],
      availability: 'available',
      dataFound: false,
      generatedBy: 'safe_fallback',
    };
  }

  if (scope === 'intelligence') {
    return {
      scope,
      question,
      signal: 'No deterministic macro intelligence answer backend is wired to the global command bar yet.',
      pattern: 'Pattern, trend, rule performance, override, and extraction-quality answers must be derived from persisted aggregates before they can be shown here.',
      operationalImpact: 'The question is safely routed to Intelligence scope without inventing trend data.',
      recommendedAction: 'Use the Intelligence page for currently available deterministic signals and empty states.',
      evidence: [],
      sources: ['Route-based Ask EightForge scope detection'],
      checkedSources: ['route scope detection'],
      nextActions: [{ label: 'Open Intelligence', href: '/platform/reviews' }],
      availability: 'not_wired',
      dataFound: false,
      generatedBy: 'safe_fallback',
    };
  }

  return {
    scope,
    question,
    answer:
      scope === 'project'
        ? 'This is routed to Project scope. The global command bar is not connected to the existing Ask Project backend in this pass.'
        : 'This is routed to Portfolio scope. No portfolio Ask answer backend is wired yet.',
    validationState: 'Unavailable from the global command bar.',
    gateImpact: 'No approval or execution state was changed.',
    evidence: [],
    sources: ['Route-based Ask EightForge scope detection'],
    checkedSources: ['route scope detection'],
    nextActions:
      scope === 'project'
        ? [{ label: 'Open Projects', href: '/platform/projects' }]
        : [
            { label: 'Open Portfolio', href: '/platform/portfolio' },
            { label: 'Open Decision Queue', href: '/platform/decisions' },
          ],
    availability: 'not_wired',
    dataFound: false,
    generatedBy: 'safe_fallback',
  };
}

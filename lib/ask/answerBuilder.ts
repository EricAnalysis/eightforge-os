// ASK BOUNDARY FILE — reads canonical truth, never produces it.
// No summation, scoring, risk creation, severity assignment, or pattern
// inference in this layer. Any change must pass scripts/ask/phase3Diagnostic.ts
// at 22/22, 0 gaps. See Ask workstream closeout.
import type {
  AskConfidence,
  AskRelationship,
  AskResponse,
  AskDocument,
  AskProjectRecord,
  ClassifiedQuestion,
  ContractorMismatchRelationship,
  CeilingVsBilledRelationship,
  DecisionRecord,
  RetrievalResult,
  Source,
  StructuredFact,
  SuggestedAction,
  ValidatorContext,
  ValidatorFinding,
  AskConfidenceState,
  ValidationStateLabel,
} from '@/lib/ask/types';
import type { PortfolioHandoffContext } from '@/lib/ask/portfolioHandoffContext';
import { ASK_PROJECT_SYSTEM_PROMPT_VERSION } from '@/lib/ask/canonicalPrompts';
import { guardProjectRead } from '@/lib/ask/canonicalReadGuard';
import { detectUpstreamGap } from '@/lib/ask/upstreamGapDetector';
import {
  buildAmbiguousGapResponse,
  buildProjectUpstreamGap,
  detectDeferredGap,
  type ActionableGapResponse,
} from '@/lib/ask/actionableGapResponse';
import { selectProjectAnswer } from '@/lib/ask/selectors';
import { classifyQueryIntent, type RouterResult } from '@/lib/ask/router/intentRouter';

const CEILING_FIELD_KEYS = new Set(['contract_ceiling', 'nte_amount']);
const BILLED_FIELD_KEYS = new Set([
  'billed_amount',
  'invoice_total',
  'total_amount',
  'current_amount_due',
  'total_billed',
]);
const CONTRACTOR_FIELD_KEYS = new Set(['contractor_name', 'vendor_name']);

function buildProjectClarificationResponse(params: {
  question: ClassifiedQuestion;
  routerResult: Extract<RouterResult, { intent: 'ambiguous' }>;
  projectId: string;
  orgId: string;
  retrievalUsed: RetrievalResult['rawData']['matchedLayer'];
  handoffContext?: PortfolioHandoffContext;
}): AskResponse {
  const actionableGap = buildAmbiguousGapResponse({
    candidates: params.routerResult.candidates,
    clarificationPrompt: params.routerResult.clarificationPrompt,
  });
  return {
    answer: [
      actionableGap.answer,
      '',
      actionableGap.clarificationPrompt,
    ].filter(Boolean).join('\n'),
    confidence: 'low',
    confidenceScore: 35,
    sources: [],
    reasoning: 'Deterministic Ask router returned an ambiguous intent and did not dispatch to a selector.',
    intent: params.question.intent,
    retrievalUsed: params.retrievalUsed ?? 'documents',
    originalQuestion: params.question.originalQuestion,
    projectId: params.projectId,
    orgId: params.orgId,
    createdAt: new Date().toISOString(),
    promptVersion: ASK_PROJECT_SYSTEM_PROMPT_VERSION,
    validationState: 'Requires Review',
    gateImpact: 'No approval, execution, or truth state was changed.',
    nextAction: actionableGap.nextAction,
    actionableGap,
    sections: {
      answer: actionableGap.answer,
      confidenceState: 'Requires Review',
      evidence: [],
      validatorFindings: [],
      validationState: 'Requires Review',
      blockerCount: 0,
      warningCount: 0,
      gateImpact: 'No approval, execution, or truth state was changed.',
      nextAction: actionableGap.nextAction,
      upstreamGap: null,
      actionableGap,
      handoffContext: params.handoffContext,
    },
    handoffContext: params.handoffContext,
  };
}

function suggestedActionForGap(gap: ActionableGapResponse): SuggestedAction {
  switch (gap.nextAction) {
    case 'Open Validator':
    case 'Run Validator':
      return { type: 'check_validator', label: gap.nextAction, target: 'validator' };
    case 'Open Execution Queue':
      return { type: 'assign_action', label: gap.nextAction, target: 'execution' };
    case 'Open Execution Item':
    case 'Create Execution Item':
      return { type: 'create_decision', label: gap.nextAction, target: 'execution' };
    case 'Open Communication Review':
      return { type: 'assign_action', label: gap.nextAction, target: 'communication-review' };
    case 'Reprocess Document':
      return { type: 'upload_document', label: gap.nextAction, target: 'documents' };
    case 'Open Evidence':
      return { type: 'view_document', label: gap.nextAction, target: 'evidence' };
    case 'Open Portfolio':
    case 'Open Ask Project':
    case 'No action required':
    default:
      return { type: 'assign_action', label: gap.nextAction };
  }
}

function formatActionableGapAnswer(gap: ActionableGapResponse): string {
  return [
    'Answer:',
    gap.answer,
    '',
    'Missing:',
    gap.missing,
    '',
    'Resolution Workflow:',
    gap.resolutionWorkflow,
    '',
    'Next Action:',
    gap.nextAction,
  ].join('\n');
}

function buildActionableProjectGapResponse(params: {
  question: ClassifiedQuestion;
  gap: ActionableGapResponse;
  projectId: string;
  orgId: string;
  retrievalUsed: RetrievalResult['rawData']['matchedLayer'];
  handoffContext?: PortfolioHandoffContext;
}): AskResponse {
  const answer = formatActionableGapAnswer(params.gap);
  return {
    answer,
    confidence: 'low',
    confidenceScore: 30,
    sources: [],
    reasoning: 'Deterministic Ask returned an actionable non-answer without producing new truth.',
    promptVersion: ASK_PROJECT_SYSTEM_PROMPT_VERSION,
    validationState: 'Not Found',
    gateImpact: 'No approval, execution, or truth state was changed.',
    nextAction: params.gap.nextAction,
    actionableGap: params.gap,
    sections: {
      answer: params.gap.answer,
      confidenceState: 'Not Found',
      evidence: [],
      validatorFindings: [],
      validationState: 'Not Found',
      blockerCount: 0,
      warningCount: 0,
      gateImpact: 'No approval, execution, or truth state was changed.',
      nextAction: params.gap.nextAction,
      upstreamGap: params.gap.gapClass === 'upstream'
        ? {
            ...params.gap,
            fieldKey: params.gap.missing,
            expectedSource: 'canonical project truth',
            message: params.gap.answer,
          }
        : null,
      actionableGap: params.gap,
      handoffContext: params.handoffContext,
    },
    limitations: [params.gap.missing],
    suggestedActions: [suggestedActionForGap(params.gap)],
    intent: params.question.intent,
    retrievalUsed: params.retrievalUsed ?? 'documents',
    originalQuestion: params.question.originalQuestion,
    projectId: params.projectId,
    orgId: params.orgId,
    createdAt: new Date().toISOString(),
    fallbackUsed: false,
    handoffContext: params.handoffContext,
  };
}

function confidenceToScore(confidence: AskConfidence): number {
  switch (confidence) {
    case 'high':
      return 88;
    case 'medium':
      return 68;
    case 'low':
    default:
      return 42;
  }
}

function scoreToConfidence(score: number): AskConfidence {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function humanize(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksMonetary(label: string | undefined): boolean {
  const normalized = (label ?? '').toLowerCase();
  return (
    normalized.includes('amount')
    || normalized.includes('ceiling')
    || normalized.includes('cost')
    || normalized.includes('total')
    || normalized.includes('invoice')
    || normalized.includes('billed')
  );
}

function formatValue(value: string | number, label?: string): string {
  if (typeof value === 'number' && looksMonetary(label)) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: value >= 1000 ? 0 : 2,
    }).format(value);
  }

  if (typeof value === 'number') {
    return new Intl.NumberFormat('en-US').format(value);
  }

  return value;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function isProjectScopedSourceId(value: string | null | undefined): boolean {
  return (value ?? '').startsWith('project:');
}

function factSource(fact: StructuredFact): Source {
  const documentId = isProjectScopedSourceId(fact.extractedFrom) ? undefined : fact.extractedFrom;

  return {
    type: 'fact',
    label: fact.page
      ? `${fact.documentName ?? 'Document'} · Page ${fact.page}`
      : fact.documentName ?? (documentId ? 'Structured fact' : 'Project truth'),
    documentId,
    documentName: fact.documentName,
    page: fact.page,
    snippet: `${fact.label}: ${formatValue(fact.value, fact.label)}`.slice(0, 50),
    confidence: fact.confidence,
    timestamp: fact.timestamp,
    anchorId: fact.anchorId,
    factId: fact.factId,
  };
}

function validatorSource(finding: ValidatorFinding): Source {
  return {
    type: 'validator',
    label: finding.page && finding.documentName
      ? `${finding.documentName} · Page ${finding.page}`
      : finding.documentName ?? 'Validator finding',
    documentId: finding.documentId ?? undefined,
    documentName: finding.documentName ?? undefined,
    page: finding.page ?? undefined,
    snippet: finding.description.slice(0, 50),
    confidence: finding.blocksProject ? 95 : 82,
    timestamp: finding.timestamp,
    factId: finding.factId ?? undefined,
  };
}

function decisionSource(decision: DecisionRecord): Source {
  return {
    type: 'decision',
    label: decision.documentName
      ? `${decision.documentName} · Decision`
      : 'Decision queue',
    documentId: decision.documentId ?? undefined,
    documentName: decision.documentName ?? undefined,
    snippet: (decision.summary ?? decision.title).slice(0, 50),
    confidence: decision.confidence != null
      ? decision.confidence <= 1
        ? Math.round(decision.confidence * 100)
        : Math.round(decision.confidence)
      : 76,
    timestamp: decision.detectedAt ?? decision.createdAt,
  };
}

function documentSource(document: AskDocument): Source {
  return {
    type: 'document',
    label: document.title,
    documentId: document.id,
    documentName: document.documentName,
    page: document.page,
    snippet: [document.documentType, document.processingStatus]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 50),
    confidence: 72,
    timestamp: document.processedAt ?? document.createdAt,
  };
}

function validatorSummarySource(context: ValidatorContext | undefined): Source | null {
  if (!context) return null;

  return {
    type: 'validator',
    label: `Project validator · ${context.projectStatus}`,
    confidence: context.projectStatus === 'blocked' ? 96 : context.projectStatus === 'warning' ? 82 : 74,
    timestamp: context.lastRun,
    snippet: context.blockedReason.slice(0, 50),
  };
}

function calculationSource(params: {
  label: string;
  snippet: string;
  timestamp: string;
}): Source {
  return {
    type: 'calculation',
    label: params.label,
    snippet: params.snippet.slice(0, 50),
    confidence: 84,
    timestamp: params.timestamp,
  };
}

function canonicalFieldKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isFactInSet(fact: StructuredFact, allowedFieldKeys: Set<string>): boolean {
  const key = canonicalFieldKey(fact.fieldKey ?? fact.label);
  return allowedFieldKeys.has(key);
}

function bestFactByConfidence(facts: StructuredFact[]): StructuredFact | null {
  if (facts.length === 0) return null;

  return [...facts].sort((left, right) => {
    const confidenceDelta = right.confidence - left.confidence;
    if (confidenceDelta !== 0) return confidenceDelta;
    return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  })[0] ?? null;
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = [
      source.type,
      source.label,
      source.documentId ?? '',
      source.page ?? '',
      source.factId ?? '',
    ].join(':');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestTimestampForSources(sources: Source[]): string {
  if (sources.length === 0) return new Date().toISOString();

  return [...sources]
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    )[0]?.timestamp ?? new Date().toISOString();
}

function decisionAmount(decision: DecisionRecord): number | null {
  if (!decision.details) return null;

  const candidateKeys = [
    'billed_amount',
    'invoice_total',
    'total_amount',
    'current_amount_due',
    'approved_amount',
    'recommended_amount',
  ];

  for (const key of candidateKeys) {
    const value = decision.details[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[$,]/g, '').trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function buildCeilingVsBilledAnswer(params: {
  relationship: CeilingVsBilledRelationship;
  retrieval: RetrievalResult;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  const reasoningFacts = params.retrieval.rawData.reasoningFacts ?? params.retrieval.facts;
  const ceilingFact = bestFactByConfidence(
    reasoningFacts.filter((fact) => isFactInSet(fact, CEILING_FIELD_KEYS)),
  );
  const canonicalTotalBilledFact = bestFactByConfidence(
    reasoningFacts.filter(
      (fact) => canonicalFieldKey(fact.fieldKey ?? fact.label) === 'total_billed',
    ),
  );
  const billedFactsByDocument = new Map<string, StructuredFact>();

  for (const fact of reasoningFacts.filter((candidate) => isFactInSet(candidate, BILLED_FIELD_KEYS))) {
    const key = fact.extractedFrom || fact.id;
    const current = billedFactsByDocument.get(key);
    if (!current || fact.confidence > current.confidence) {
      billedFactsByDocument.set(key, fact);
    }
  }

  const billedFactSources = canonicalTotalBilledFact
    ? [factSource(canonicalTotalBilledFact)]
    : Array.from(billedFactsByDocument.values())
        .slice(0, 2)
        .map(factSource);
  const billedDecisionSources =
    billedFactSources.length > 0
      ? []
      : params.retrieval.decisions
          .filter((decision) => decisionAmount(decision) != null)
          .slice(0, 2)
          .map(decisionSource);

  const evidenceSources = dedupeSources([
    ...(ceilingFact ? [factSource(ceilingFact)] : []),
    ...billedFactSources,
    ...billedDecisionSources,
  ]);

  const calculation = calculationSource({
    label: 'Ceiling vs billed comparison',
    snippet: `${formatCurrency(params.relationship.billed)} billed vs ${formatCurrency(params.relationship.ceiling)} ceiling`,
    timestamp: latestTimestampForSources(evidenceSources),
  });

  return {
    answer: params.relationship.message,
    sources: dedupeSources([...evidenceSources, calculation]).slice(0, 4),
    limitations:
      billedFactSources.length === 0 && billedDecisionSources.length > 0
        ? ['Billed total was derived from decision records because no billed fact was persisted.']
        : [],
  };
}

function canonicalContractorName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,/&()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContractorMismatchAnswer(params: {
  relationship: ContractorMismatchRelationship;
  retrieval: RetrievalResult;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  const reasoningFacts = params.retrieval.rawData.reasoningFacts ?? params.retrieval.facts;
  const selectedByName = new Map<string, StructuredFact>();

  for (const fact of reasoningFacts.filter((candidate) => isFactInSet(candidate, CONTRACTOR_FIELD_KEYS))) {
    if (typeof fact.value !== 'string' || fact.value.trim().length === 0) continue;

    const canonical = canonicalContractorName(fact.value);
    const current = selectedByName.get(canonical);
    if (!current || fact.confidence > current.confidence) {
      selectedByName.set(canonical, fact);
    }
  }

  return {
    answer: params.relationship.message,
    sources: Array.from(selectedByName.values()).slice(0, 3).map(factSource),
    limitations: [],
  };
}

function buildRelationshipAnswer(params: {
  relationships: AskRelationship[];
  retrieval: RetrievalResult;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} | null {
  const primaryRelationship = params.relationships[0];
  if (!primaryRelationship) return null;

  switch (primaryRelationship.type) {
    case 'ceiling_vs_billed':
      return buildCeilingVsBilledAnswer({
        relationship: primaryRelationship,
        retrieval: params.retrieval,
      });
    case 'contractor_mismatch':
      return buildContractorMismatchAnswer({
        relationship: primaryRelationship,
        retrieval: params.retrieval,
      });
    default:
      return null;
  }
}

function normalizeValidationState(value: string): ValidationStateLabel {
  if (value.startsWith('Approved with Warnings')) return 'Approved with Warnings';
  if (value.startsWith('Blocked')) return 'Blocked';
  if (value === 'Requires Review') return 'Requires Review';
  if (value === 'Not Found') return 'Not Found';
  if (value === 'Not Evaluated') return 'Not Evaluated';
  if (value === 'Approved') return 'Approved';
  return 'Confirmed';
}

function confidenceStateForResponse(params: {
  validationState: ValidationStateLabel;
  fallbackUsed: boolean;
  upstreamGap: ReturnType<typeof detectUpstreamGap>;
  limitations: string[];
}): AskConfidenceState {
  if (params.upstreamGap || params.validationState === 'Not Found') return 'Not Found';
  if (params.validationState === 'Requires Review' || params.validationState === 'Blocked') return 'Requires Review';
  if (params.fallbackUsed || params.limitations.length > 0 || params.validationState === 'Approved with Warnings') return 'Partial';
  return 'Verified';
}

function validationStateForResponse(params: {
  findings: ValidatorFinding[];
  context?: ValidatorContext;
  sources: Source[];
  fallbackUsed: boolean;
  limitations: string[];
}): string {
  const blockerCount = params.findings.filter((finding) => finding.severity === 'critical' || finding.blocksProject).length;
  const warningCount = params.findings.filter((finding) => finding.severity === 'warning').length;
  const suffix = [
    blockerCount > 0 ? `${blockerCount} blocker${blockerCount === 1 ? '' : 's'}` : null,
    warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ');

  if (blockerCount > 0 || params.context?.projectStatus === 'blocked') {
    return `Blocked${suffix ? ` - ${suffix}` : ''}`;
  }

  if (warningCount > 0 || params.context?.projectStatus === 'warning') {
    return `Approved with Warnings${suffix ? ` - ${suffix}` : ''}`;
  }

  if (params.fallbackUsed || params.limitations.length > 0) {
    return 'Requires Review';
  }

  if (params.sources.length === 0) {
    return 'Not Found';
  }

  if (params.sources.some((source) => source.type === 'fact' || source.type === 'validator')) {
    return 'Confirmed';
  }

  return 'Not Evaluated';
}

function gateImpactForResponse(params: {
  findings: ValidatorFinding[];
  context?: ValidatorContext;
  intent: ClassifiedQuestion['intent'];
  fallbackUsed: boolean;
  answer: string;
}): string {
  const text = params.answer.toLowerCase();

  if (params.findings.some((finding) => finding.severity === 'critical' || finding.blocksProject) || params.context?.projectStatus === 'blocked') {
    return 'Affects approval, payment release, audit defensibility, and execution priority.';
  }

  if (params.findings.some((finding) => finding.severity === 'warning') || params.context?.projectStatus === 'warning') {
    return 'Affects audit defensibility, contract compliance, document review, or execution priority.';
  }

  if (params.fallbackUsed) {
    return 'Affects audit defensibility until the missing canonical source is resolved.';
  }

  if (params.intent === 'missing_data') {
    return 'Affects document review and invoice readiness.';
  }

  if (text.includes('invoice') || text.includes('billed') || text.includes('payment')) {
    return 'Affects invoice readiness or payment release.';
  }

  return 'No gate impact.';
}

function nextActionForResponse(params: {
  findings: ValidatorFinding[];
  sources: Source[];
  decisions: DecisionRecord[];
  documents: AskDocument[];
  fallbackUsed: boolean;
  intent: ClassifiedQuestion['intent'];
}): string {
  if (params.findings.length > 0) return 'Open Validator';
  if (params.decisions.length > 0) return 'Open Execution Item';
  if (params.sources.some((source) => source.documentId || source.anchorId || source.factId)) return 'Open Evidence';
  if (params.intent === 'missing_data') return 'Create Execution Item';
  if (params.fallbackUsed || params.documents.some((document) => document.processingStatus === 'failed')) return 'Reprocess Document';
  return 'No action required';
}

function formatEvidenceBlock(params: {
  sources: Source[];
  limitations: string[];
}): string {
  const sourceLines = params.sources.slice(0, 4).map((source) => {
    const parts = [
      source.label,
      source.documentName && source.documentName !== source.label ? source.documentName : null,
      source.page ? `page ${source.page}` : null,
      source.factId ? `fact ${source.factId}` : null,
      source.anchorId ? `anchor ${source.anchorId}` : null,
      source.snippet ? source.snippet : null,
    ].filter(Boolean);

    return parts.join(' / ');
  });

  if (sourceLines.length === 0) {
    sourceLines.push('No source document, fact node, validation snapshot, execution item, or audit event was found for this question.');
  }

  return [...sourceLines, ...params.limitations].join('\n');
}

function formatCanonicalProjectAnswer(params: {
  answer: string;
  sources: Source[];
  limitations: string[];
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
  documents: AskDocument[];
  context?: ValidatorContext;
  intent: ClassifiedQuestion['intent'];
  fallbackUsed: boolean;
  validationStateOverride?: ValidationStateLabel;
  gateImpactOverride?: string;
  nextActionOverride?: string;
}): {
  answer: string;
  validationState: string;
  gateImpact: string;
  nextAction: string;
} {
  const validationState = params.validationStateOverride ?? validationStateForResponse({
    findings: params.findings,
    context: params.context,
    sources: params.sources,
    fallbackUsed: params.fallbackUsed,
    limitations: params.limitations,
  });
  const gateImpact = params.gateImpactOverride ?? gateImpactForResponse({
    findings: params.findings,
    context: params.context,
    intent: params.intent,
    fallbackUsed: params.fallbackUsed,
    answer: params.answer,
  });
  const nextAction = params.nextActionOverride ?? nextActionForResponse({
    findings: params.findings,
    sources: params.sources,
    decisions: params.decisions,
    documents: params.documents,
    fallbackUsed: params.fallbackUsed,
    intent: params.intent,
  });

  return {
    answer: [
      'Answer:',
      params.answer,
      '',
      'Evidence:',
      formatEvidenceBlock({
        sources: params.sources,
        limitations: params.limitations,
      }),
      '',
      'Validation State:',
      validationState,
      '',
      'Gate Impact:',
      gateImpact,
      '',
      'Next Action:',
      nextAction,
    ].join('\n'),
    validationState,
    gateImpact,
    nextAction,
  };
}

function dedupeActions(actions: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();

  return actions.filter((action) => {
    const key = `${action.type}:${action.target ?? action.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSuggestedActions(params: {
  facts: StructuredFact[];
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
  documents: AskDocument[];
  intent: ClassifiedQuestion['intent'];
}): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const primaryDocumentFact = params.facts.find(
    (fact) => fact.extractedFrom && !isProjectScopedSourceId(fact.extractedFrom),
  );

  if (primaryDocumentFact?.extractedFrom) {
    actions.push({
      type: 'view_document',
      label: 'View source document',
      target: primaryDocumentFact.extractedFrom,
    });
  }

  if (params.findings.length > 0) {
    actions.push({
      type: 'check_validator',
      label: 'Review validator findings',
      target: 'validator',
    });
  }

  if (params.findings[0]?.linkedDecisionId) {
    actions.push({
      type: 'resolve_decision',
      label: 'Review linked decision',
      target: params.findings[0].linkedDecisionId,
    });
  }

  if (params.decisions[0]?.id) {
    actions.push({
      type: 'resolve_decision',
      label: 'Open pending decision',
      target: params.decisions[0].id,
    });
  }

  if (params.documents[0]?.id) {
    actions.push({
      type: 'view_document',
      label: 'Open matching document',
      target: params.documents[0].id,
    });
  }

  if (params.intent === 'missing_data') {
    actions.push({
      type: 'upload_document',
      label: 'Upload missing support',
    });
  }

  return dedupeActions(actions).slice(0, 4);
}

function relatedQuestionsForIntent(intent: ClassifiedQuestion['intent']): string[] {
  switch (intent) {
    case 'fact_question':
      return [
        'Why is this project blocked?',
        'What decisions are pending?',
        'What documents have been processed?',
      ];
    case 'validator_question':
      return [
        'What should I do next?',
        'What decisions are pending?',
        'What is the contract ceiling?',
      ];
    case 'missing_data':
      return [
        'Show me the contract',
        'Why is this project blocked?',
        'What decisions are pending?',
      ];
    case 'document_lookup':
      return [
        'What is the contract ceiling?',
        'What documents have been processed?',
        'Why is this project blocked?',
      ];
    case 'status_check':
      return [
        'Why is this project blocked?',
        'What decisions are pending?',
        'What should I do next?',
      ];
    case 'action_needed':
      return [
        'Why is this project blocked?',
        'What documents have been processed?',
        'What is the contract ceiling?',
      ];
    default:
      return [
        'What is the contract ceiling?',
        'Why is this project blocked?',
        'What decisions are pending?',
      ];
  }
}

function fallbackAnswer(project: AskProjectRecord, question: ClassifiedQuestion): {
  answer: string;
  limitations: string[];
} {
  return {
    answer: `I can’t answer "${question.originalQuestion}" confidently from persisted project truth for ${project.name} yet.`,
    limitations: [
      'No matching structured fact, validator finding, decision, or document was found.',
      'Ask relies on persisted project facts and validator results only.',
    ],
  };
}

function buildFactAnswer(facts: StructuredFact[]): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  const topFact = facts[0];
  const grouped = facts.filter((fact) => fact.fieldKey === topFact.fieldKey || fact.label === topFact.label);
  const uniqueValues = Array.from(new Set(grouped.map((fact) => String(fact.value))));

  if (uniqueValues.length > 1) {
    return {
      answer: `I found multiple persisted values for ${humanize(topFact.label)}. The strongest current value is ${formatValue(topFact.value, topFact.label)}, but there are conflicting records to review.`,
      sources: grouped.slice(0, 3).map(factSource),
      limitations: ['Structured facts disagree across the current project record.'],
    };
  }

  return {
    answer: `${humanize(topFact.label)} is ${formatValue(topFact.value, topFact.label)}.`,
    sources: grouped.slice(0, 3).map(factSource),
    limitations: [],
  };
}

function isTotalLineageQuestion(question: ClassifiedQuestion, facts: StructuredFact[]): boolean {
  const text = question.originalQuestion.toLowerCase();
  return (
    facts.some((fact) => canonicalFieldKey(fact.fieldKey ?? fact.label) === 'total_billed') &&
    (text.includes('come from') || text.includes('where did') || text.includes('source'))
  );
}

function buildTotalLineageAnswer(facts: StructuredFact[]): {
  answer: string;
  sources: Source[];
  limitations: string[];
} | null {
  const rollupFact = bestFactByConfidence(
    facts.filter((fact) => canonicalFieldKey(fact.fieldKey ?? fact.label) === 'total_billed'),
  );
  if (!rollupFact) return null;

  const invoiceContributions = facts
    .filter((fact) => canonicalFieldKey(fact.fieldKey ?? fact.label) === 'invoice_total')
    .filter((fact) => fact.factId !== rollupFact.factId)
    .slice(0, 4);
  const contributionText = invoiceContributions.length > 0
    ? ` The contributing invoice evidence is ${invoiceContributions.map((fact) => `${fact.label}: ${formatValue(fact.value, fact.label)}`).join('; ')}.`
    : ' No per-invoice contribution cards were available in the canonical rollup lineage.';

  return {
    answer: `${humanize(rollupFact.label)} is ${formatValue(rollupFact.value, rollupFact.label)} from the canonical project invoice total rollup.${contributionText}`,
    sources: [rollupFact, ...invoiceContributions].map(factSource),
    limitations: invoiceContributions.length > 0 ? [] : ['Canonical total was present, but per-invoice lineage was not available in the read result.'],
  };
}

function buildValidatorAnswer(params: {
  findings: ValidatorFinding[];
  context?: ValidatorContext;
  project: AskProjectRecord;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  const sources = params.findings.slice(0, 3).map(validatorSource);
  const summarySource = validatorSummarySource(params.context);
  if (summarySource) {
    sources.unshift(summarySource);
  }

  if (params.findings.length === 0 && params.context?.projectStatus === 'clear') {
    return {
      answer: `${params.project.name} is not currently blocked by the validator.`,
      sources: summarySource ? [summarySource] : [],
      limitations: [],
    };
  }

  const findingLead = params.findings[0];
  const blockerText = params.context?.blockedReason ?? findingLead?.description ?? 'open validator findings';
  const suffix = params.findings.length > 1
    ? ` Top blockers include ${params.findings.slice(0, 2).map((finding) => finding.description).join(' and ')}.`
    : '';

  return {
    answer: `${params.project.name} is ${params.context?.projectStatus === 'blocked' ? 'blocked' : 'flagged'} because ${blockerText}.${suffix}`,
    sources: sources.slice(0, 4),
    limitations: [],
  };
}

function buildDocumentAnswer(documents: AskDocument[]): {
  answer: string;
  sources: Source[];
} {
  const topDocument = documents[0];

  if (documents.length === 1) {
    return {
      answer: `The closest matching document is ${topDocument.title}.`,
      sources: [documentSource(topDocument)],
    };
  }

  return {
    answer: `I found ${documents.length} matching documents. The closest match is ${topDocument.title}.`,
    sources: documents.slice(0, 3).map(documentSource),
  };
}

function buildStatusAnswer(params: {
  project: AskProjectRecord;
  context?: ValidatorContext;
  decisions: DecisionRecord[];
  documents: AskDocument[];
  retrieval: RetrievalResult;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  const summarySource = validatorSummarySource(params.context);
  const decisionSources = params.decisions.slice(0, 2).map(decisionSource);
  const documentSources = params.documents.slice(0, 1).map(documentSource);
  const sources = [
    ...(summarySource ? [summarySource] : []),
    ...decisionSources,
    ...documentSources,
  ];

  const status = params.context?.projectStatus ?? 'clear';
  const decisionCount = Number(params.retrieval.rawData.openDecisionCount ?? params.decisions.length ?? 0);
  const processedCount = Number(params.retrieval.rawData.processedDocumentCount ?? 0);
  const totalCount = Number(params.retrieval.rawData.totalDocumentCount ?? params.documents.length ?? 0);
  const statusLabel =
    status === 'blocked' ? 'blocked' : status === 'warning' ? 'under review' : 'operationally clear';

  return {
    answer: `${params.project.name} is currently ${statusLabel}. Validator reports ${params.context?.blockedReason ?? 'no active blocker'}, with ${decisionCount} open decision${decisionCount === 1 ? '' : 's'} and ${processedCount} processed document${processedCount === 1 ? '' : 's'} out of ${totalCount}.`,
    sources: sources.slice(0, 4),
    limitations: [],
  };
}

function buildActionAnswer(params: {
  project: AskProjectRecord;
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} {
  if (params.findings.length > 0) {
    const topFinding = params.findings[0];
    return {
      answer: `Start with the validator blocker "${topFinding.description}". After that, review ${params.decisions[0]?.title ?? 'the next open decision'} to keep ${params.project.name} moving.`,
      sources: [
        validatorSource(topFinding),
        ...(params.decisions[0] ? [decisionSource(params.decisions[0])] : []),
      ],
      limitations: [],
    };
  }

  if (params.decisions.length > 0) {
    return {
      answer: `The next best action is to review ${params.decisions[0].title}. It is still ${humanize(params.decisions[0].status)} in the decision queue.`,
      sources: [decisionSource(params.decisions[0])],
      limitations: [],
    };
  }

  return {
    answer: `I don’t see a persisted next action for ${params.project.name} yet.`,
    sources: [],
    limitations: ['No matching validator finding or decision was available to turn into an action.'],
  };
}

function directCanonicalReadAnswer(params: {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} | null {
  const matchedLayer = params.retrieval.rawData.matchedLayer;

  if (matchedLayer === 'relationships' && params.retrieval.relationships.length > 0) {
    return buildRelationshipAnswer({
      relationships: params.retrieval.relationships,
      retrieval: params.retrieval,
    });
  }

  if (
    matchedLayer === 'facts' &&
    params.question.intent === 'fact_question' &&
    params.retrieval.facts.length > 0
  ) {
    return buildFactAnswer(params.retrieval.facts);
  }

  return null;
}

export function buildAskResponse(params: {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
  project: AskProjectRecord;
  projectId: string;
  orgId: string;
  handoffContext?: PortfolioHandoffContext;
}): AskResponse {
  const context = params.retrieval.rawData.validatorContext as ValidatorContext | undefined;
  const matchedLayer = params.retrieval.rawData.matchedLayer ?? 'documents';
  let answer = '';
  let sources: Source[] = [];
  let limitations: string[] = [];
  const deferredGap = detectDeferredGap(params.question);
  if (deferredGap) {
    return buildActionableProjectGapResponse({
      question: params.question,
      gap: deferredGap,
      projectId: params.projectId,
      orgId: params.orgId,
      retrievalUsed: matchedLayer,
      handoffContext: params.handoffContext,
    });
  }

  const directAnswer = directCanonicalReadAnswer({
    question: params.question,
    retrieval: params.retrieval,
  });
  if (directAnswer) {
    answer = directAnswer.answer;
    sources = directAnswer.sources;
    limitations = directAnswer.limitations;
  }

  const routerResult = classifyQueryIntent(params.question.originalQuestion, 'project');
  if (routerResult.intent === 'ambiguous' && !answer) {
    return buildProjectClarificationResponse({
      question: params.question,
      routerResult,
      projectId: params.projectId,
      orgId: params.orgId,
      retrievalUsed: matchedLayer,
      handoffContext: params.handoffContext,
    });
  }

  const selectorAnswer = routerResult.intent === 'ambiguous'
    ? null
    : selectProjectAnswer({
        question: params.question,
        retrieval: params.retrieval,
        project: params.project,
        projectId: params.projectId,
      }, routerResult.intent);
  const selectorReturnedGap = selectorAnswer?.confidence === 'not_found';

  const selectorGap = buildProjectUpstreamGap({
    question: params.question,
    retrieval: params.retrieval,
    selectorReturnedGap,
  });
  if (selectorReturnedGap && selectorGap) {
    return buildActionableProjectGapResponse({
      question: params.question,
      gap: selectorGap,
      projectId: params.projectId,
      orgId: params.orgId,
      retrievalUsed: matchedLayer,
      handoffContext: params.handoffContext,
    });
  }

  if (!answer && selectorAnswer?.value && selectorAnswer.sourceId) {
    answer = selectorAnswer.value;
    sources = selectorAnswer.sources;
    limitations = [];
  }

  if (!answer && matchedLayer === 'relationships' && params.retrieval.relationships.length > 0) {
    const relationshipAnswer = buildRelationshipAnswer({
      relationships: params.retrieval.relationships,
      retrieval: params.retrieval,
    });

    if (relationshipAnswer) {
      answer = relationshipAnswer.answer;
      sources = relationshipAnswer.sources;
      limitations = relationshipAnswer.limitations;
    }
  }

  if (!answer) {
    const lineageAnswer = isTotalLineageQuestion(params.question, params.retrieval.facts)
      ? buildTotalLineageAnswer(params.retrieval.facts)
      : null;
    if (lineageAnswer) {
      answer = lineageAnswer.answer;
      sources = lineageAnswer.sources;
      limitations = lineageAnswer.limitations;
    }
  }

  if (!answer) {
    switch (params.question.intent) {
      case 'fact_question':
        if (params.retrieval.facts.length > 0) {
          const factAnswer = buildFactAnswer(params.retrieval.facts);
          answer = factAnswer.answer;
          sources = factAnswer.sources;
          limitations = factAnswer.limitations;
          break;
        }
        if (params.retrieval.documents.length > 0) {
          const documentAnswer = buildDocumentAnswer(params.retrieval.documents);
          answer = `I could not find a matching structured fact. ${documentAnswer.answer}`;
          sources = documentAnswer.sources;
          limitations = ['Structured facts did not answer the question directly.'];
          break;
        }
        break;
      case 'validator_question': {
        const validatorAnswer = buildValidatorAnswer({
          findings: params.retrieval.validatorFindings,
          context,
          project: params.project,
        });
        answer = validatorAnswer.answer;
        sources = validatorAnswer.sources;
        limitations = validatorAnswer.limitations;
        break;
      }
      case 'missing_data':
        if (params.retrieval.validatorFindings.length > 0) {
          const validatorAnswer = buildValidatorAnswer({
            findings: params.retrieval.validatorFindings,
            context,
            project: params.project,
          });
          answer = `Missing or incomplete support is recorded. ${validatorAnswer.answer}`;
          sources = validatorAnswer.sources;
          limitations = validatorAnswer.limitations;
          break;
        }
        if (params.retrieval.decisions.length > 0) {
          answer = `The clearest recorded gap is ${params.retrieval.decisions[0].title}.`;
          sources = params.retrieval.decisions.slice(0, 2).map(decisionSource);
          break;
        }
        if (params.retrieval.documents.length > 0) {
          const documentAnswer = buildDocumentAnswer(params.retrieval.documents);
          answer = `I did not find a persisted missing-data signal. ${documentAnswer.answer}`;
          sources = documentAnswer.sources;
          limitations = ['Missing-data state is not currently persisted for this exact query.'];
          break;
        }
        break;
      case 'document_lookup': {
        const documentAnswer = buildDocumentAnswer(params.retrieval.documents);
        answer = documentAnswer.answer;
        sources = documentAnswer.sources;
        break;
      }
      case 'status_check': {
        const statusAnswer = buildStatusAnswer({
          project: params.project,
          context,
          decisions: params.retrieval.decisions,
          documents: params.retrieval.documents,
          retrieval: params.retrieval,
        });
        answer = statusAnswer.answer;
        sources = statusAnswer.sources;
        limitations = statusAnswer.limitations;
        break;
      }
      case 'action_needed': {
        const actionAnswer = buildActionAnswer({
          project: params.project,
          findings: params.retrieval.validatorFindings,
          decisions: params.retrieval.decisions,
        });
        answer = actionAnswer.answer;
        sources = actionAnswer.sources;
        limitations = actionAnswer.limitations;
        break;
      }
      case 'unknown':
      default:
        if (params.retrieval.facts.length > 0) {
          const factAnswer = buildFactAnswer(params.retrieval.facts);
          answer = factAnswer.answer;
          sources = factAnswer.sources;
          limitations = factAnswer.limitations;
        }
        break;
    }
  }

  const emptyReadGap = buildProjectUpstreamGap({
    question: params.question,
    retrieval: params.retrieval,
  });
  if ((!answer || sources.length === 0) && emptyReadGap) {
    return buildActionableProjectGapResponse({
      question: params.question,
      gap: emptyReadGap,
      projectId: params.projectId,
      orgId: params.orgId,
      retrievalUsed: matchedLayer,
      handoffContext: params.handoffContext,
    });
  }

  if (!answer || sources.length === 0) {
    const fallback = fallbackAnswer(params.project, params.question);
    answer = fallback.answer;
    limitations = [...limitations, ...fallback.limitations];
    sources = [
      ...(validatorSummarySource(context) ? [validatorSummarySource(context)!] : []),
      ...params.retrieval.documents.slice(0, 1).map(documentSource),
    ].slice(0, 2);
  }

  const sourceConfidenceAverage = sources.length > 0
    ? sources.reduce((sum, source) => sum + source.confidence, 0) / sources.length
    : 40;
  const confidenceScore = clampScore(
    (confidenceToScore(params.question.confidence) * 0.4)
      + (sourceConfidenceAverage * 0.6)
      - (limitations.length > 0 ? 6 : 0),
  );
  const confidence = scoreToConfidence(confidenceScore);
  const suggestedActions = buildSuggestedActions({
    facts: params.retrieval.facts,
    findings: params.retrieval.validatorFindings,
    decisions: params.retrieval.decisions,
    documents: params.retrieval.documents,
    intent: params.question.intent,
  });

  const guardedRead = guardProjectRead({
    retrieval: params.retrieval,
    sources,
    projectId: params.projectId,
  });
  const fallbackUsed = guardedRead.fallbackUsed || (matchedLayer === 'documents' && params.retrieval.facts.length === 0 && params.retrieval.validatorFindings.length === 0 && params.retrieval.decisions.length === 0);
  if (guardedRead.fallbackUsed && !limitations.some((limitation) => limitation.toLowerCase().includes('raw extraction fallback'))) {
    limitations = ['Unverified - raw extraction fallback.', ...limitations];
  }
  const upstreamGap = detectUpstreamGap({
    question: params.question,
    retrieval: params.retrieval,
  });
  const selectorReturnedExecutionSummary = selectorAnswer?.confidence === 'verified' && selectorAnswer.sourceLayer === 'execution_summary';
  const canonical = formatCanonicalProjectAnswer({
    answer,
    sources,
    limitations,
    findings: params.retrieval.validatorFindings,
    decisions: params.retrieval.decisions,
    documents: params.retrieval.documents,
    context,
    intent: params.question.intent,
    fallbackUsed,
    validationStateOverride: selectorReturnedGap || selectorReturnedExecutionSummary ? selectorAnswer.validationState : undefined,
    gateImpactOverride: selectorReturnedGap || selectorReturnedExecutionSummary ? selectorAnswer.gateImpact : undefined,
    nextActionOverride: selectorReturnedGap || selectorReturnedExecutionSummary ? selectorAnswer.nextAction : undefined,
  });
  const validationState = normalizeValidationState(canonical.validationState);
  const blockerCount = selectorReturnedGap
    ? 0
    : params.retrieval.validatorFindings.filter((finding) => finding.severity === 'critical' || finding.blocksProject).length;
  const warningCount = selectorReturnedGap
    ? 0
    : params.retrieval.validatorFindings.filter((finding) => finding.severity === 'warning').length;
  const confidenceState = selectorReturnedExecutionSummary
    ? 'Verified'
    : confidenceStateForResponse({
        validationState,
        fallbackUsed: fallbackUsed || guardedRead.fallbackUsed,
        upstreamGap,
        limitations,
      });
  const validatorFindings = (selectorReturnedGap ? [] : params.retrieval.validatorFindings).map((finding) => ({
    id: finding.id,
    label: finding.description,
    severity: finding.severity,
    source: finding.documentName ?? finding.factId ?? finding.category,
    gateImpact: finding.blocksProject
      ? 'Affects approval, payment release, audit defensibility, and execution priority.'
      : 'Affects audit defensibility, contract compliance, document review, or execution priority.',
    nextAction: finding.linkedActionId ? 'Open Execution Item' : 'Open Validator',
  }));

  return {
    answer: canonical.answer,
    confidence,
    confidenceScore,
    sources,
    relationships:
      params.retrieval.relationships.length > 0
        ? params.retrieval.relationships
        : undefined,
    reasoning:
      matchedLayer === 'relationships' && params.retrieval.relationships.length > 0
        ? params.retrieval.relationships[0]?.type === 'ceiling_vs_billed'
          ? 'Answer built by comparing the persisted contract ceiling with the current billed total from structured facts and decision records.'
          : 'Answer built by comparing persisted contractor names across project documents.'
        : matchedLayer === 'validator' && params.retrieval.validatorFindings.length > 0
        ? 'Answer built from the persisted validator state and open findings.'
        : matchedLayer === 'facts' && params.retrieval.facts.length > 0
          ? 'Answer built from persisted structured document facts.'
          : matchedLayer === 'decisions' && params.retrieval.decisions.length > 0
            ? 'Answer built from the project decision queue.'
            : 'Answer fell back to project document search.',
    promptVersion: ASK_PROJECT_SYSTEM_PROMPT_VERSION,
    validationState: canonical.validationState,
    gateImpact: canonical.gateImpact,
    nextAction: canonical.nextAction,
    sections: {
      answer,
      confidenceState,
      evidence: guardedRead.evidence,
      validatorFindings,
      validationState,
      blockerCount,
      warningCount,
      gateImpact: canonical.gateImpact,
      nextAction: canonical.nextAction,
      upstreamGap,
      actionableGap: upstreamGap,
      handoffContext: params.handoffContext,
    },
    limitations: limitations.length > 0 ? Array.from(new Set(limitations)) : undefined,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    relatedQuestions: relatedQuestionsForIntent(params.question.intent),
    intent: params.question.intent,
    retrievalUsed: matchedLayer,
    originalQuestion: params.question.originalQuestion,
    projectId: params.projectId,
    orgId: params.orgId,
    createdAt: new Date().toISOString(),
    fallbackUsed,
    handoffContext: params.handoffContext,
    actionableGap: upstreamGap ?? undefined,
  };
}

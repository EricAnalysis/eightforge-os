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
  RiskAssessment,
  RetrievalResult,
  Source,
  StructuredFact,
  SuggestedAction,
  ValidatorContext,
  ValidatorFinding,
} from '@/lib/ask/types';

const CEILING_FIELD_KEYS = new Set(['contract_ceiling', 'nte_amount']);
const BILLED_FIELD_KEYS = new Set([
  'billed_amount',
  'invoice_total',
  'total_amount',
  'current_amount_due',
]);
const CONTRACTOR_FIELD_KEYS = new Set(['contractor_name', 'vendor_name']);

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

function factSource(fact: StructuredFact): Source {
  return {
    type: 'fact',
    label: fact.page
      ? `${fact.documentName ?? 'Document'} · Page ${fact.page}`
      : fact.documentName ?? 'Structured fact',
    documentId: fact.extractedFrom,
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
  const billedFactsByDocument = new Map<string, StructuredFact>();

  for (const fact of reasoningFacts.filter((candidate) => isFactInSet(candidate, BILLED_FIELD_KEYS))) {
    const key = fact.extractedFrom || fact.id;
    const current = billedFactsByDocument.get(key);
    if (!current || fact.confidence > current.confidence) {
      billedFactsByDocument.set(key, fact);
    }
  }

  const billedFactSources = Array.from(billedFactsByDocument.values())
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

function sourceForRiskIssue(params: {
  issue: string;
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
}): Source | null {
  const finding = params.findings.find((candidate) => candidate.description === params.issue);
  if (finding) {
    return validatorSource(finding);
  }

  const decision = params.decisions.find((candidate) => candidate.title === params.issue);
  if (decision) {
    return decisionSource(decision);
  }

  return null;
}

function buildRiskAnswer(params: {
  question: ClassifiedQuestion;
  riskAssessments: RiskAssessment[];
  findings: ValidatorFinding[];
  decisions: DecisionRecord[];
}): {
  answer: string;
  sources: Source[];
  limitations: string[];
} | null {
  const topIssues = params.riskAssessments.slice(0, 3);
  const lead = topIssues[0];
  if (!lead) return null;

  const answer =
    params.question.originalQuestion.toLowerCase().includes('biggest issue')
      ? `The biggest issue is "${lead.issue}". ${lead.reasoning}.${topIssues[1] ? ` Next priorities are ${topIssues.slice(1).map((issue) => `"${issue.issue}"`).join(' and ')}.` : ''}`
      : `Start with "${lead.issue}". ${lead.reasoning}.${topIssues[1] ? ` After that, address ${topIssues.slice(1).map((issue) => `"${issue.issue}"`).join(' and ')}.` : ''}`;

  const sources = dedupeSources(
    topIssues
      .map((issue) =>
        sourceForRiskIssue({
          issue: issue.issue,
          findings: params.findings,
          decisions: params.decisions,
        }),
      )
      .filter((source): source is Source => source != null),
  ).slice(0, 3);

  return {
    answer,
    sources,
    limitations: [],
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

  if (params.facts[0]?.extractedFrom) {
    actions.push({
      type: 'view_document',
      label: 'View source document',
      target: params.facts[0].extractedFrom,
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

export function buildAskResponse(params: {
  question: ClassifiedQuestion;
  retrieval: RetrievalResult;
  project: AskProjectRecord;
  projectId: string;
  orgId: string;
}): AskResponse {
  const context = params.retrieval.rawData.validatorContext as ValidatorContext | undefined;
  const matchedLayer = params.retrieval.rawData.matchedLayer ?? 'documents';
  const riskAssessments = params.retrieval.rawData.riskAssessments as RiskAssessment[] | undefined;
  let answer = '';
  let sources: Source[] = [];
  let limitations: string[] = [];

  if (riskAssessments && riskAssessments.length > 0) {
    const riskAnswer = buildRiskAnswer({
      question: params.question,
      riskAssessments,
      findings: params.retrieval.validatorFindings,
      decisions: params.retrieval.decisions,
    });

    if (riskAnswer) {
      answer = riskAnswer.answer;
      sources = riskAnswer.sources;
      limitations = riskAnswer.limitations;
    }
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
        break;
    }
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

  return {
    answer,
    confidence,
    confidenceScore,
    sources,
    relationships:
      params.retrieval.relationships.length > 0
        ? params.retrieval.relationships
        : undefined,
    riskAssessments:
      riskAssessments && riskAssessments.length > 0
        ? riskAssessments
        : undefined,
    reasoning:
      riskAssessments && riskAssessments.length > 0
        ? 'Answer built by ranking validator findings and open decisions by severity, blocked status, exposure, and age.'
        : matchedLayer === 'relationships' && params.retrieval.relationships.length > 0
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
    limitations: limitations.length > 0 ? Array.from(new Set(limitations)) : undefined,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
    relatedQuestions: relatedQuestionsForIntent(params.question.intent),
    intent: params.question.intent,
    retrievalUsed: matchedLayer,
    originalQuestion: params.question.originalQuestion,
    projectId: params.projectId,
    orgId: params.orgId,
    createdAt: new Date().toISOString(),
    fallbackUsed: matchedLayer === 'documents' && params.retrieval.facts.length === 0 && params.retrieval.validatorFindings.length === 0 && params.retrieval.decisions.length === 0,
  };
}

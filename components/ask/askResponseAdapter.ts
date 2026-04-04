import type {
  AskConfidence,
  AskResponse,
  RetrievalUsed,
  Source,
  SourceType,
  SuggestedAction,
} from '@/lib/ask/types';
import { buildProjectDocumentHref } from '@/lib/documentNavigation';
import { getEvidenceDocumentUrl } from '@/lib/validator/evidenceNavigation';
import type { ValidationEvidence } from '@/types/validator';

export interface AskSourceViewModel {
  id: string;
  type: SourceType;
  typeLabel: string;
  title: string;
  detail: string;
  page?: number;
  snippet?: string;
  confidence: number;
  navigationLabel: string;
  navigationState: 'evidence' | 'page' | 'document' | 'disabled';
  isNavigable: boolean;
  href: string | null;
}

export interface AskActionViewModel {
  id: string;
  type: SuggestedAction['type'];
  label: string;
  href: string;
  tone: 'brand' | 'neutral';
}

export interface AskResponsePanelModel {
  answer: string;
  confidence: AskConfidence;
  confidenceScore: number;
  confidenceChipLabel: string;
  retrievalChipLabel: string;
  contextLine: string;
  sources: AskSourceViewModel[];
  actions: AskActionViewModel[];
  relatedQuestions: string[];
  reasoning?: string;
  assumptions: string[];
  limitations: string[];
  showReasoningByDefault: boolean;
}

interface ResponseContext {
  text: string;
  isCeiling: boolean;
  isContract: boolean;
  isMissing: boolean;
  isMissingCeiling: boolean;
  isBlocked: boolean;
  isValidator: boolean;
  isDocument: boolean;
  isDecision: boolean;
  isActionNeeded: boolean;
  isStatus: boolean;
  isInvoice: boolean;
}

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  fact: 'Fact',
  validator: 'Validator',
  decision: 'Decision',
  document: 'Document',
  calculation: 'Calc',
};

const SOURCE_CONTEXT_LABELS: Record<SourceType, string> = {
  fact: 'Structured fact',
  validator: 'Validator',
  decision: 'Decision',
  document: 'Document',
  calculation: 'Calculation',
};

const RETRIEVAL_LABELS: Record<RetrievalUsed, string> = {
  facts: 'Structured fact',
  validator: 'Validator',
  decisions: 'Decision queue',
  relationships: 'Cross-document',
  documents: 'Document derived',
};

function normalizeText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePositivePage(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function fieldKeyFromFactId(factId?: string | null): string | null {
  const normalizedFactId = normalizeText(factId);
  if (!normalizedFactId) return null;

  const separatorIndex = normalizedFactId.indexOf(':');
  if (separatorIndex < 0 || separatorIndex === normalizedFactId.length - 1) {
    return null;
  }

  return normalizeText(normalizedFactId.slice(separatorIndex + 1));
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinEvidenceLabels(labels: string[]): string {
  if (labels.length === 0) return 'Persisted project evidence';
  if (labels.length === 1) return `${labels[0]} evidence`;
  if (labels.length === 2) return `${labels[0]} + ${labels[1]} evidence`;
  return `${labels[0]} + ${labels.length - 1} more evidence sources`;
}

function normalizeQuestion(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/[?.!]+$/g, '').toLowerCase();
}

function sourceHref(projectId: string, source: Source): string | null {
  const navigation = sourceNavigation(projectId, source);
  return navigation.href;
}

function sourceNavigation(projectId: string, source: Source): {
  href: string | null;
  navigationLabel: string;
  navigationState: AskSourceViewModel['navigationState'];
  isNavigable: boolean;
} {
  const documentId = normalizeText(source.documentId);
  if (!documentId) {
    return {
      href: null,
      navigationLabel: 'Unavailable',
      navigationState: 'disabled',
      isNavigable: false,
    };
  }

  const page = normalizePositivePage(source.page);
  const factId = normalizeText(source.factId);
  const anchorId = normalizeText(source.anchorId);
  const fieldKey = fieldKeyFromFactId(factId);
  const evidence: ValidationEvidence = {
    id: anchorId ?? factId ?? `${source.type}:${documentId}:${page ?? 'none'}`,
    finding_id: 'ask-source',
    evidence_type: anchorId || factId ? 'anchored_evidence' : 'document_reference',
    source_document_id: documentId,
    source_page: page,
    fact_id: factId,
    record_id: anchorId,
    field_name: fieldKey,
    field_value: normalizeText(source.snippet),
    note: normalizeText(source.snippet),
    created_at: source.timestamp,
  };

  if ((anchorId || factId) && page != null) {
    const href = getEvidenceDocumentUrl({
      projectId,
      evidence,
    });

    if (href) {
      return {
        href,
        navigationLabel: 'View Evidence',
        navigationState: 'evidence',
        isNavigable: true,
      };
    }
  }

  if (page != null) {
    const href = getEvidenceDocumentUrl({
      projectId,
      evidence,
    });

    if (href) {
      return {
        href,
        navigationLabel: 'View Page',
        navigationState: 'page',
        isNavigable: true,
      };
    }
  }

  return {
    href: buildProjectDocumentHref(documentId, projectId),
    navigationLabel: 'Open Document',
    navigationState: 'document',
    isNavigable: true,
  };
}

function actionHref(
  projectId: string,
  type: SuggestedAction['type'],
  target?: string,
): string | null {
  if (type === 'view_document') {
    const documentId = normalizeText(target);
    return documentId ? buildProjectDocumentHref(documentId, projectId) : null;
  }

  if (type === 'resolve_decision') {
    const decisionId = normalizeText(target);
    return decisionId
      ? `/platform/decisions/${decisionId}`
      : `/platform/projects/${projectId}#project-decisions`;
  }

  if (type === 'upload_document') {
    return `/platform/documents?projectId=${encodeURIComponent(projectId)}&openUpload=1`;
  }

  if (type === 'create_decision') {
    return `/platform/projects/${projectId}#project-decisions`;
  }

  if (type === 'assign_action') {
    return `/platform/projects/${projectId}#project-actions`;
  }

  if (type === 'check_validator' || type === 'review_validator') {
    return `/platform/projects/${projectId}#project-validator`;
  }

  return null;
}

function buildContextLine(response: AskResponse): string {
  const labels = Array.from(
    new Set(
      response.sources
        .map((source) => SOURCE_CONTEXT_LABELS[source.type])
        .filter(Boolean),
    ),
  );

  const confidenceLabel = sentenceCase(response.confidence);
  const evidenceLabel = response.fallbackUsed
    ? 'Document fallback evidence'
    : joinEvidenceLabels(labels);

  return `${confidenceLabel} confidence - ${evidenceLabel}`;
}

function sourceDetail(source: Source): string {
  const detailParts: string[] = [];

  if (source.documentName && source.documentName !== source.label) {
    detailParts.push(source.documentName);
  }

  if (source.page) {
    detailParts.push(`Page ${source.page}`);
  }

  if (detailParts.length === 0) {
    detailParts.push(`${source.confidence}% confidence`);
  }

  return detailParts.join(' / ');
}

function sourceSearchText(source: Source): string {
  return [
    source.type,
    source.label,
    source.documentName,
    source.snippet,
    source.factId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function isContractSource(source: Source): boolean {
  return includesAny(sourceSearchText(source), ['contract', 'agreement']);
}

function isCeilingSource(source: Source): boolean {
  return includesAny(sourceSearchText(source), ['ceiling', 'not to exceed']);
}

function analyzeResponse(response: AskResponse): ResponseContext {
  const text = [
    response.originalQuestion,
    response.answer,
    response.reasoning,
    ...(response.limitations ?? []),
    ...response.sources.map((source) =>
      [source.label, source.documentName, source.snippet, source.factId]
        .filter(Boolean)
        .join(' '),
    ),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const isCeiling = includesAny(text, ['ceiling', 'not to exceed']);
  const isContract = isCeiling || includesAny(text, ['contract']);
  const isMissing = response.intent === 'missing_data'
    || includesAny(text, [
      'missing',
      'not found',
      'no matching',
      'incomplete',
      "can't answer",
      'cannot answer',
      "don't see",
      'do not see',
      'not available',
      'upload',
    ]);
  const isValidator = response.intent === 'validator_question'
    || response.retrievalUsed === 'validator'
    || includesAny(text, ['validator', 'finding', 'findings']);
  const isBlocked = isValidator
    || includesAny(text, ['blocked', 'blocking', 'critical finding', 'flagged']);
  const isDocument = response.intent === 'document_lookup'
    || response.retrievalUsed === 'documents'
    || response.sources.some((source) => source.type === 'document');
  const isDecision = response.retrievalUsed === 'decisions'
    || includesAny(text, ['decision', 'queue']);
  const isActionNeeded = response.intent === 'action_needed';
  const isStatus = response.intent === 'status_check';
  const isInvoice = includesAny(text, ['invoice', 'invoices', 'invoiced', 'billed', 'billing']);

  return {
    text,
    isCeiling,
    isContract,
    isMissing,
    isMissingCeiling: isMissing && isCeiling,
    isBlocked,
    isValidator,
    isDocument,
    isDecision,
    isActionNeeded,
    isStatus,
    isInvoice,
  };
}

function findSource(
  response: AskResponse,
  predicate: (source: Source) => boolean,
): Source | undefined {
  return response.sources.find(predicate);
}

function findPrimaryDocumentSource(response: AskResponse): Source | undefined {
  return findSource(response, (source) => Boolean(source.documentId))
    ?? findSource(response, (source) => source.type === 'document');
}

function makeSourceAction(
  projectId: string,
  source: Source | undefined,
  label: string,
  tone: 'brand' | 'neutral' = 'neutral',
): AskActionViewModel | null {
  if (!source) return null;

  const href = sourceHref(projectId, source);
  if (!href) return null;

  return {
    id: `source:${source.type}:${source.documentId ?? source.label}:${label}`,
    type: 'view_document',
    label,
    href,
    tone,
  };
}

function makeRouteAction(
  projectId: string,
  type: SuggestedAction['type'],
  label: string,
  target?: string,
  tone: 'brand' | 'neutral' = 'neutral',
): AskActionViewModel | null {
  const href = actionHref(projectId, type, target);
  if (!href) return null;

  return {
    id: `route:${type}:${target ?? label}`,
    type,
    label,
    href,
    tone,
  };
}

function mappedBackendAction(
  projectId: string,
  action: SuggestedAction,
  context: ResponseContext,
): AskActionViewModel | null {
  switch (action.type) {
    case 'upload_document':
      return context.isMissing
        ? makeRouteAction(
          projectId,
          action.type,
          context.isContract || context.isCeiling ? 'Upload Contract' : 'Upload Missing Document',
          action.target,
        )
        : null;
    case 'create_decision':
      return makeRouteAction(
        projectId,
        action.type,
        context.isCeiling ? 'Set Ceiling' : 'Create Decision',
        action.target,
      );
    case 'check_validator':
    case 'review_validator':
      return context.isBlocked || context.isMissing || context.isValidator
        ? makeRouteAction(projectId, action.type, 'Open Validator', action.target)
        : null;
    case 'assign_action':
      return context.isActionNeeded || context.isDecision || context.isStatus
        ? makeRouteAction(projectId, action.type, 'Open Work Queue', action.target)
        : null;
    case 'resolve_decision':
      return context.isActionNeeded || context.isDecision || context.isCeiling || context.isBlocked
        ? makeRouteAction(
          projectId,
          action.type,
          context.isCeiling && context.isMissing ? 'Set Ceiling' : 'Review Decision',
          action.target,
        )
        : null;
    case 'view_document':
      return context.isDocument || context.isContract || context.isCeiling || context.isBlocked
        ? makeRouteAction(
          projectId,
          action.type,
          context.isContract || context.isCeiling ? 'View Contract' : 'View Document',
          action.target,
        )
        : null;
    default:
      return null;
  }
}

function buildActions(
  response: AskResponse,
  projectId: string,
  context: ResponseContext,
): AskActionViewModel[] {
  const actions: AskActionViewModel[] = [];
  const seen = new Set<string>();
  const backendActions = response.suggestedActions ?? [];

  const contractSource = findSource(
    response,
    (source) => Boolean(source.documentId) && (isContractSource(source) || isCeilingSource(source)),
  );
  const validatorEvidenceSource = findSource(
    response,
    (source) => source.type === 'validator' && Boolean(source.documentId),
  );
  const primaryDocumentSource = findPrimaryDocumentSource(response);
  const decisionAction = backendActions.find((action) => action.type === 'resolve_decision');
  const workQueueAction = backendActions.find((action) => action.type === 'assign_action');

  function push(action: AskActionViewModel | null) {
    if (!action || actions.length >= 3) return;
    const key = action.href;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  }

  if (context.isMissingCeiling) {
    push(makeRouteAction(projectId, 'upload_document', 'Upload Contract', undefined, 'brand'));
    push(makeRouteAction(projectId, 'create_decision', 'Set Ceiling'));
    push(makeRouteAction(projectId, 'review_validator', 'Open Validator'));
    return actions;
  }

  if (context.isBlocked) {
    push(makeRouteAction(projectId, 'review_validator', 'Open Validator', undefined, 'brand'));
    push(
      makeSourceAction(
        projectId,
        validatorEvidenceSource ?? primaryDocumentSource,
        validatorEvidenceSource ? 'View Finding' : 'View Evidence',
      ),
    );
    push(
      decisionAction
        ? makeRouteAction(projectId, 'resolve_decision', 'Review Decision', decisionAction.target)
        : makeRouteAction(projectId, 'assign_action', 'Open Work Queue', workQueueAction?.target),
    );
  }

  if (context.isCeiling || context.isDocument || context.isContract) {
    push(
      makeSourceAction(
        projectId,
        contractSource ?? primaryDocumentSource,
        context.isContract || context.isCeiling ? 'View Contract' : 'View Document',
        actions.length === 0 ? 'brand' : 'neutral',
      ),
    );

    if (context.isMissing && !context.isMissingCeiling) {
      push(
        makeRouteAction(
          projectId,
          'upload_document',
          context.isContract || context.isCeiling ? 'Upload Contract' : 'Upload Missing Document',
        ),
      );
    }

    if (context.isBlocked || context.isValidator) {
      push(makeRouteAction(projectId, 'review_validator', 'Open Validator'));
    }
  }

  if (context.isActionNeeded || context.isDecision || context.isStatus) {
    push(
      decisionAction
        ? makeRouteAction(
          projectId,
          'resolve_decision',
          context.isCeiling && context.isMissing ? 'Set Ceiling' : 'Review Decision',
          decisionAction.target,
          actions.length === 0 ? 'brand' : 'neutral',
        )
        : makeRouteAction(
          projectId,
          'assign_action',
          'Open Work Queue',
          workQueueAction?.target,
          actions.length === 0 ? 'brand' : 'neutral',
        ),
    );

    if (context.isBlocked || context.isValidator) {
      push(makeRouteAction(projectId, 'review_validator', 'Open Validator'));
    }

    if (!context.isBlocked) {
      push(
        makeSourceAction(
          projectId,
          contractSource ?? primaryDocumentSource,
          context.isContract ? 'View Contract' : 'View Document',
        ),
      );
    }
  }

  for (const action of backendActions) {
    push(mappedBackendAction(projectId, action, context));
  }

  if (actions.length === 0) {
    push(
      makeSourceAction(
        projectId,
        contractSource ?? primaryDocumentSource,
        context.isContract || context.isCeiling ? 'View Contract' : 'View Document',
        'brand',
      ),
    );
    push(makeRouteAction(projectId, 'review_validator', 'Open Validator', undefined, 'brand'));
    push(makeRouteAction(projectId, 'assign_action', 'Open Work Queue', undefined, 'brand'));
  }

  return actions.slice(0, 3);
}

function buildFollowups(response: AskResponse, context: ResponseContext): string[] {
  const followups: string[] = [];
  const seen = new Set<string>();

  function push(question: string) {
    const normalized = normalizeQuestion(question);
    if (!normalized || seen.has(normalized) || followups.length >= 4) return;
    seen.add(normalized);
    followups.push(question.trim().replace(/\s+/g, ' '));
  }

  if (context.isMissingCeiling) {
    push('Where is the ceiling defined?');
    push('What should I upload to set the ceiling?');
    push('What happens if ceiling is exceeded?');
    push('What should I fix first?');
  } else if (context.isCeiling || context.isInvoice) {
    push('Are invoices over the ceiling?');
    push('Where is the ceiling defined?');
    push('What happens if ceiling is exceeded?');
    push('What is remaining under the ceiling?');
  } else if (context.isBlocked || context.isValidator) {
    push('What is missing?');
    push('What should I fix first?');
    push('Which finding is blocking progress?');
    push('What decision is blocked?');
  } else if (context.isMissing) {
    push('What is missing?');
    push('Which document should I upload?');
    push('Why is this blocking the project?');
    push('What should I fix first?');
  } else if (context.isDocument) {
    if (context.isContract) {
      push('Where is the ceiling defined?');
    }
    push('What facts were extracted from this document?');
    push('Why does this document matter?');
    push('What should I do next?');
  } else if (context.isActionNeeded || context.isDecision) {
    push('What should I fix first?');
    push('What decision is pending?');
    push('What evidence supports that action?');
    push('What is still blocking progress?');
  } else if (context.isStatus) {
    push('Why is this project blocked?');
    push('What decisions are pending?');
    push('What is missing?');
    push('What should I do next?');
  }

  for (const question of response.relatedQuestions ?? []) {
    push(question);
  }

  return followups.slice(0, 4);
}

export function adaptAskResponseForPanel(
  response: AskResponse,
  projectId: string,
): AskResponsePanelModel {
  const context = analyzeResponse(response);

  return {
    answer: response.answer,
    confidence: response.confidence,
    confidenceScore: response.confidenceScore,
    confidenceChipLabel: response.confidence.toUpperCase(),
    retrievalChipLabel: RETRIEVAL_LABELS[response.retrievalUsed],
    contextLine: buildContextLine(response),
    sources: response.sources.map((source, index) => {
      const navigation = sourceNavigation(projectId, source);

      return {
        id: `${source.type}:${source.label}:${index}`,
        type: source.type,
        typeLabel: SOURCE_TYPE_LABELS[source.type],
        title: source.label,
        detail: sourceDetail(source),
        page: source.page,
        snippet: normalizeText(source.snippet) ?? undefined,
        confidence: source.confidence,
        navigationLabel: navigation.navigationLabel,
        navigationState: navigation.navigationState,
        isNavigable: navigation.isNavigable,
        href: navigation.href,
      };
    }),
    actions: buildActions(response, projectId, context),
    relatedQuestions: buildFollowups(response, context),
    reasoning: normalizeText(response.reasoning) ?? undefined,
    assumptions: response.assumptions ?? [],
    limitations: response.limitations ?? [],
    showReasoningByDefault: response.confidence === 'low',
  };
}

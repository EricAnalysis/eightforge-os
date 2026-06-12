// ASK ROUTER - deterministic classification only. No LLM calls, truth creation, or selector computation.
import {
  INTENT_CLASSIFICATION_MAP,
  INTENT_GROUP_LABELS,
  type IntentGroup,
} from '@/lib/ask/router/intentClassificationMap';

export type RouterResult =
  | { intent: IntentGroup; confidence: 'high' | 'medium'; surface: 'project' | 'portfolio' }
  | { intent: 'ambiguous'; confidence: 'low'; candidates: IntentGroup[]; clarificationPrompt: string };

const PROJECT_INTENT_GROUPS: IntentGroup[] = [
  'approval_execution_state',
  'invoice_support',
  'contract_authority',
  'ticket_validation',
  'review_audit_state',
  'portfolio_project_status',
];

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9$\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(normalized: string): Set<string> {
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

function scoreIntentGroup(query: string, group: IntentGroup): number {
  const tokens = queryTokens(query);
  return INTENT_CLASSIFICATION_MAP[group].reduce((score, signal) => {
    const keywordScore = signal.keywords.reduce(
      (sum, keyword) => sum + (tokens.has(normalizeQuery(keyword)) ? signal.weight : 0),
      0,
    );
    const phraseScore = signal.phrases.reduce(
      (sum, phrase) => sum + (query.includes(normalizeQuery(phrase)) ? signal.weight : 0),
      0,
    );
    return score + keywordScore + phraseScore;
  }, 0);
}

function clarificationPrompt(candidates: IntentGroup[]): string {
  const lines = candidates.map((candidate) => {
    const label = INTENT_GROUP_LABELS[candidate];
    return `  ${label.label}: e.g. ${label.example}`;
  });
  return [
    'Your question could relate to:',
    ...lines,
    'Which are you asking about?',
  ].join('\n');
}

export function classifyQueryIntent(
  query: string,
  surface: 'project' | 'portfolio',
): RouterResult {
  const normalized = normalizeQuery(query);

  if (surface === 'portfolio') {
    return {
      intent: 'portfolio_project_status',
      confidence: scoreIntentGroup(normalized, 'portfolio_project_status') > 0 ? 'high' : 'medium',
      surface,
    };
  }

  const scores = PROJECT_INTENT_GROUPS
    .map((intent) => ({ intent, score: scoreIntentGroup(normalized, intent) }))
    .sort((left, right) => right.score - left.score);
  const top = scores[0];
  const second = scores[1];

  if (!top || top.score === 0 || (second && top.score <= second.score)) {
    const candidates = scores.slice(0, 2).map((score) => score.intent);
    return {
      intent: 'ambiguous',
      confidence: 'low',
      candidates,
      clarificationPrompt: clarificationPrompt(candidates),
    };
  }

  return {
    intent: top.intent,
    confidence: second && top.score >= 2 && top.score >= second.score * 2 ? 'high' : 'medium',
    surface,
  };
}

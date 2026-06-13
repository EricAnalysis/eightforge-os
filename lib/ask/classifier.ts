import type { AskConfidence, ClassifiedQuestion, QuestionIntent } from '@/lib/ask/types';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'do',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'show',
  'tell',
  'the',
  'this',
  'to',
  'we',
  'what',
  'where',
  'which',
  'why',
  'with',
]);

const BLOCKER_TERMS = [
  'blocked',
  'blocking',
  'blocker',
  'error',
  'errors',
  'fail',
  'failed',
  'failing',
  'finding',
  'findings',
  'issue',
  'issues',
  'problem',
  'stuck',
  'validator',
];

const MISSING_TERMS = [
  'missing',
  'where is',
  'where are',
  'not found',
  'absent',
  'lack',
  'lacking',
];

const DOCUMENT_LOOKUP_TERMS = [
  'show me',
  'find',
  'open',
  'view',
  'locate',
  'pull up',
];

const STATUS_TERMS = [
  'status',
  'how are we',
  'where do we stand',
  'standing',
  'health',
  'overview',
  'summary',
  'processed',
  'pending',
];

const ACTION_TERMS = [
  'should i',
  'what should i',
  'what do i',
  'what do we',
  'next step',
  'next action',
  'what needs attention',
];

const FACT_TERMS = [
  'what is',
  "what's",
  'tell me about',
  'how much',
  'who is',
  'when is',
];

function normalizeQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9$%/._ -]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function extractKeywords(question: string): string[] {
  return Array.from(
    new Set(
      normalizeQuestion(question)
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  ).slice(0, 12);
}

function classifyFromRules(normalized: string): {
  intent: QuestionIntent;
  confidence: AskConfidence;
} {
  if ((normalized.startsWith('why') || normalized.includes(' why ')) && includesAny(normalized, BLOCKER_TERMS)) {
    return { intent: 'validator_question', confidence: 'high' };
  }

  if (includesAny(normalized, MISSING_TERMS)) {
    return {
      intent: 'missing_data',
      confidence: normalized.includes('missing') ? 'high' : 'medium',
    };
  }

  if (includesAny(normalized, DOCUMENT_LOOKUP_TERMS)) {
    return { intent: 'document_lookup', confidence: 'high' };
  }

  if (includesAny(normalized, STATUS_TERMS)) {
    return { intent: 'status_check', confidence: 'high' };
  }

  if (includesAny(normalized, ACTION_TERMS)) {
    return { intent: 'action_needed', confidence: 'high' };
  }

  if (includesAny(normalized, BLOCKER_TERMS)) {
    return { intent: 'validator_question', confidence: 'medium' };
  }

  if (includesAny(normalized, FACT_TERMS)) {
    return { intent: 'fact_question', confidence: 'high' };
  }

  if (
    normalized.includes('amount')
    || normalized.includes('ceiling')
    || normalized.includes('contract')
    || normalized.includes('invoice')
    || normalized.includes('decision')
    || normalized.includes('document')
  ) {
    return { intent: 'fact_question', confidence: 'medium' };
  }

  return { intent: 'unknown', confidence: 'low' };
}

export function classifyQuestion(question: string): ClassifiedQuestion {
  const normalized = normalizeQuestion(question);
  const keywords = extractKeywords(question);
  const { intent, confidence } = classifyFromRules(normalized);

  return {
    intent,
    confidence,
    keywords,
    originalQuestion: question.trim(),
  };
}

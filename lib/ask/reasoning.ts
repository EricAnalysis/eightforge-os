import type {
  AskRelationship,
  CeilingVsBilledRelationship,
  ClassifiedQuestion,
  ContractorMismatchRelationship,
  DecisionRecord,
  StructuredFact,
} from '@/lib/ask/types';

export type AskReasoningCase = 'ceiling_vs_billed' | 'contractor_mismatch';

const CEILING_FIELD_KEYS = new Set(['contract_ceiling', 'nte_amount']);
const BILLED_FIELD_KEYS = new Set([
  'billed_amount',
  'invoice_total',
  'total_amount',
  'current_amount_due',
]);
const CONTRACTOR_FIELD_KEYS = new Set(['contractor_name', 'vendor_name']);

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9$%/. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function questionText(question: ClassifiedQuestion): string {
  return normalizeText([question.originalQuestion, ...question.keywords].join(' '));
}

function numericValue(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[$,]/g, '').trim();
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalFieldKey(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function factKey(fact: StructuredFact): string {
  return canonicalFieldKey(fact.fieldKey ?? fact.label);
}

function isFactInSet(fact: StructuredFact, allowedKeys: Set<string>): boolean {
  const key = factKey(fact);
  return allowedKeys.has(key);
}

function chooseBestFact(facts: StructuredFact[]): StructuredFact | null {
  if (facts.length === 0) return null;

  return [...facts].sort((left, right) => {
    const confidenceDelta = right.confidence - left.confidence;
    if (confidenceDelta !== 0) return confidenceDelta;
    return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
  })[0] ?? null;
}

function sumBilledFacts(facts: StructuredFact[]): number | null {
  if (facts.length === 0) return null;

  const bestByDocument = new Map<string, StructuredFact>();

  for (const fact of facts) {
    const key = fact.extractedFrom || fact.id;
    const current = bestByDocument.get(key);
    if (!current || fact.confidence > current.confidence) {
      bestByDocument.set(key, fact);
    }
  }

  const values = Array.from(bestByDocument.values())
    .map((fact) => numericValue(fact.value))
    .filter((value): value is number => value != null);

  if (values.length === 0) return null;

  return values.reduce((sum, value) => sum + value, 0);
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
    const numeric = numericValue(
      typeof value === 'number' || typeof value === 'string' ? value : null,
    );
    if (numeric != null) {
      return numeric;
    }
  }

  return null;
}

function contractorDisplayName(fact: StructuredFact): string | null {
  if (typeof fact.value !== 'string' || fact.value.trim().length === 0) return null;
  return fact.value.trim();
}

function canonicalContractorName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,/&()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCeilingVsBilledRelationship(params: {
  facts: StructuredFact[];
  decisions: DecisionRecord[];
}): CeilingVsBilledRelationship | null {
  const ceilingFact = chooseBestFact(
    params.facts.filter((fact) => isFactInSet(fact, CEILING_FIELD_KEYS)),
  );
  const ceiling = ceilingFact ? numericValue(ceilingFact.value) : null;
  if (ceiling == null) return null;

  const billedFromFacts = sumBilledFacts(
    params.facts.filter((fact) => isFactInSet(fact, BILLED_FIELD_KEYS)),
  );
  const billedFromDecisions = params.decisions
    .map(decisionAmount)
    .filter((value): value is number => value != null)
    .reduce<number | null>((sum, value) => (sum == null ? value : sum + value), null);

  const billed = billedFromFacts ?? billedFromDecisions;
  if (billed == null) return null;

  const delta = Math.abs(billed - ceiling);
  const status = billed > ceiling ? 'over' : 'within';

  return {
    type: 'ceiling_vs_billed',
    ceiling,
    billed,
    delta,
    status,
    message:
      status === 'over'
        ? `Total billed is ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: delta >= 1000 ? 0 : 2 }).format(billed)} against a contract ceiling of ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: ceiling >= 1000 ? 0 : 2 }).format(ceiling)}, so the project is over the ceiling by ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: delta >= 1000 ? 0 : 2 }).format(delta)}.`
        : `Total billed is ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: billed >= 1000 ? 0 : 2 }).format(billed)} against a contract ceiling of ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: ceiling >= 1000 ? 0 : 2 }).format(ceiling)}, so the project is within the ceiling by ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: delta >= 1000 ? 0 : 2 }).format(delta)}.`,
  };
}

function buildContractorMismatchRelationship(params: {
  facts: StructuredFact[];
}): ContractorMismatchRelationship | null {
  const contractorFacts = params.facts.filter((fact) => isFactInSet(fact, CONTRACTOR_FIELD_KEYS));
  if (contractorFacts.length === 0) return null;

  const namesByCanonical = new Map<string, string>();

  for (const fact of contractorFacts) {
    const displayName = contractorDisplayName(fact);
    if (!displayName) continue;

    const canonical = canonicalContractorName(displayName);
    if (!canonical) continue;

    if (!namesByCanonical.has(canonical)) {
      namesByCanonical.set(canonical, displayName);
    }
  }

  const names = Array.from(namesByCanonical.values());
  if (names.length === 0) return null;

  const conflict = names.length > 1;

  return {
    type: 'contractor_mismatch',
    names,
    conflict,
    message: conflict
      ? `Contractor names conflict across project documents: ${names.join(', ')}.`
      : `Contractor names are consistent across project documents: ${names[0]}.`,
  };
}

export function detectReasoningCase(question: ClassifiedQuestion): AskReasoningCase | null {
  const text = questionText(question);

  if (
    includesAny(text, ['contractor', 'vendor', 'payee'])
    && includesAny(text, ['conflict', 'conflicting', 'mismatch', 'different', 'differ', 'inconsistent'])
  ) {
    return 'contractor_mismatch';
  }

  if (
    includesAny(text, ['ceiling', 'not to exceed', 'nte'])
    && includesAny(text, ['invoice', 'invoices', 'billed', 'billing', 'over', 'exceed', 'exceeds', 'above'])
  ) {
    return 'ceiling_vs_billed';
  }

  return null;
}

export function buildAskRelationships(params: {
  question: ClassifiedQuestion;
  facts: StructuredFact[];
  decisions: DecisionRecord[];
}): AskRelationship[] {
  const reasoningCase = detectReasoningCase(params.question);
  if (!reasoningCase) return [];

  if (reasoningCase === 'ceiling_vs_billed') {
    const relationship = buildCeilingVsBilledRelationship({
      facts: params.facts,
      decisions: params.decisions,
    });

    return relationship ? [relationship] : [];
  }

  const relationship = buildContractorMismatchRelationship({
    facts: params.facts,
  });

  return relationship ? [relationship] : [];
}

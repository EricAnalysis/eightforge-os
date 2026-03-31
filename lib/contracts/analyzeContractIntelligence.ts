import { CLAUSE_PATTERN_LIBRARY_V1_BY_ID } from '@/lib/contracts/clausePatternLibrary.v1';
import { LANGUAGE_ENGINE_FIELDS_V1_BY_ID } from '@/lib/contracts/languageEngineFields.v1';
import {
  CLAUSE_PATTERN_LIBRARY_VERSION_V1,
  COVERAGE_LIBRARY_VERSION_V1,
  LANGUAGE_ENGINE_FIELDS_VERSION_V1,
} from '@/lib/contracts/types';
import type {
  ContractAnalysisResult,
  ContractCriticality,
  ContractDocumentTypeProfile,
  ContractFieldAnalysis,
  ContractFieldId,
  ContractFieldState,
  DetectedClausePattern,
} from '@/lib/contracts/types';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { NormalizedNodeDocument } from '@/lib/pipeline/types';
import { buildContractIssues } from '@/lib/server/buildContractIssues';
import { evaluateContractCoverage } from '@/lib/server/evaluateContractCoverage';

type AnalyzeContractIntelligenceInput = {
  primaryDocument: NormalizedNodeDocument;
  relatedDocuments: NormalizedNodeDocument[];
};

type FieldFamilies = Pick<
  ContractAnalysisResult,
  | 'contract_identity'
  | 'term_model'
  | 'activation_model'
  | 'scope_model'
  | 'pricing_model'
  | 'documentation_model'
  | 'compliance_model'
  | 'payment_model'
>;

type PatternDetectionContext = {
  document: NormalizedNodeDocument;
  text: string;
  normalizedText: string;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePatternSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeIdentityValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(inc|incorporated|llc|corp|corporation|co|company|ltd)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceText(evidence: EvidenceObject): string {
  return normalizeWhitespace(
    [
      evidence.text,
      typeof evidence.value === 'string' ? evidence.value : null,
      evidence.location.nearby_text,
      evidence.location.label,
      evidence.location.section,
      evidence.description,
    ]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' '),
  );
}

function summarizeEvidenceAnchor(evidence: EvidenceObject | undefined): string | null {
  if (!evidence) return null;
  const snippet = normalizeWhitespace(
    evidence.text
      ?? evidence.location.nearby_text
      ?? evidence.location.label
      ?? evidence.description
      ?? '',
  ).slice(0, 140);
  if (!snippet) return null;
  const pagePrefix = evidence.location.page ? `p.${evidence.location.page} ` : '';
  return `${pagePrefix}${snippet}`;
}

function findEvidenceIdsByRegex(document: NormalizedNodeDocument, regex: RegExp): string[] {
  const ids = new Set<string>();
  const flags = regex.flags.replace(/g/g, '');
  for (const evidence of document.evidence) {
    const text = evidenceText(evidence);
    if (!text) continue;
    if (new RegExp(regex.source, flags).test(text)) {
      ids.add(evidence.id);
    }
  }
  return [...ids];
}

function findEvidenceIdsByRegexes(document: NormalizedNodeDocument, regexes: RegExp[]): string[] {
  return uniqueStrings(regexes.flatMap((regex) => findEvidenceIdsByRegex(document, regex)));
}

function findEvidenceIdsByPhrases(document: NormalizedNodeDocument, phrases: string[]): string[] {
  const lowered = phrases.map((phrase) => normalizePatternSearchText(phrase));
  const ids = new Set<string>();
  for (const evidence of document.evidence) {
    const text = normalizePatternSearchText(evidenceText(evidence));
    if (!text) continue;
    if (lowered.some((phrase) => text.includes(phrase))) {
      ids.add(evidence.id);
    }
  }
  return [...ids];
}

function parseNumberWord(token: string): number | null {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const dictionary: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    twenty: 20,
    thirty: 30,
    sixty: 60,
    seventytwo: 72,
    seventy: 70,
    ninety: 90,
    hundred: 100,
  };
  return dictionary[normalized] ?? null;
}

function extractDurationToken(
  text: string,
): { amount: number; unit: 'day' | 'month' | 'year' | 'hour'; label: string } | null {
  const match = /\b(?:within|for|term of|period of|initial term of)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|sixty|seventy[-\s]?two|ninety|hundred)\s*(?:\(\s*\d+\s*\))?\s*(day|days|month|months|year|years|hour|hours)\b/i.exec(
    normalizeWhitespace(text),
  );
  if (!match?.[1] || !match[2]) return null;
  const amount = parseNumberWord(match[1]);
  if (!amount) return null;
  const unitToken = match[2].toLowerCase();
  const unit =
    unitToken.startsWith('day') ? 'day' :
    unitToken.startsWith('month') ? 'month' :
    unitToken.startsWith('year') ? 'year' :
    'hour';
  return {
    amount,
    unit,
    label: `${amount} ${unit}${amount === 1 ? '' : 's'}`,
  };
}

function findFirstRegexValue(document: NormalizedNodeDocument, regexes: RegExp[]): {
  value: string | null;
  evidenceAnchors: string[];
} {
  for (const regex of regexes) {
    const match = regex.exec(document.text_preview);
    if (match?.[1]) {
      return {
        value: normalizeWhitespace(match[1]),
        evidenceAnchors: findEvidenceIdsByRegex(document, regex),
      };
    }
  }
  return { value: null, evidenceAnchors: [] };
}

function determineDocumentTypeProfile(
  document: NormalizedNodeDocument,
): ContractDocumentTypeProfile | null {
  const type = (document.document_type ?? '').toLowerCase();
  const textLower = document.text_preview.toLowerCase();
  const debrisLike =
    /\bdebris\b|\bvegetative\b|\bstump\b|\bdemolition\b|\bhazard(?:ous)?\b|\bwaterway\b|\bright[- ]of[- ]way\b|\breduction site\b|\bdms\b/.test(
      textLower,
    );
  const disasterLike =
    /\bemergency\b|\bdisaster\b|\bfema\b|\bstorm\b|\bhurricane\b|\bdeclared event\b|\bdeclaration\b/.test(
      textLower,
    ) || document.section_signals.fema_reference_present === true;

  if (type.includes('contract') && (debrisLike || disasterLike)) {
    return 'fema_disaster_recovery_debris_contract';
  }
  if (debrisLike && disasterLike) {
    return 'fema_disaster_recovery_debris_contract';
  }
  return null;
}

function buildPatternMatch(
  patternId: string,
  input: {
    confidence: number;
    evidenceAnchors: string[];
    semanticSlots?: Record<string, unknown>;
    matchedPhrases?: string[];
    conflict?: boolean;
  },
): DetectedClausePattern | null {
  const definition = CLAUSE_PATTERN_LIBRARY_V1_BY_ID.get(patternId);
  if (!definition) return null;
  return {
    pattern_id: definition.pattern_id,
    pattern_name: definition.pattern_name,
    family: definition.family,
    confidence: input.confidence,
    evidence_anchors: uniqueStrings(input.evidenceAnchors),
    semantic_slots: input.semanticSlots ?? {},
    matched_phrases: uniqueStrings(input.matchedPhrases ?? []),
    conflict: input.conflict ?? false,
  };
}

function detectExecutionBasedTerm(ctx: PatternDetectionContext): DetectedClausePattern | null {
  const duration = extractDurationToken(ctx.text);
  if (!duration) return null;
  const executionLike =
    /\b(term|initial term|agreement)[^.]{0,120}?(?:from|after)\s+(?:the\s+date\s+of\s+)?(?:execution|effective)\b/i.test(
      ctx.text,
    ) || /\beffective\s+for\b/i.test(ctx.text);
  if (!executionLike) return null;

  const anchorBasis =
    /\bfrom\s+(?:the\s+date\s+of\s+)?effective\b/i.test(ctx.text)
      ? 'effective_date'
      : 'executed_date';
  return buildPatternMatch('execution_based_term', {
    confidence: 0.84,
    evidenceAnchors: uniqueStrings([
      ...findEvidenceIdsByRegex(ctx.document, /(?:term|initial term|agreement)[^.]{0,120}?(?:from|after)\s+(?:the\s+date\s+of\s+)?(?:execution|effective)/i),
      ...findEvidenceIdsByRegex(ctx.document, /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|sixty|seventy[-\s]?two|ninety)\s+(?:day|days|month|months|year|years)\b/i),
    ]),
    semanticSlots: {
      initial_term_length: duration.label,
      expiration_basis: anchorBasis,
    },
    matchedPhrases: ['execution-based term'],
  });
}

function detectActivationPattern(
  ctx: PatternDetectionContext,
  patternId: 'ntp_activation' | 'task_order_activation' | 'disaster_triggered_activation',
  opts: {
    phrases: string[];
    triggerType: string;
    performanceBasis: string;
    contextRegexes: RegExp[];
  },
): DetectedClausePattern | null {
  const matchedPhrases = opts.phrases.filter((phrase) =>
    ctx.normalizedText.includes(normalizePatternSearchText(phrase)),
  );
  if (matchedPhrases.length === 0) return null;
  const phraseEvidenceAnchors = findEvidenceIdsByPhrases(ctx.document, opts.phrases);
  const contextMatched = opts.contextRegexes.some((regex) => regex.test(ctx.text));
  const contextEvidenceAnchors = findEvidenceIdsByRegexes(ctx.document, opts.contextRegexes);
  if (!contextMatched && contextEvidenceAnchors.length === 0) return null;
  const evidenceAnchors = uniqueStrings([...phraseEvidenceAnchors, ...contextEvidenceAnchors]);
  const mobilization = extractDurationToken(ctx.text.match(/(?:mobiliz|respond|commence)[^.]{0,120}/i)?.[0] ?? '');
  return buildPatternMatch(patternId, {
    confidence: 0.82,
    evidenceAnchors,
    semanticSlots: {
      activation_trigger_type: opts.triggerType,
      authorization_required: true,
      performance_start_basis: opts.performanceBasis,
      ...(mobilization ? { mobilization_sla: mobilization.label } : {}),
    },
    matchedPhrases,
  });
}

function detectSimplePhrasePattern(
  ctx: PatternDetectionContext,
  patternId: string,
  extra: {
    slotValues?: Record<string, unknown>;
    confidence?: number;
    contextRegexes?: RegExp[];
  } = {},
): DetectedClausePattern | null {
  const definition = CLAUSE_PATTERN_LIBRARY_V1_BY_ID.get(patternId);
  if (!definition) return null;
  const matchedPhrases = definition.trigger_phrases.filter((phrase) =>
    ctx.normalizedText.includes(normalizePatternSearchText(phrase)),
  );
  if (matchedPhrases.length === 0) return null;
  const phraseEvidenceAnchors = findEvidenceIdsByPhrases(ctx.document, definition.trigger_phrases);
  const contextRegexes = extra.contextRegexes ?? [];
  const contextEvidenceAnchors = findEvidenceIdsByRegexes(ctx.document, contextRegexes);
  const contextMatched = contextRegexes.length === 0
    || contextRegexes.some((regex) => regex.test(ctx.text))
    || contextEvidenceAnchors.length > 0;
  if (!contextMatched) return null;
  const evidenceAnchors = uniqueStrings([...phraseEvidenceAnchors, ...contextEvidenceAnchors]);
  return buildPatternMatch(patternId, {
    confidence: extra.confidence ?? 0.74,
    evidenceAnchors,
    semanticSlots: extra.slotValues ?? {},
    matchedPhrases,
  });
}

function detectMobilizationDeadline(ctx: PatternDetectionContext): DetectedClausePattern | null {
  const clause = ctx.text.match(/(?:mobiliz|respond|commence)[^.]{0,120}/i)?.[0] ?? null;
  const duration = clause ? extractDurationToken(clause) : null;
  const evidenceAnchors = findEvidenceIdsByRegex(ctx.document, /(?:mobiliz|respond|commence)[^.]{0,120}/i);
  if (!duration && evidenceAnchors.length === 0) return null;
  return buildPatternMatch('mobilization_deadline', {
    confidence: 0.8,
    evidenceAnchors,
    semanticSlots: duration ? { mobilization_sla: duration.label } : {},
    matchedPhrases: ['mobilization deadline'],
  });
}

function detectClausePatterns(document: NormalizedNodeDocument): DetectedClausePattern[] {
  const text = normalizeWhitespace(
    [
      document.text_preview,
      ...document.evidence.map((evidence) => evidenceText(evidence)),
    ].join(' '),
  );
  const ctx: PatternDetectionContext = {
    document,
    text,
    normalizedText: normalizePatternSearchText(text),
  };

  return [
    detectExecutionBasedTerm(ctx),
    detectActivationPattern(ctx, 'ntp_activation', {
      phrases: ['notice to proceed', 'written notice to proceed'],
      triggerType: 'notice_to_proceed',
      performanceBasis: 'after_notice_to_proceed',
      contextRegexes: [
        /\b(?:notice to proceed|written notice to proceed)\b[^.]{0,120}\b(?:begin|commence|mobiliz|respond|work|perform|issued?)\b/i,
        /\b(?:begin|commence|mobiliz|respond|work|perform)\b[^.]{0,120}\b(?:notice to proceed|written notice to proceed)\b/i,
      ],
    }),
    detectActivationPattern(ctx, 'task_order_activation', {
      phrases: ['task order', 'work order', 'written authorization'],
      triggerType: 'task_order',
      performanceBasis: 'after_task_order_or_work_order',
      contextRegexes: [
        /\b(?:task order|work order|written authorization)\b[^.]{0,140}\b(?:authorize|authorized|issue|issued|begin|commence|perform|start|activation?)\b/i,
        /\bno work\b[^.]{0,140}\b(?:task order|work order|written authorization)\b/i,
        /\b(?:task order|work order|written authorization)\b[^.]{0,140}\b(?:required|must be issued|must be executed|prior to work|before work)\b/i,
      ],
    }),
    detectActivationPattern(ctx, 'disaster_triggered_activation', {
      phrases: ['declaration of emergency', 'declared disaster', 'storm event', 'catastrophic event'],
      triggerType: 'disaster_trigger',
      performanceBasis: 'after_declared_event',
      contextRegexes: [
        /\b(?:declaration of emergency|declared disaster|storm event|catastrophic event)\b[^.]{0,140}\b(?:activate|activation|trigger|authorize|authorized|begin|commence|services?)\b/i,
        /\b(?:services?|work)\b[^.]{0,140}\b(?:declaration of emergency|declared disaster|storm event|catastrophic event)\b/i,
      ],
    }),
    detectSimplePhrasePattern(ctx, 'renewal_option'),
    detectSimplePhrasePattern(ctx, 'unit_rate_schedule', {
      slotValues: {
        rate_schedule_present: document.fact_map.rate_schedule_present?.value === true,
        rate_schedule_pages: document.fact_map.rate_schedule_pages?.value ?? null,
      },
      confidence:
        document.fact_map.rate_schedule_present?.value === true
          || document.section_signals.rate_section_present === true
          ? 0.86
          : 0.72,
    }),
    detectSimplePhrasePattern(ctx, 'not_to_exceed', {
      slotValues: { contract_ceiling: document.fact_map.contract_ceiling?.value ?? null },
      confidence: document.fact_map.contract_ceiling?.value != null ? 0.86 : 0.68,
    }),
    detectSimplePhrasePattern(ctx, 'no_guarantee_quantity', { slotValues: { no_guarantee_quantity: true } }),
    detectSimplePhrasePattern(ctx, 'pass_through_disposal', { slotValues: { disposal_fee_treatment: 'pass_through' } }),
    detectSimplePhrasePattern(ctx, 'monitoring_dependency', {
      slotValues: { monitoring_required: true },
      contextRegexes: [
        /\b(?:debris monitor|monitoring|verified by the monitor)\b[^.]{0,160}\b(?:invoice|payment|reimburse|load ticket|haul ticket|ticket|manifest|certif|verify|approved|approval)\b/i,
        /\b(?:invoice|payment|reimburse|load ticket|haul ticket|ticket|manifest|certif|verify|approved|approval)\b[^.]{0,160}\b(?:debris monitor|monitoring|verified by the monitor)\b/i,
      ],
    }),
    detectSimplePhrasePattern(ctx, 'ticket_load_documentation', {
      slotValues: { billing_documentation_required: true },
      contextRegexes: [
        /\b(?:load ticket|haul ticket|truck certification|manifest|tower log)\b[^.]{0,160}\b(?:invoice|payment|reimburse|submit|include|support|approved|approval)\b/i,
        /\b(?:invoice|payment|reimburse|submit|include|support|approved|approval)\b[^.]{0,160}\b(?:load ticket|haul ticket|truck certification|manifest|tower log)\b/i,
      ],
    }),
    detectSimplePhrasePattern(ctx, 'fema_eligibility_restriction', {
      slotValues: { fema_eligibility_gate: true },
      confidence: document.section_signals.fema_reference_present === true ? 0.82 : 0.72,
      contextRegexes: [
        /\b(?:fema[- ]eligible|eligible work|eligible costs|ineligible work|non[- ]reimbursable|not reimbursable)\b[^.]{0,180}\b(?:payment|invoice|reimburse|cost|costs|expense|expenses|scope|work|limited|only|approved)\b/i,
        /\b(?:payment|invoice|reimburse|cost|costs|expense|expenses|scope|work)\b[^.]{0,180}\b(?:fema[- ]eligible|eligible work|eligible costs|ineligible work|non[- ]reimbursable|not reimbursable)\b/i,
      ],
    }),
    detectMobilizationDeadline(ctx),
    detectSimplePhrasePattern(ctx, 'insurance_bond_requirements'),
    detectSimplePhrasePattern(ctx, 'subcontract_controls'),
    detectSimplePhrasePattern(ctx, 'audit_record_retention'),
    detectSimplePhrasePattern(ctx, 'termination_convenience_or_cause'),
  ].filter((pattern): pattern is DetectedClausePattern => pattern != null);
}

function fieldFamilyContainer(): FieldFamilies {
  return {
    contract_identity: {},
    term_model: {},
    activation_model: {},
    scope_model: {},
    pricing_model: {},
    documentation_model: {},
    compliance_model: {},
    payment_model: {},
  };
}

function setField(
  families: FieldFamilies,
  fieldId: ContractFieldId,
  input: {
    value: unknown;
    state: ContractFieldState;
    evidenceAnchors?: string[];
    sourceFactIds?: string[];
    patternIds?: string[];
    confidence?: number | null;
    notes?: string[];
  },
): void {
  const definition = LANGUAGE_ENGINE_FIELDS_V1_BY_ID.get(fieldId);
  if (!definition) return;
  const field: ContractFieldAnalysis = {
    field_id: definition.field_id,
    label: definition.label,
    object_family: definition.object_family,
    value_type: definition.value_type,
    value: input.value,
    state: input.state,
    criticality: definition.criticality,
    confidence: input.confidence ?? null,
    evidence_anchors: uniqueStrings(input.evidenceAnchors ?? []),
    source_fact_ids: uniqueStrings(input.sourceFactIds ?? []),
    pattern_ids: uniqueStrings(input.patternIds ?? []),
    notes: uniqueStrings(input.notes ?? []),
  };
  families[definition.object_family][fieldId] = field;
}

function stateFromFact(
  value: unknown,
  derivationStatus: string | undefined,
  _fallbackCriticality: ContractCriticality,
): ContractFieldState {
  if (value == null || value === '') return 'missing_critical';
  if (derivationStatus === 'calculated') return 'derived';
  return 'explicit';
}

function collectContractorCandidates(
  document: NormalizedNodeDocument,
): Array<{ value: string; evidenceAnchors: string[] }> {
  const candidates = new Map<string, { value: string; evidenceAnchors: string[] }>();
  const rawCandidates = uniqueStrings([
    asString(document.fact_map.contractor_name?.value),
    asString(document.typed_fields.vendor_name),
    asString(document.structured_fields.contractor_name),
  ]);

  for (const value of rawCandidates) {
    const normalized = normalizeIdentityValue(value);
    if (!normalized) continue;
    candidates.set(normalized, {
      value,
      evidenceAnchors: document.fact_map.contractor_name?.evidence_refs ?? [],
    });
  }

  const regexes = [
    /(?:contractor|vendor)\s*[:\-]\s*([A-Z][A-Za-z0-9,&.\- ]{3,120})/i,
  ];
  for (const regex of regexes) {
    for (const evidence of document.evidence) {
      const text = evidenceText(evidence);
      const match = regex.exec(text);
      if (!match?.[1]) continue;
      const value = normalizeWhitespace(match[1]);
      const normalized = normalizeIdentityValue(value);
      if (!normalized) continue;
      const existing = candidates.get(normalized);
      candidates.set(normalized, {
        value: existing?.value ?? value,
        evidenceAnchors: uniqueStrings([...(existing?.evidenceAnchors ?? []), evidence.id]),
      });
    }
  }

  return [...candidates.values()];
}

function findScopeCategoryEvidence(document: NormalizedNodeDocument): string[] {
  return findEvidenceIdsByPhrases(document, [
    'debris',
    'vegetative',
    'waterway',
    'right-of-way',
    'stump',
    'hazard',
    'demolition',
    'monitoring',
    'disposal',
    'push',
    'reduction site',
  ]);
}

function buildFieldFamilies(
  document: NormalizedNodeDocument,
  patterns: DetectedClausePattern[],
  profile: ContractDocumentTypeProfile | null,
): { families: FieldFamilies; scopeCategoryEvidenceAnchors: string[] } {
  const families = fieldFamilyContainer();
  const patternById = new Map(patterns.map((pattern) => [pattern.pattern_id, pattern] as const));

  const contractorCandidates = collectContractorCandidates(document);
  const contractorFact = document.fact_map.contractor_name ?? null;
  if (contractorCandidates.length > 1) {
    setField(families, 'contractor_name', {
      value: contractorCandidates.map((candidate) => candidate.value),
      state: 'conflicted',
      evidenceAnchors: contractorCandidates.flatMap((candidate) => candidate.evidenceAnchors),
      sourceFactIds: ['contractor_name'],
      confidence: contractorFact?.confidence ?? 0.42,
      notes: ['Multiple plausible contractor identity candidates were detected.'],
    });
  } else {
    setField(families, 'contractor_name', {
      value: contractorFact?.value ?? contractorCandidates[0]?.value ?? null,
      state: stateFromFact(
        contractorFact?.value ?? contractorCandidates[0]?.value ?? null,
        contractorFact?.derivation_status,
        'P1',
      ),
      evidenceAnchors: contractorFact?.evidence_refs ?? contractorCandidates[0]?.evidenceAnchors ?? [],
      sourceFactIds: contractorFact ? ['contractor_name'] : [],
      confidence: contractorFact?.confidence ?? null,
    });
  }

  const ownerFact = document.fact_map.owner_name ?? null;
  setField(families, 'owner_name', {
    value: ownerFact?.value ?? null,
    state: stateFromFact(ownerFact?.value ?? null, ownerFact?.derivation_status, 'P2'),
    evidenceAnchors: ownerFact?.evidence_refs ?? [],
    sourceFactIds: ownerFact ? ['owner_name'] : [],
    confidence: ownerFact?.confidence ?? null,
  });

  const contractNumber = findFirstRegexValue(document, [
    /(?:contract\s*(?:number|no\.?)|agreement\s*(?:number|no\.?))\s*[:#-]?\s*([A-Z0-9\-]+)/i,
  ]);
  setField(families, 'contract_number', {
    value:
      asString(document.typed_fields.contract_number)
      ?? asString(document.structured_fields.contract_number)
      ?? contractNumber.value,
    state: stateFromFact(
      asString(document.typed_fields.contract_number)
      ?? asString(document.structured_fields.contract_number)
      ?? contractNumber.value,
      undefined,
      'P2',
    ),
    evidenceAnchors: contractNumber.evidenceAnchors,
    confidence: contractNumber.value ? 0.7 : null,
  });

  const solicitationNumber = findFirstRegexValue(document, [
    /(?:solicitation\s*(?:number|no\.?)|rfp\s*(?:number|no\.?)|bid\s*(?:number|no\.?))\s*[:#-]?\s*([A-Z0-9\-]+)/i,
  ]);
  setField(families, 'solicitation_number', {
    value: asString(document.typed_fields.solicitation_number) ?? solicitationNumber.value,
    state: stateFromFact(
      asString(document.typed_fields.solicitation_number) ?? solicitationNumber.value,
      undefined,
      'P3',
    ),
    evidenceAnchors: solicitationNumber.evidenceAnchors,
    confidence: solicitationNumber.value ? 0.64 : null,
  });

  const executedFact = document.fact_map.executed_date ?? null;
  setField(families, 'executed_date', {
    value: executedFact?.value ?? null,
    state: stateFromFact(executedFact?.value ?? null, executedFact?.derivation_status, 'P1'),
    evidenceAnchors: executedFact?.evidence_refs ?? [],
    sourceFactIds: executedFact ? ['executed_date'] : [],
    confidence: executedFact?.confidence ?? null,
  });

  const effectiveDateDetection = findFirstRegexValue(document, [
    /effective\s+(?:date\s+of\s+(?:this|the)\s+(?:agreement|contract)\s+is|as\s+of)\s*[:#-]?\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);
  const typedEffectiveDate = asString(document.typed_fields.effective_date);
  const effectiveInheritsExecution =
    /\beffective\s+(?:date|upon)\b[^.]{0,80}\bexecution\b/i.test(document.text_preview)
      && executedFact?.value != null;
  setField(families, 'effective_date', {
    value:
      typedEffectiveDate
      ?? effectiveDateDetection.value
      ?? (effectiveInheritsExecution ? executedFact?.value ?? null : null),
    state:
      typedEffectiveDate || effectiveDateDetection.value
        ? 'explicit'
        : effectiveInheritsExecution
          ? 'derived'
          : 'missing_critical',
    evidenceAnchors: uniqueStrings([
      ...effectiveDateDetection.evidenceAnchors,
      ...(effectiveInheritsExecution ? executedFact?.evidence_refs ?? [] : []),
    ]),
    sourceFactIds:
      typedEffectiveDate || effectiveDateDetection.value
        ? ['effective_date']
        : executedFact?.value
          ? ['executed_date']
          : [],
    patternIds: effectiveInheritsExecution ? ['execution_based_term'] : [],
    confidence:
      typedEffectiveDate || effectiveDateDetection.value
        ? 0.72
        : effectiveInheritsExecution
          ? 0.62
          : null,
    notes: effectiveInheritsExecution
      ? ['Effective date was inferred from execution-linked effective-date language.']
      : [],
  });

  const executionPattern = patternById.get('execution_based_term') ?? null;
  setField(families, 'initial_term_length', {
    value: executionPattern?.semantic_slots.initial_term_length ?? null,
    state: executionPattern?.semantic_slots.initial_term_length ? 'explicit' : 'missing_critical',
    evidenceAnchors: executionPattern?.evidence_anchors ?? [],
    patternIds: executionPattern ? [executionPattern.pattern_id] : [],
    confidence: executionPattern ? executionPattern.confidence : null,
  });

  const expirationFact = document.fact_map.expiration_date ?? null;
  const termEndFact = document.fact_map.term_end_date ?? null;
  setField(families, 'expiration_date', {
    value: expirationFact?.value ?? termEndFact?.value ?? null,
    state: stateFromFact(
      expirationFact?.value ?? termEndFact?.value ?? null,
      expirationFact?.derivation_status ?? termEndFact?.derivation_status,
      'P1',
    ),
    evidenceAnchors: expirationFact?.evidence_refs ?? termEndFact?.evidence_refs ?? [],
    sourceFactIds: expirationFact ? ['expiration_date'] : termEndFact ? ['term_end_date'] : [],
    patternIds:
      executionPattern
      && (expirationFact?.derivation_status === 'calculated'
        || termEndFact?.derivation_status === 'calculated')
        ? [executionPattern.pattern_id]
        : [],
    confidence: expirationFact?.confidence ?? termEndFact?.confidence ?? null,
  });

  const activationPatterns = [
    patternById.get('ntp_activation'),
    patternById.get('task_order_activation'),
    patternById.get('disaster_triggered_activation'),
  ].filter((pattern): pattern is DetectedClausePattern => pattern != null);
  const activationValues = uniqueStrings(
    activationPatterns.map((pattern) => asString(pattern.semantic_slots.activation_trigger_type)),
  );
  const performanceValues = uniqueStrings(
    activationPatterns.map((pattern) => asString(pattern.semantic_slots.performance_start_basis)),
  );
  const mobilizationPattern = patternById.get('mobilization_deadline') ?? null;
  const mobilizationValue =
    asString(mobilizationPattern?.semantic_slots.mobilization_sla)
      ?? activationPatterns
        .map((pattern) => asString(pattern.semantic_slots.mobilization_sla))
        .find(Boolean)
      ?? null;

  setField(families, 'activation_trigger_type', {
    value: activationValues.length > 1 ? activationValues : activationValues[0] ?? null,
    state: activationValues.length > 0 ? 'conditional' : profile ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: activationPatterns.flatMap((pattern) => pattern.evidence_anchors),
    patternIds: activationPatterns.map((pattern) => pattern.pattern_id),
    confidence: activationPatterns[0]?.confidence ?? null,
    notes: activationValues.length > 0
      ? ['Activation dependency detected; trigger satisfaction is not resolved by the contract alone.']
      : [],
  });

  setField(families, 'authorization_required', {
    value: activationPatterns.length > 0 ? true : null,
    state: activationPatterns.length > 0 ? 'conditional' : profile ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: activationPatterns.flatMap((pattern) => pattern.evidence_anchors),
    patternIds: activationPatterns.map((pattern) => pattern.pattern_id),
    confidence: activationPatterns.length > 0 ? 0.78 : null,
  });

  setField(families, 'performance_start_basis', {
    value: performanceValues.length > 1 ? performanceValues : performanceValues[0] ?? null,
    state: performanceValues.length > 0 ? 'conditional' : profile ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: activationPatterns.flatMap((pattern) => pattern.evidence_anchors),
    patternIds: activationPatterns.map((pattern) => pattern.pattern_id),
    confidence: activationPatterns[0]?.confidence ?? null,
  });

  setField(families, 'mobilization_sla', {
    value: mobilizationValue,
    state: mobilizationValue ? 'conditional' : activationPatterns.length > 0 ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: uniqueStrings([
      ...(mobilizationPattern?.evidence_anchors ?? []),
      ...activationPatterns.flatMap((pattern) => pattern.evidence_anchors),
    ]),
    patternIds: uniqueStrings([
      ...(mobilizationPattern ? [mobilizationPattern.pattern_id] : []),
      ...activationPatterns.map((pattern) => pattern.pattern_id),
    ]),
    confidence: mobilizationPattern?.confidence ?? null,
  });

  const rateFact = document.fact_map.rate_schedule_present ?? null;
  const ratePagesFact = document.fact_map.rate_schedule_pages ?? null;
  setField(families, 'rate_schedule_present', {
    value: rateFact?.value === true ? true : null,
    state: rateFact?.value === true ? 'explicit' : 'missing_critical',
    evidenceAnchors: rateFact?.evidence_refs ?? [],
    sourceFactIds: rateFact ? ['rate_schedule_present'] : [],
    confidence: rateFact?.value === true ? rateFact.confidence : null,
    patternIds: patternById.has('unit_rate_schedule') ? ['unit_rate_schedule'] : [],
  });
  setField(families, 'rate_schedule_pages', {
    value: ratePagesFact?.value ?? null,
    state: ratePagesFact?.value ? 'explicit' : rateFact?.value === true ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: ratePagesFact?.evidence_refs ?? rateFact?.evidence_refs ?? [],
    sourceFactIds: ratePagesFact ? ['rate_schedule_pages'] : [],
    confidence: ratePagesFact?.confidence ?? null,
    patternIds: patternById.has('unit_rate_schedule') ? ['unit_rate_schedule'] : [],
  });

  const pricingApplicabilityExplicit =
    (
      /compensation shall be based on the unit prices[^.]{0,80}(?:exhibit|schedule)/i.test(
        document.text_preview,
      )
      || /\bat the unit prices specified[^.]{0,120}(?:unit rate price form|fee schedule|exhibit)/i.test(
        document.text_preview,
      )
      || /\b(?:exhibit|attachment)\s+[a-z]\b[^.]{0,120}\bfee schedule\b/i.test(document.text_preview)
      || /\bin accordance with[^.]{0,120}\bfee schedule\b/i.test(document.text_preview)
    )
    && !patternById.has('pass_through_disposal')
    && !patternById.has('fema_eligibility_restriction');
  setField(families, 'pricing_applicability', {
    value:
      rateFact?.value === true
        ? pricingApplicabilityExplicit
          ? 'unit_rate_schedule_controls_pricing'
          : 'requires_activation_scope_or_eligibility_resolution'
        : null,
    state:
      rateFact?.value === true
        ? pricingApplicabilityExplicit
          ? 'explicit'
          : 'conditional'
        : 'missing_critical',
    evidenceAnchors: uniqueStrings([
      ...(rateFact?.evidence_refs ?? []),
      ...(patternById.get('unit_rate_schedule')?.evidence_anchors ?? []),
      ...(patternById.get('pass_through_disposal')?.evidence_anchors ?? []),
      ...(patternById.get('fema_eligibility_restriction')?.evidence_anchors ?? []),
      ...activationPatterns.flatMap((pattern) => pattern.evidence_anchors),
    ]),
    sourceFactIds: rateFact ? ['rate_schedule_present'] : [],
    patternIds: uniqueStrings([
      ...(patternById.has('unit_rate_schedule') ? ['unit_rate_schedule'] : []),
      ...(patternById.has('pass_through_disposal') ? ['pass_through_disposal'] : []),
      ...(patternById.has('fema_eligibility_restriction') ? ['fema_eligibility_restriction'] : []),
      ...activationPatterns.map((pattern) => pattern.pattern_id),
    ]),
    confidence: rateFact?.value === true ? 0.7 : null,
    notes:
      rateFact?.value === true && !pricingApplicabilityExplicit
        ? ['Pricing presence is known, but applicability still depends on activation, scope, or eligibility context.']
        : [],
  });

  const ceilingFact = document.fact_map.contract_ceiling ?? null;
  setField(families, 'contract_ceiling', {
    value: ceilingFact?.value ?? null,
    state: ceilingFact?.value != null ? 'explicit' : 'missing_critical',
    evidenceAnchors: ceilingFact?.evidence_refs ?? [],
    sourceFactIds: ceilingFact ? ['contract_ceiling'] : [],
    confidence: ceilingFact?.confidence ?? null,
    patternIds: patternById.has('not_to_exceed') ? ['not_to_exceed'] : [],
    notes:
      ceilingFact?.value == null && ceilingFact?.machine_classification === 'rate_price_no_ceiling'
        ? ['Normalization detected rate-based pricing but no explicit overall contract ceiling.']
        : [],
  });

  const noGuaranteePattern = patternById.get('no_guarantee_quantity') ?? null;
  setField(families, 'no_guarantee_quantity', {
    value: noGuaranteePattern ? true : null,
    state: noGuaranteePattern ? 'explicit' : 'missing_critical',
    evidenceAnchors: noGuaranteePattern?.evidence_anchors ?? [],
    patternIds: noGuaranteePattern ? [noGuaranteePattern.pattern_id] : [],
    confidence: noGuaranteePattern?.confidence ?? null,
  });

  const disposalPattern = patternById.get('pass_through_disposal') ?? null;
  setField(families, 'disposal_fee_treatment', {
    value: disposalPattern ? 'pass_through' : null,
    state: disposalPattern ? 'explicit' : 'missing_critical',
    evidenceAnchors: disposalPattern?.evidence_anchors ?? [],
    patternIds: disposalPattern ? [disposalPattern.pattern_id] : [],
    confidence: disposalPattern?.confidence ?? null,
  });

  const monitoringPattern = patternById.get('monitoring_dependency') ?? null;
  setField(families, 'monitoring_required', {
    value: monitoringPattern ? true : null,
    state: monitoringPattern ? 'conditional' : profile ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: monitoringPattern?.evidence_anchors ?? [],
    patternIds: monitoringPattern ? [monitoringPattern.pattern_id] : [],
    confidence: monitoringPattern?.confidence ?? null,
  });

  const docsPattern = patternById.get('ticket_load_documentation') ?? null;
  setField(families, 'billing_documentation_required', {
    value: docsPattern ? true : null,
    state: docsPattern ? 'conditional' : profile ? 'missing_critical' : 'missing_critical',
    evidenceAnchors: uniqueStrings([
      ...(docsPattern?.evidence_anchors ?? []),
      ...(monitoringPattern?.evidence_anchors ?? []),
    ]),
    patternIds: uniqueStrings([
      ...(docsPattern ? [docsPattern.pattern_id] : []),
      ...(monitoringPattern ? [monitoringPattern.pattern_id] : []),
    ]),
    confidence: docsPattern?.confidence ?? monitoringPattern?.confidence ?? null,
  });

  const femaPattern = patternById.get('fema_eligibility_restriction') ?? null;
  setField(families, 'fema_eligibility_gate', {
    value: femaPattern ? true : null,
    state:
      femaPattern
        ? 'conditional'
        : document.section_signals.fema_reference_present === true || profile
          ? 'missing_critical'
          : 'missing_critical',
    evidenceAnchors: femaPattern?.evidence_anchors ?? [],
    patternIds: femaPattern ? [femaPattern.pattern_id] : [],
    confidence: femaPattern?.confidence ?? null,
    notes:
      !femaPattern && (document.section_signals.fema_reference_present === true || profile)
        ? ['FEMA/debris context is present, but an operational eligibility gate was not cleanly extracted.']
        : [],
  });

  return {
    families,
    scopeCategoryEvidenceAnchors: findScopeCategoryEvidence(document),
  };
}

export function analyzeContractIntelligence(
  input: AnalyzeContractIntelligenceInput,
): ContractAnalysisResult | null {
  if (input.primaryDocument.family !== 'contract') return null;

  const profile = determineDocumentTypeProfile(input.primaryDocument);
  const patterns = detectClausePatterns(input.primaryDocument);
  const { families, scopeCategoryEvidenceAnchors } = buildFieldFamilies(
    input.primaryDocument,
    patterns,
    profile,
  );

  const analysisWithoutIssues: Omit<ContractAnalysisResult, 'coverage_status' | 'issues' | 'trace_summary'> = {
    document_id: input.primaryDocument.document_id,
    document_family: 'contract',
    document_type_profile: profile,
    language_engine_version: LANGUAGE_ENGINE_FIELDS_VERSION_V1,
    pattern_library_version: CLAUSE_PATTERN_LIBRARY_VERSION_V1,
    coverage_library_version: COVERAGE_LIBRARY_VERSION_V1,
    contract_identity: families.contract_identity,
    term_model: families.term_model,
    activation_model: families.activation_model,
    scope_model: families.scope_model,
    pricing_model: families.pricing_model,
    documentation_model: families.documentation_model,
    compliance_model: families.compliance_model,
    payment_model: families.payment_model,
    clause_patterns_detected: patterns,
  };

  const evidenceById = new Map(
    input.primaryDocument.evidence.map((evidence) => [evidence.id, evidence] as const),
  );
  const coverageStatus = evaluateContractCoverage({
    documentTypeProfile: profile,
    contractAnalysis: analysisWithoutIssues,
    evidenceById,
    scopeCategoryEvidenceAnchors,
  });
  const issueEvaluation = buildContractIssues({
    contractAnalysis: {
      ...analysisWithoutIssues,
      coverage_status: coverageStatus,
    },
  });

  return {
    ...analysisWithoutIssues,
    coverage_status: coverageStatus,
    issues: issueEvaluation.issues,
    trace_summary: {
      detected_pattern_ids: patterns.map((pattern) => pattern.pattern_id),
      coverage_gap_ids: coverageStatus
        .filter((coverage) => coverage.operator_review_required)
        .map((coverage) => coverage.coverage_id),
      emitted_issue_ids: issueEvaluation.issues.map((issue) => issue.issue_id),
      suppressed_issues: issueEvaluation.suppressed,
      issue_anchor_summary: issueEvaluation.issues.map((issue) => ({
        issue_id: issue.issue_id,
        field_ids: issue.field_ids,
        anchor_count: issue.evidence_anchors.length,
        anchor_ids: issue.evidence_anchors,
        anchor_previews: issue.evidence_anchors
          .map((anchorId) => summarizeEvidenceAnchor(evidenceById.get(anchorId)))
          .filter((preview): preview is string => preview != null),
      })),
    },
  };
}

import type { EvidenceObject } from '@/lib/extraction/types';
import type { NormalizedNodeDocument, PipelineFact } from '@/lib/pipeline/types';

function factDisplayValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value == null) return 'Missing';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

type ContractorObservationSource =
  | 'fact_map.contractor_name'
  | 'typed_fields.vendor_name'
  | 'structured_fields.contractor_name.explicit_definition'
  | 'structured_fields.contractor_name.heuristic'
  | 'evidence.defined_party'
  | 'evidence.contract_between'
  | 'evidence.inline_label'
  | 'evidence.signature_block';

type ContractorObservation = {
  value: string;
  normalizedValue: string;
  source: ContractorObservationSource;
  score: number;
  roleScore: number;
  evidenceIds: string[];
  sourceFactIds: string[];
};

export type RankedContractorCandidate = {
  value: string;
  normalizedValue: string;
  totalScore: number;
  roleScore: number;
  evidenceAnchors: string[];
  sourceFactIds: string[];
  observations: Array<{
    value: string;
    source: ContractorObservationSource;
    score: number;
    roleScore: number;
    evidenceIds: string[];
  }>;
};

export type ContractorIdentityResolution = {
  selected: RankedContractorCandidate | null;
  candidates: RankedContractorCandidate[];
  conflict: boolean;
  confidence: number | null;
  notes: string[];
};

const LEGAL_ENTITY_SUFFIX_RE =
  /\b(?:incorporated|inc|llc|l\.l\.c|corp|corporation|company|co|ltd|limited|lp|l\.p\.|llp|pllc|pc|p\.c\.|plc)\b\.?/gi;

const LEGAL_ENTITY_DISPLAY_RE =
  /\b(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Limited|LP|L\.P\.|LLP|PLLC|PC|P\.C\.|PLC)\b/i;

const BUSINESS_WORD_RE =
  /\b(?:recovery|services|solutions|group|ventures|environmental|debris|construction|contracting|consulting|partners|management|industries|systems|logistics|restoration|hauling|joint venture)\b/i;

const INLINE_LABEL_RE = /(?:^|[\n\r|])\s*(?:name\s+of\s+)?(?:contractor|vendor)\s*[:#.\-]\s*([A-Z][A-Za-z0-9,&.'()\- ]{2,220})/gim;

const DEFINED_PARTY_RE = [
  /\band\s+([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?)\s*,?\s*\(\s*(?:hereinafter(?:\s+(?:referred\s+to|called)\s+as)?)?\s*["']?contractor["']?\s*\)/gim,
  /\b([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?)\s*,?\s*\(\s*(?:hereinafter(?:\s+(?:referred\s+to|called)\s+as)?)?\s*["']?contractor["']?\s*\)/gim,
  /\band\s+([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?)\s*,?\s*hereinafter(?:\s+(?:referred\s+to|called)\s+as)?\s+["']?contractor["']?/gim,
] as const;

const CONTRACT_BETWEEN_RE = [
  /\b(?:contract|agreement)\s+between\b[\s\S]{0,180}?\band\s+([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?)(?=[,.;]|\s+\(|\s+for\b|$)/gim,
  /\b(?:made|entered)\s+into\s+by\s+and\s+between\b[\s\S]{0,180}?\band\s+([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?)(?=[,.;]|\s+\(|\s+for\b|$)/gim,
] as const;

const SIGNATURE_BLOCK_RE = [
  /\bcontractor\s+signature\b[\s\S]{0,160}?\b([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?\b(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Limited|LP|L\.P\.|LLP|PLLC|PC|P\.C\.|PLC)\b\.?)/gim,
  /\bsignature\s+of\s+contractor\b[\s\S]{0,160}?\b([A-Z][A-Za-z0-9,&.'()\- ]{2,220}?\b(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Limited|LP|L\.P\.|LLP|PLLC|PC|P\.C\.|PLC)\b\.?)/gim,
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function normalizeIdentityValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(LEGAL_ENTITY_SUFFIX_RE, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasLegalEntitySuffix(value: string): boolean {
  return LEGAL_ENTITY_DISPLAY_RE.test(value);
}

function stripLeadingRolePrefix(value: string): string {
  return normalizeWhitespace(
    value.replace(
      /^(?:(?:name\s+of\s+)?(?:prime\s+)?(?:contractor|vendor)|company(?:\s+name)?|bidder(?:\/proposer)?|proposer(?:\s+name)?)\s*[:#.\-]\s*/i,
      '',
    ),
  );
}

function trimCandidateTail(value: string): string {
  let trimmed = stripLeadingRolePrefix(value)
    .replace(/^[,;:)\]\s]+/, '')
    .replace(/[,;:)\]\s]+$/, '')
    .trim();

  const tailCut = /\s+(?:hereinafter|whose|with|for purposes of|a corporation|a limited liability company|a company)\b/i.exec(trimmed);
  if (tailCut && tailCut.index > 0) {
    trimmed = trimmed.slice(0, tailCut.index).trim();
  }

  if (trimmed.includes('  ')) {
    trimmed = normalizeWhitespace(trimmed);
  }

  const entitySuffix = /\b(?:Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Limited|LP|L\.P\.|LLP|PLLC|PC|P\.C\.|PLC)\b\.?/i.exec(trimmed);
  if (entitySuffix) {
    const entityEnd = entitySuffix.index + entitySuffix[0].length;
    const trailing = trimmed.slice(entityEnd);
    if (
      /^\s*[.;,]?\s*(?:This|Contractor|Vendor|Owner|County|City|State|Agreement|Contract|WITNESS|hereinafter)\b/i.test(
        trailing,
      )
    ) {
      trimmed = trimmed.slice(0, entityEnd).replace(/[,\s;:]+$/, '').trim();
    }
  }

  return trimmed;
}

function looksLikePersonName(value: string): boolean {
  if (hasLegalEntitySuffix(value) || BUSINESS_WORD_RE.test(value)) return false;
  const cleaned = value.replace(/[^A-Za-z\s]/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((token) => /^[A-Z][a-z]+$/.test(token));
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 0; i < a.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const substitutionCost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[b.length]!;
}

function tokenSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshteinDistance(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

export function organizationNamesLookEquivalent(a: string, b: string): boolean {
  const normalizedA = normalizeIdentityValue(a);
  const normalizedB = normalizeIdentityValue(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;

  const shorter = normalizedA.length <= normalizedB.length ? normalizedA : normalizedB;
  const longer = shorter === normalizedA ? normalizedB : normalizedA;
  if (
    shorter.length >= 12
    && longer.includes(shorter)
    && shorter.split(' ').length >= 2
    && shorter.length >= Math.floor(longer.length * 0.7)
  ) {
    return true;
  }

  if (Math.abs(normalizedA.length - normalizedB.length) > 3) return false;

  const overallSimilarity = tokenSimilarity(normalizedA, normalizedB);
  if (overallSimilarity < 0.88) return false;

  const tokensA = normalizedA.split(' ');
  const tokensB = normalizedB.split(' ');
  if (Math.abs(tokensA.length - tokensB.length) > 1) return false;

  let fuzzyMismatches = 0;
  for (let index = 0; index < Math.max(tokensA.length, tokensB.length); index += 1) {
    const tokenA = tokensA[index] ?? '';
    const tokenB = tokensB[index] ?? '';
    if (!tokenA || !tokenB) {
      fuzzyMismatches += 1;
      continue;
    }
    if (tokenA === tokenB) continue;
    if (Math.max(tokenA.length, tokenB.length) < 7) return false;
    if (tokenSimilarity(tokenA, tokenB) < 0.72) return false;
    fuzzyMismatches += 1;
  }

  return fuzzyMismatches <= 1;
}

function evidenceContextScore(evidence: EvidenceObject | undefined): { score: number; roleScore: number } {
  if (!evidence) return { score: 0, roleScore: 0 };
  const text = evidenceText(evidence);
  if (!text) return { score: 0, roleScore: 0 };

  let score = 0;
  let roleScore = 0;

  if (/\bhereinafter\s+(?:referred\s+to|called)\s+as\s+["']?contractor["']?/i.test(text)) {
    score += 28;
    roleScore += 28;
  }
  if (/\b(?:contract|agreement)\s+between\b|\bby\s+and\s+between\b/i.test(text)) {
    score += 20;
    roleScore += 20;
  }
  if (/(?:^|[\n\r|])\s*(?:name\s+of\s+)?(?:contractor|vendor)\s*[:#.\-]/i.test(text)) {
    score += 22;
    roleScore += 22;
  }
  if (/\bcontractor\s+signature\b|\bsignature\s+of\s+contractor\b|\bwitness\s+whereof\b/i.test(text)) {
    score += 24;
    roleScore += 24;
  }
  if (/\b(?:contractor|vendor)\s+shall\b/i.test(text)) {
    score += 8;
    roleScore += 8;
  }
  if (typeof evidence.location.page === 'number' && evidence.location.page <= 2) {
    score += 6;
  }
  if (
    /\b(?:certificate\s+of\s+liability|acord|named\s+insured|broker|producer|policy\s+number|contact|phone|email|website|footer|prepared\s+by)\b/i.test(
      text,
    )
  ) {
    score -= 18;
  }
  if (/\bnotes?:\b/i.test(text) && roleScore === 0) {
    score -= 8;
  }
  if (/\b(?:landfill|disposal\s+site|pass\s+through)\b/i.test(text) && roleScore === 0) {
    score -= 10;
  }

  return { score, roleScore };
}

function scoreObservation(input: {
  value: string;
  source: ContractorObservationSource;
  fact?: PipelineFact | null;
  evidence?: EvidenceObject;
}): { score: number; roleScore: number } {
  let score =
    input.source === 'structured_fields.contractor_name.explicit_definition' ? 42 :
    input.source === 'fact_map.contractor_name' ? 34 :
    input.source === 'typed_fields.vendor_name' ? 24 :
    input.source === 'structured_fields.contractor_name.heuristic' ? 18 :
    input.source === 'evidence.defined_party' ? 52 :
    input.source === 'evidence.contract_between' ? 46 :
    input.source === 'evidence.signature_block' ? 44 :
    36;

  let roleScore =
    input.source === 'evidence.defined_party' ? 34 :
    input.source === 'evidence.contract_between' ? 30 :
    input.source === 'evidence.signature_block' ? 26 :
    input.source === 'evidence.inline_label' ? 22 :
    input.source === 'structured_fields.contractor_name.explicit_definition' ? 18 :
    input.source === 'fact_map.contractor_name' ? 14 :
    0;

  if (hasLegalEntitySuffix(input.value)) {
    score += 10;
  }
  if (BUSINESS_WORD_RE.test(input.value)) {
    score += 4;
  }
  if (input.fact?.confidence != null) {
    score += Math.round(input.fact.confidence * 10);
  }

  const context = evidenceContextScore(input.evidence);
  score += context.score;
  roleScore += context.roleScore;

  if (looksLikePersonName(input.value)) {
    score -= 24;
    roleScore = Math.max(0, roleScore - 12);
  }

  return { score, roleScore };
}

function pushObservation(
  observations: ContractorObservation[],
  dedupe: Set<string>,
  value: string | null | undefined,
  source: ContractorObservationSource,
  opts: {
    evidenceIds?: string[];
    sourceFactIds?: string[];
    evidenceLookup?: Map<string, EvidenceObject>;
    fact?: PipelineFact | null;
    evidence?: EvidenceObject;
  } = {},
): void {
  const cleaned = typeof value === 'string' ? trimCandidateTail(value) : '';
  if (!cleaned || cleaned.length < 3) return;
  const normalizedValue = normalizeIdentityValue(cleaned);
  if (!normalizedValue || normalizedValue.length < 3) return;
  const dedupeKey = `${source}:${normalizedValue}:${opts.evidence?.id ?? opts.evidenceIds?.join(',') ?? ''}`;
  if (dedupe.has(dedupeKey)) return;
  dedupe.add(dedupeKey);

  const primaryEvidence =
    opts.evidence
    ?? opts.evidenceIds?.map((id) => opts.evidenceLookup?.get(id)).find((item): item is EvidenceObject => item != null);

  const { score, roleScore } = scoreObservation({
    value: cleaned,
    source,
    fact: opts.fact ?? null,
    evidence: primaryEvidence,
  });

  observations.push({
    value: cleaned,
    normalizedValue,
    source,
    score,
    roleScore,
    evidenceIds: [...new Set([...(opts.evidenceIds ?? []), ...(opts.evidence ? [opts.evidence.id] : [])])],
    sourceFactIds: [...new Set(opts.sourceFactIds ?? [])],
  });
}

function collectRegexMatches(text: string, regex: RegExp): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(regex)) {
    const value = match[1];
    if (typeof value === 'string' && value.trim().length > 0) {
      matches.push(value);
    }
  }
  return matches;
}

function chooseRepresentativeValue(observations: ContractorObservation[]): string {
  const byValue = new Map<string, { count: number; bestSourceRank: number; bestScore: number; value: string }>();
  for (const observation of observations) {
    const key = observation.value.toLowerCase();
    const sourceRank =
      observation.source === 'typed_fields.vendor_name' ? 6 :
      observation.source === 'structured_fields.contractor_name.explicit_definition' ? 5 :
      observation.source === 'fact_map.contractor_name' ? 4 :
      observation.source === 'evidence.defined_party' || observation.source === 'evidence.contract_between' ? 3 :
      observation.source === 'evidence.signature_block' ? 2 :
      1;
    const existing = byValue.get(key);
    if (!existing) {
      byValue.set(key, {
        count: 1,
        bestSourceRank: sourceRank,
        bestScore: observation.score,
        value: observation.value,
      });
      continue;
    }
    existing.count += 1;
    if (
      sourceRank > existing.bestSourceRank
      || (sourceRank === existing.bestSourceRank && observation.score > existing.bestScore)
    ) {
      existing.bestSourceRank = sourceRank;
      existing.bestScore = observation.score;
      existing.value = observation.value;
    }
  }

  return [...byValue.values()]
    .sort((left, right) => {
      if (right.bestSourceRank !== left.bestSourceRank) return right.bestSourceRank - left.bestSourceRank;
      if (right.bestScore !== left.bestScore) return right.bestScore - left.bestScore;
      if (right.count !== left.count) return right.count - left.count;
      if (Number(hasLegalEntitySuffix(right.value)) !== Number(hasLegalEntitySuffix(left.value))) {
        return Number(hasLegalEntitySuffix(right.value)) - Number(hasLegalEntitySuffix(left.value));
      }
      if (left.value.length !== right.value.length) return left.value.length - right.value.length;
      return left.value.localeCompare(right.value);
    })[0]?.value ?? observations[0]!.value;
}

function aggregateCandidates(observations: ContractorObservation[]): RankedContractorCandidate[] {
  const groups: ContractorObservation[][] = [];

  for (const observation of observations) {
    const existing = groups.find((group) =>
      group.some((candidate) => organizationNamesLookEquivalent(candidate.value, observation.value)),
    );
    if (existing) {
      existing.push(observation);
    } else {
      groups.push([observation]);
    }
  }

  return groups
    .map((group) => {
      const value = chooseRepresentativeValue(group);
      const normalizedValue = normalizeIdentityValue(value);
      return {
        value,
        normalizedValue,
        totalScore: group.reduce((sum, observation) => sum + observation.score, 0),
        roleScore: group.reduce((sum, observation) => sum + observation.roleScore, 0),
        evidenceAnchors: [...new Set(group.flatMap((observation) => observation.evidenceIds))],
        sourceFactIds: [...new Set(group.flatMap((observation) => observation.sourceFactIds))],
        observations: group.map((observation) => ({
          value: observation.value,
          source: observation.source,
          score: observation.score,
          roleScore: observation.roleScore,
          evidenceIds: observation.evidenceIds,
        })),
      } satisfies RankedContractorCandidate;
    })
    .sort((left, right) => {
      if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
      if (right.roleScore !== left.roleScore) return right.roleScore - left.roleScore;
      if (Number(hasLegalEntitySuffix(right.value)) !== Number(hasLegalEntitySuffix(left.value))) {
        return Number(hasLegalEntitySuffix(right.value)) - Number(hasLegalEntitySuffix(left.value));
      }
      return right.observations.length - left.observations.length;
    });
}

function candidatesRemainComparable(
  strongest: RankedContractorCandidate,
  runnerUp: RankedContractorCandidate | undefined,
): boolean {
  if (!runnerUp) return false;

  const scoreGap = strongest.totalScore - runnerUp.totalScore;
  const roleGap = strongest.roleScore - runnerUp.roleScore;
  const runnerUpRoleGrounded = runnerUp.roleScore >= 34;
  const runnerUpMaterial = runnerUp.totalScore >= 40;

  if (!runnerUpRoleGrounded || !runnerUpMaterial) return false;
  if (scoreGap <= 10 && Math.abs(roleGap) <= 14) return true;
  if (scoreGap <= 20 && runnerUp.roleScore >= strongest.roleScore - 8) return true;
  return false;
}

function confidenceFromRanking(
  strongest: RankedContractorCandidate | null,
  runnerUp: RankedContractorCandidate | undefined,
  conflict: boolean,
): number | null {
  if (!strongest) return null;
  if (conflict) return 0.42;
  const dominance = runnerUp ? Math.max(0, strongest.totalScore - runnerUp.totalScore) : 24;
  const raw = 0.58 + Math.min(0.34, strongest.roleScore / 200 + dominance / 140);
  return Math.round(raw * 100) / 100;
}

export function resolveContractorIdentity(document: NormalizedNodeDocument): ContractorIdentityResolution {
  const evidenceLookup = new Map(document.evidence.map((evidence) => [evidence.id, evidence] as const));
  const observations: ContractorObservation[] = [];
  const dedupe = new Set<string>();
  const contractorFact = document.fact_map.contractor_name ?? null;
  const structuredContractor = typeof document.structured_fields.contractor_name === 'string'
    ? document.structured_fields.contractor_name
    : null;
  const structuredSource = document.structured_fields.contractor_name_source === 'explicit_definition'
    ? 'structured_fields.contractor_name.explicit_definition'
    : 'structured_fields.contractor_name.heuristic';

  pushObservation(observations, dedupe, contractorFact?.value as string | null, 'fact_map.contractor_name', {
    evidenceIds: contractorFact?.evidence_refs ?? [],
    sourceFactIds: contractorFact ? ['contractor_name'] : [],
    evidenceLookup,
    fact: contractorFact,
  });

  pushObservation(
    observations,
    dedupe,
    typeof document.typed_fields.vendor_name === 'string' ? document.typed_fields.vendor_name : null,
    'typed_fields.vendor_name',
  );

  pushObservation(
    observations,
    dedupe,
    structuredContractor,
    structuredSource,
  );

  for (const evidence of document.evidence) {
    const text = evidenceText(evidence);
    if (!text) continue;

    for (const regex of DEFINED_PARTY_RE) {
      for (const match of collectRegexMatches(text, regex)) {
        pushObservation(observations, dedupe, match, 'evidence.defined_party', {
          evidence,
        });
      }
    }

    for (const regex of CONTRACT_BETWEEN_RE) {
      for (const match of collectRegexMatches(text, regex)) {
        pushObservation(observations, dedupe, match, 'evidence.contract_between', {
          evidence,
        });
      }
    }

    for (const match of collectRegexMatches(text, INLINE_LABEL_RE)) {
      pushObservation(observations, dedupe, match, 'evidence.inline_label', {
        evidence,
      });
    }

    for (const regex of SIGNATURE_BLOCK_RE) {
      for (const match of collectRegexMatches(text, regex)) {
        pushObservation(observations, dedupe, match, 'evidence.signature_block', {
          evidence,
        });
      }
    }
  }

  const candidates = aggregateCandidates(observations);
  const selected = candidates[0] ?? null;
  const runnerUp = candidates[1];
  const conflict = selected != null && candidatesRemainComparable(selected, runnerUp);
  const confidence = confidenceFromRanking(selected, runnerUp, conflict);

  if (!selected) {
    return {
      selected: null,
      candidates: [],
      conflict: false,
      confidence: null,
      notes: [],
    };
  }

  if (conflict) {
    return {
      selected,
      candidates,
      conflict: true,
      confidence,
      notes: [
        'Multiple contractor candidates remain after OCR-tolerant normalization, and the top candidates have comparable role-grounded evidence.',
      ],
    };
  }

  const notes =
    runnerUp
      ? [
          `Selected dominant contractor candidate "${selected.value}" after OCR-tolerant normalization; weaker alternatives did not carry comparable contractor-role evidence.`,
        ]
      : [];

  return {
    selected,
    candidates,
    conflict: false,
    confidence,
    notes,
  };
}

/**
 * Writes the winning contractor identity from {@link resolveContractorIdentity} into
 * `fact_map.contractor_name` when resolution is unambiguous (`conflict === false`).
 * Preserves the pre-resolution pipeline string in `identity_resolution_source_value` for machine traceability.
 *
 * Does not override when the resolver reports a genuine ambiguity conflict, or when there is no selected candidate.
 */
export function applyContractorIdentityResolutionToNormalizedDocument(
  document: NormalizedNodeDocument,
): NormalizedNodeDocument {
  const resolution = resolveContractorIdentity(document);
  if (resolution.conflict || !resolution.selected) {
    return document;
  }

  const selected = resolution.selected;
  const nextValue = selected.value.trim();
  if (!nextValue) {
    return document;
  }

  const existing = document.fact_map.contractor_name ?? null;
  if (!existing) {
    return document;
  }

  const prevRaw = existing.value;
  const prevStr = typeof prevRaw === 'string' ? prevRaw.trim() : '';
  if (prevStr === nextValue) {
    return document;
  }

  const mergedEvidence = [...new Set([...existing.evidence_refs, ...selected.evidenceAnchors])];
  const confidence = Math.max(
    existing.confidence,
    resolution.confidence ?? 0,
  );

  const updatedFact: PipelineFact = {
    ...existing,
    value: selected.value,
    display_value: factDisplayValue(selected.value),
    evidence_refs: mergedEvidence,
    confidence,
    ...(prevStr.length > 0 ? { identity_resolution_source_value: prevStr } : {}),
  };

  const facts = document.facts.map((fact) =>
    fact.key === 'contractor_name' ? updatedFact : fact,
  );

  return {
    ...document,
    facts,
    fact_map: {
      ...document.fact_map,
      contractor_name: updatedFact,
    },
  };
}

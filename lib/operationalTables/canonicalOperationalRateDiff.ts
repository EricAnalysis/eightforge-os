import type {
  CanonicalOperationalTableRow,
  OperationalTableRowEvidenceRef,
} from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';

export type OperationalRateVarianceStatus =
  | 'within_ceiling'
  | 'exceeds_ceiling'
  | 'below_authorized'
  | 'passthrough'
  | 'tm_rate'
  | 'ambiguous_match'
  | 'no_contract_match'
  | 'low_confidence_contract_match';

export type OperationalRateDiffCandidate = {
  contract_row_id: string;
  contract_description: string | null;
  contract_unit: string | null;
  contract_authorized_rate: number | null;
  match_confidence: number;
  match_reasons: string[];
  mismatch_reasons: string[];
  quality_flags: string[];
  contract_evidence_refs: OperationalTableRowEvidenceRef[];
};

export type CanonicalOperationalRateDiffRow = {
  invoice_row_id: string;
  contract_row_id: string | null;
  invoice_description: string | null;
  contract_description: string | null;
  invoice_unit: string | null;
  contract_unit: string | null;
  invoice_unit_price: number | null;
  contract_authorized_rate: number | null;
  variance: number | null;
  variance_percent: number | null;
  match_confidence: number;
  variance_status: OperationalRateVarianceStatus;
  match_reasons: string[];
  mismatch_reasons: string[];
  source_document_family: string;
  assembly_semantic_mode: string;
  candidate_matches: OperationalRateDiffCandidate[];
  invoice_evidence_refs: OperationalTableRowEvidenceRef[];
  contract_evidence_refs: OperationalTableRowEvidenceRef[];
};

export type CanonicalOperationalRateDiff = {
  project_id: string | null;
  invoice_document_id: string;
  contract_document_id: string;
  generated_at: string;
  rows: CanonicalOperationalRateDiffRow[];
  summary: {
    matched_rows: number;
    ambiguous_rows: number;
    unmatched_rows: number;
    low_confidence_matches: number;
    rows_exceeding_contract_ceiling: number;
    passthrough_rows: number;
    tm_rows: number;
  };
};

export type BuildCanonicalOperationalRateDiffInput = {
  project_id?: string | null;
  invoice_document_id: string;
  contract_document_id: string;
  invoice_rows: readonly CanonicalOperationalTableRow[];
  contract_rows: readonly CanonicalOperationalTableRow[];
  generated_at?: string;
};

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'to',
  'from',
  'of',
  'for',
  'with',
  'without',
  'per',
  'unit',
  'price',
  'rate',
]);

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function tokens(value: unknown): Set<string> {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
}

function similarity(left: unknown, right: unknown): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function normalizeUnit(value: unknown): string | null {
  const text = normalizeText(value).replace(/\s+/g, '');
  if (!text) return null;
  if (['cy', 'cyd', 'cubicyard', 'cubicyards'].includes(text)) return 'cy';
  if (['hr', 'hrs', 'hour', 'hours'].includes(text)) return 'hour';
  if (['ea', 'each'].includes(text)) return 'ea';
  if (['tn', 'ton', 'tons'].includes(text)) return 'ton';
  if (['lf', 'linearfoot', 'linearfeet'].includes(text)) return 'lf';
  if (['ls', 'lumpsum'].includes(text)) return 'ls';
  if (['tree', 'trees'].includes(text)) return 'tree';
  if (['stump', 'stumps'].includes(text)) return 'stump';
  if (['pound', 'pounds', 'lb', 'lbs'].includes(text)) return 'pound';
  if (['unit', 'units'].includes(text)) return 'unit';
  if (text === 'row') return 'row';
  return text;
}

function compatibleUnit(left: unknown, right: unknown): boolean {
  const l = normalizeUnit(left);
  const r = normalizeUnit(right);
  if (!l || !r) return false;
  return l === r;
}

function sameText(left: unknown, right: unknown): boolean {
  const l = normalizeText(left);
  const r = normalizeText(right);
  return l.length > 0 && r.length > 0 && l === r;
}

function rowText(row: CanonicalOperationalTableRow): string {
  return [
    row.category,
    row.service_item,
    row.description,
    row.mileage_tier,
    row.site_type,
  ].filter(Boolean).join(' ');
}

function candidateAllowed(
  invoice: CanonicalOperationalTableRow,
  contract: CanonicalOperationalTableRow,
): boolean {
  if (!invoice.description && !invoice.service_item) return false;
  if (!contract.description && !contract.service_item) return false;
  if (contract.row_role === 'section_header' || contract.row_role === 'category_header') return false;
  if (contract.row_role === 'unclassified' || contract.row_role === 'header') return false;
  if (invoice.row_role === 'subtotal' || invoice.row_role === 'header') return false;
  return true;
}

function hasAmbiguityFlags(row: CanonicalOperationalTableRow): boolean {
  return Array.isArray(row.ambiguity_flags) && row.ambiguity_flags.length > 0;
}

function hasOcrNormalization(row: CanonicalOperationalTableRow): boolean {
  return Array.isArray(row.ocr_normalization_actions) && row.ocr_normalization_actions.length > 0;
}

function contractQualityFlags(contract: CanonicalOperationalTableRow): string[] {
  const flags: string[] = [];
  if ((contract.confidence ?? 0) < 0.85) flags.push('contract confidence below 0.85');
  if (!contract.unit && contract.row_role !== 'passthrough_rate') flags.push('missing contract unit');
  if (hasOcrNormalization(contract)) flags.push('ocr-normalized contract rate');
  if (hasAmbiguityFlags(contract)) flags.push('ambiguous contract row');
  return flags;
}

function scoreCandidate(
  invoice: CanonicalOperationalTableRow,
  contract: CanonicalOperationalTableRow,
): OperationalRateDiffCandidate {
  const matchReasons: string[] = [];
  const mismatchReasons: string[] = [];
  const qualityFlags = contractQualityFlags(contract);
  let score = 0;
  let weight = 0;

  const descriptionSimilarity = similarity(rowText(invoice), rowText(contract));
  score += descriptionSimilarity * 0.34;
  weight += 0.34;
  if (descriptionSimilarity >= 0.55) {
    matchReasons.push(`description similarity ${descriptionSimilarity.toFixed(2)}`);
  } else {
    mismatchReasons.push(`description similarity ${descriptionSimilarity.toFixed(2)} below 0.55`);
  }

  if (invoice.unit || contract.unit) {
    weight += 0.18;
    if (compatibleUnit(invoice.unit, contract.unit)) {
      score += 0.18;
      matchReasons.push(`unit compatible: ${invoice.unit} to ${contract.unit}`);
    } else {
      score -= 0.08;
      mismatchReasons.push(`unit mismatch: ${invoice.unit ?? 'missing'} vs ${contract.unit ?? 'missing'}`);
    }
  }

  if (invoice.mileage_tier || contract.mileage_tier) {
    weight += 0.14;
    if (sameText(invoice.mileage_tier, contract.mileage_tier)) {
      score += 0.14;
      matchReasons.push(`mileage tier aligned: ${invoice.mileage_tier}`);
    } else {
      score -= 0.08;
      mismatchReasons.push(`mileage tier mismatch: ${invoice.mileage_tier ?? 'missing'} vs ${contract.mileage_tier ?? 'missing'}`);
    }
  }

  if (invoice.site_type || contract.site_type) {
    weight += 0.12;
    if (sameText(invoice.site_type, contract.site_type)) {
      score += 0.12;
      matchReasons.push(`site flow aligned: ${invoice.site_type}`);
    } else {
      score -= 0.07;
      mismatchReasons.push(`site flow mismatch: ${invoice.site_type ?? 'missing'} vs ${contract.site_type ?? 'missing'}`);
    }
  }

  const categorySimilarity = Math.max(
    similarity(invoice.category, contract.category),
    similarity(invoice.service_item, contract.service_item),
    similarity(invoice.category, contract.service_item),
    similarity(invoice.service_item, contract.category),
  );
  if (invoice.category || invoice.service_item || contract.category || contract.service_item) {
    weight += 0.12;
    if (categorySimilarity >= 0.4) {
      score += categorySimilarity * 0.12;
      matchReasons.push(`category/service alignment ${categorySimilarity.toFixed(2)}`);
    } else {
      mismatchReasons.push(`category/service alignment ${categorySimilarity.toFixed(2)} below 0.40`);
    }
  }

  weight += 0.10;
  if (
    contract.row_role === 'unit_rate_definition' ||
    contract.row_role === 'passthrough_rate' ||
    contract.row_role === 'hourly_tm_rate' ||
    contract.row_role === 'lump_sum_rate' ||
    contract.row_role === 'mileage_tier_rate'
  ) {
    score += 0.10;
    matchReasons.push(`semantic role compatible: ${contract.row_role}`);
  } else {
    mismatchReasons.push(`semantic role not rate-authorizing: ${contract.row_role}`);
  }

  if ((contract.confidence ?? 0) < 0.85) {
    score -= 0.10;
    mismatchReasons.push(`contract confidence ${(contract.confidence ?? 0).toFixed(2)} below 0.85`);
  }
  if (!contract.unit && contract.row_role !== 'passthrough_rate') {
    score -= 0.08;
    mismatchReasons.push('missing contract unit');
  }
  if (hasOcrNormalization(contract)) {
    score -= 0.05;
    mismatchReasons.push('contract rate has OCR normalization action');
  }
  if (hasAmbiguityFlags(contract)) {
    score -= 0.30;
    mismatchReasons.push('contract row has ambiguity flags');
  }

  return {
    contract_row_id: contract.row_id,
    contract_description: contract.description ?? null,
    contract_unit: contract.unit ?? null,
    contract_authorized_rate: typeof contract.unit_price === 'number' ? contract.unit_price : null,
    match_confidence: weight > 0 ? Number(Math.max(0, Math.min(1, score / weight)).toFixed(3)) : 0,
    match_reasons: matchReasons,
    mismatch_reasons: mismatchReasons,
    quality_flags: qualityFlags,
    contract_evidence_refs: contract.evidence_refs ?? [],
  };
}

function generateCandidates(
  invoice: CanonicalOperationalTableRow,
  contractRows: readonly CanonicalOperationalTableRow[],
): OperationalRateDiffCandidate[] {
  const candidates = contractRows
    .filter((contract) => candidateAllowed(invoice, contract))
    .map((contract) => scoreCandidate(invoice, contract))
    .filter((candidate) => candidate.match_confidence >= 0.25)
    .sort((left, right) => right.match_confidence - left.match_confidence || left.contract_row_id.localeCompare(right.contract_row_id));
  const nonAmbiguous = candidates.filter((candidate) => !candidate.quality_flags.includes('ambiguous contract row'));
  return nonAmbiguous.length > 0 ? nonAmbiguous : candidates;
}

function varianceStatus(params: {
  invoice: CanonicalOperationalTableRow;
  contract: CanonicalOperationalTableRow | null;
  ambiguous: boolean;
  noMatch: boolean;
  lowConfidenceMatch: boolean;
  variance: number | null;
}): OperationalRateVarianceStatus {
  if (params.ambiguous) return 'ambiguous_match';
  if (params.noMatch || !params.contract) return 'no_contract_match';
  if (params.invoice.row_role === 'passthrough_rate' || params.contract.row_role === 'passthrough_rate') return 'passthrough';
  if (params.contract.row_role === 'hourly_tm_rate') return 'tm_rate';
  if (params.lowConfidenceMatch) return 'low_confidence_contract_match';
  if (params.variance == null) return 'no_contract_match';
  if (params.variance > 0.01) return 'exceeds_ceiling';
  if (params.variance < -0.01) return 'below_authorized';
  return 'within_ceiling';
}

function roundMoney(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}

function roundPercent(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(4));
}

export function buildCanonicalOperationalRateDiff(
  input: BuildCanonicalOperationalRateDiffInput,
): CanonicalOperationalRateDiff {
  const contractById = new Map(input.contract_rows.map((row) => [row.row_id, row]));
  const rows: CanonicalOperationalRateDiffRow[] = input.invoice_rows
    .filter((row) => row.row_role !== 'header' && row.row_role !== 'subtotal')
    .map((invoice) => {
      const candidates = generateCandidates(invoice, input.contract_rows);
      const best = candidates[0] ?? null;
      const second = candidates[1] ?? null;
      const bestContractForQuality = best ? contractById.get(best.contract_row_id) ?? null : null;
      const bestHasQualityFlags = (best?.quality_flags.length ?? 0) > 0;
      const ambiguous = Boolean(
        best?.quality_flags.includes('ambiguous contract row') ||
        (best && second && best.match_confidence >= 0.72 && second.match_confidence >= 0.72 && (best.match_confidence - second.match_confidence) <= 0.08),
      );
      const noMatchThreshold = bestHasQualityFlags ? 0.40 : 0.55;
      const noMatch = !best || best.match_confidence < noMatchThreshold;
      const selected = ambiguous || noMatch ? null : best;
      const contract = selected ? contractById.get(selected.contract_row_id) ?? null : null;
      const lowConfidenceMatch = Boolean(
        contract &&
        (
          (contract.confidence ?? 0) < 0.85 ||
          !contract.unit ||
          hasOcrNormalization(contract)
        ),
      );
      const invoiceUnitPrice = typeof invoice.unit_price === 'number' ? invoice.unit_price : null;
      const contractRate = contract && typeof contract.unit_price === 'number' ? contract.unit_price : null;
      const variance = invoiceUnitPrice != null && contractRate != null
        ? roundMoney(invoiceUnitPrice - contractRate)
        : null;
      const variancePercent = variance != null && contractRate != null && contractRate !== 0
        ? roundPercent(variance / contractRate)
        : null;
      const status = varianceStatus({ invoice, contract, ambiguous, noMatch, lowConfidenceMatch, variance });

      return {
        invoice_row_id: invoice.row_id,
        contract_row_id: contract?.row_id ?? null,
        invoice_description: invoice.description ?? null,
        contract_description: contract?.description ?? null,
        invoice_unit: invoice.unit ?? null,
        contract_unit: contract?.unit ?? null,
        invoice_unit_price: invoiceUnitPrice,
        contract_authorized_rate: contractRate,
        variance,
        variance_percent: variancePercent,
        match_confidence: selected?.match_confidence ?? best?.match_confidence ?? 0,
        variance_status: status,
        match_reasons: selected?.match_reasons ?? best?.match_reasons ?? [],
        mismatch_reasons: [
          ...(selected?.mismatch_reasons ?? best?.mismatch_reasons ?? []),
          ...(ambiguous ? ['multiple high-confidence contract candidates remain ambiguous'] : []),
          ...(bestContractForQuality && hasAmbiguityFlags(bestContractForQuality) ? ['best candidate has ambiguity flags'] : []),
          ...(noMatch ? [`no candidate reached minimum match confidence ${noMatchThreshold.toFixed(2)}`] : []),
        ],
        source_document_family: invoice.source_document_family,
        assembly_semantic_mode: invoice.assembly_semantic_mode,
        candidate_matches: candidates.slice(0, 5),
        invoice_evidence_refs: invoice.evidence_refs ?? [],
        contract_evidence_refs: contract?.evidence_refs ?? [],
      };
    });

  return {
    project_id: input.project_id ?? null,
    invoice_document_id: input.invoice_document_id,
    contract_document_id: input.contract_document_id,
    generated_at: input.generated_at ?? new Date().toISOString(),
    rows,
    summary: {
      matched_rows: rows.filter((row) => !['ambiguous_match', 'no_contract_match'].includes(row.variance_status)).length,
      ambiguous_rows: rows.filter((row) => row.variance_status === 'ambiguous_match').length,
      unmatched_rows: rows.filter((row) => row.variance_status === 'no_contract_match').length,
      low_confidence_matches: rows.filter((row) => row.variance_status === 'low_confidence_contract_match').length,
      rows_exceeding_contract_ceiling: rows.filter((row) => row.variance_status === 'exceeds_ceiling').length,
      passthrough_rows: rows.filter((row) => row.variance_status === 'passthrough').length,
      tm_rows: rows.filter((row) => row.variance_status === 'tm_rate').length,
    },
  };
}

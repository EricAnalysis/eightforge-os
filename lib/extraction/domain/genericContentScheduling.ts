import { hashCanonical } from '@/lib/extraction/domain/hash';

export const GENERIC_CONTENT_POLICY = Object.freeze({
  decoder: 'byte-mime-pdf-decoder-v1',
  eligibility: 'native-region-quality-v1',
  scheduler: 'all-page-region-scheduler-v1',
  classifier: 'source-grounded-family-classifier-v1',
  nativeTextMinCharacters: 80,
  nativeTextMinWords: 12,
});

export type GenericRegion = {
  readonly region_id: string;
  readonly page: number;
  readonly bounding_box: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
  readonly native_text: string;
  readonly structural_kind: 'text' | 'table' | 'form' | 'unknown';
};

export type GenericSourceContentView = {
  readonly source_sha256: string;
  readonly byte_length: number;
  readonly media_type_sniffed: string;
  readonly page_count: number;
  readonly regions: readonly GenericRegion[];
};

export type GenericRegionDecision = {
  readonly region_id: string;
  readonly page: number;
  readonly bounding_box: GenericRegion['bounding_box'];
  readonly structural_kind: GenericRegion['structural_kind'];
  readonly native_character_count: number;
  readonly native_word_count: number;
  readonly action: 'ocr' | 'skip';
  readonly reason: 'insufficient_native_text' | 'adequate_native_text';
};

export type SourceGroundedFamily =
  | 'contract'
  | 'invoice'
  | 'ticket'
  | 'report'
  | 'generic';

export type SourceGroundedClassification = {
  readonly family: SourceGroundedFamily;
  readonly matched_signals: readonly string[];
  readonly policy_version: typeof GENERIC_CONTENT_POLICY.classifier;
};

export type GenericContentAnalysis = {
  readonly policy: typeof GENERIC_CONTENT_POLICY;
  readonly media_type_sniffed: string;
  readonly page_count: number;
  readonly decisions: readonly GenericRegionDecision[];
  readonly pages_scheduled_for_ocr: readonly number[];
  readonly classification: SourceGroundedClassification;
  readonly content_extraction_fingerprint: string;
};

function readableWordCount(text: string): number {
  return text.match(/[A-Za-z0-9][A-Za-z0-9'/-]*/g)?.length ?? 0;
}

function normalizedSignals(
  verifiedTexts: readonly string[],
  structuralKinds: readonly GenericRegion['structural_kind'][],
): string[] {
  const text = verifiedTexts.join('\n').toLowerCase();
  const signals = new Set<string>();
  const match = (signal: string, pattern: RegExp) => {
    if (pattern.test(text)) signals.add(signal);
  };
  match('contract_language', /\b(contract|agreement|contractor|scope of work)\b/);
  match('rate_schedule_language', /\b(unit price|rate schedule|price schedule)\b/);
  match('invoice_language', /\b(invoice|amount due|bill to|remit)\b/);
  match('ticket_language', /\b(ticket|load number|truck number|cubic yards?)\b/);
  match('report_language', /\b(daily report|progress report|inspection report|findings?)\b/);
  if (structuralKinds.includes('table')) signals.add('observed_table_structure');
  if (structuralKinds.includes('form')) signals.add('observed_form_structure');
  return [...signals].sort();
}

export function classifySourceGroundedContent(input: {
  readonly verified_texts: readonly string[];
  readonly structural_kinds: readonly GenericRegion['structural_kind'][];
}): SourceGroundedClassification {
  const matchedSignals = normalizedSignals(
    input.verified_texts,
    input.structural_kinds,
  );
  const has = (signal: string) => matchedSignals.includes(signal);
  const family: SourceGroundedFamily =
    has('invoice_language') ? 'invoice'
      : has('ticket_language') ? 'ticket'
        : has('contract_language') || has('rate_schedule_language') ? 'contract'
          : has('report_language') ? 'report'
            : 'generic';
  return {
    family,
    matched_signals: matchedSignals,
    policy_version: GENERIC_CONTENT_POLICY.classifier,
  };
}

export function scheduleGenericContentExtraction(
  view: GenericSourceContentView,
): GenericContentAnalysis {
  if (view.media_type_sniffed !== 'application/pdf') {
    throw new Error(`generic content decoder does not support ${view.media_type_sniffed}`);
  }
  if (view.page_count < 1 || !Number.isInteger(view.page_count)) {
    throw new Error('generic content view requires a positive page count');
  }
  const decisions = [...view.regions]
    .sort((left, right) => left.page - right.page
      || left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0
      || left.region_id.localeCompare(right.region_id))
    .map((region): GenericRegionDecision => {
      const nativeText = region.native_text.trim();
      const nativeCharacterCount = nativeText.length;
      const nativeWordCount = readableWordCount(nativeText);
      const adequate = nativeCharacterCount >= GENERIC_CONTENT_POLICY.nativeTextMinCharacters
        && nativeWordCount >= GENERIC_CONTENT_POLICY.nativeTextMinWords;
      return {
        region_id: region.region_id,
        page: region.page,
        bounding_box: region.bounding_box,
        structural_kind: region.structural_kind,
        native_character_count: nativeCharacterCount,
        native_word_count: nativeWordCount,
        action: adequate ? 'skip' : 'ocr',
        reason: adequate ? 'adequate_native_text' : 'insufficient_native_text',
      };
    });
  const pagesScheduledForOcr = [...new Set(
    decisions.filter((decision) => decision.action === 'ocr')
      .map((decision) => decision.page),
  )].sort((left, right) => left - right);
  const classification = classifySourceGroundedContent({
    verified_texts: view.regions.map((region) => region.native_text),
    structural_kinds: view.regions.map((region) => region.structural_kind),
  });
  const semanticAnalysis = {
    source_sha256: view.source_sha256,
    byte_length: view.byte_length,
    media_type_sniffed: view.media_type_sniffed,
    page_count: view.page_count,
    policy: GENERIC_CONTENT_POLICY,
    decisions,
    classification,
  };
  return {
    policy: GENERIC_CONTENT_POLICY,
    media_type_sniffed: view.media_type_sniffed,
    page_count: view.page_count,
    decisions,
    pages_scheduled_for_ocr: pagesScheduledForOcr,
    classification,
    content_extraction_fingerprint: hashCanonical(semanticAnalysis),
  };
}

// lib/server/documentExtraction.ts
// Server-side document extraction: text decoding, PDF text extraction, and fallbacks.

const TEXT_EXTENSIONS = new Set([
  'txt',
  'json',
  'csv',
  'md',
  'html',
  'htm',
  'xml',
]);
const TEXT_MIMES = new Set([
  'text/plain',
  'application/json',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/xml',
  'text/xml',
]);

const MAX_PREVIEW_CHARS = 4000;
const MAX_MENTIONS = 15;

// Keyword lists for heuristic field extraction (case-insensitive match)
const RATE_KEYWORDS = [
  'rate', 'price', 'per ton', 'per cubic yard', 'per mile', 'hourly',
  'unit price', 'tipping fee', 'haul rate',
];
const MATERIAL_KEYWORDS = [
  'debris', 'vegetative', 'c&d', 'ash', 'stump', 'soil', 'sand', 'mulch',
  'metal', 'hazardous', 'white goods',
];
const SCOPE_KEYWORDS = [
  'scope', 'collection', 'removal', 'hauling', 'reduction', 'monitoring',
  'disposal', 'pickup', 'loading',
];
const COMPLIANCE_KEYWORDS = [
  'termination', 'remedies', 'equal opportunity', 'breach', 'compliance',
  'fema', 'eligibility', 'ineligible',
];

export type DocumentMetadata = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  storage_path: string;
};

export type ExtractionPayload = {
  status: string;
  source: string;
  summary: string;
  document_id: string;
  document_title: string;
  analyzed_at: string;
  file: {
    name: string;
    path: string;
    mime_type: string | null;
    size_bytes: number | null;
  };
  extraction: {
    mode: 'text' | 'pdf_text' | 'pdf_fallback' | 'binary_fallback';
    text_preview: string | null;
    detected_document_type: string | null;
  };
  fields: {
    detected_document_type: string | null;
    file_name: string;
    title: string | null;
    rate_mentions?: string[];
    material_mentions?: string[];
    scope_mentions?: string[];
    compliance_mentions?: string[];
    detected_keywords?: string[];
  };
};

function getExtension(fileName: string): string {
  const last = fileName.split('.').pop();
  return last ? last.toLowerCase() : '';
}

function isTextLike(fileName: string, mimeType: string | null): boolean {
  const ext = getExtension(fileName);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (mimeType && TEXT_MIMES.has(mimeType.toLowerCase())) return true;
  return false;
}

function isPdf(fileName: string, mimeType: string | null): boolean {
  const ext = getExtension(fileName);
  if (ext === 'pdf') return true;
  if (mimeType && mimeType.toLowerCase() === 'application/pdf') return true;
  return false;
}

function decodeTextPreview(bytes: ArrayBuffer): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const full = decoder.decode(bytes);
    return full.length > MAX_PREVIEW_CHARS
      ? full.slice(0, MAX_PREVIEW_CHARS)
      : full;
  } catch {
    return null;
  }
}

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ').trim();
}

/**
 * Splits normalized text into sentence- or line-like chunks for heuristic search.
 */
function splitIntoChunks(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  const chunks = normalized
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  return [...new Set(chunks)];
}

function chunkContainsAnyKeyword(chunkLower: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => chunkLower.includes(kw.toLowerCase()));
}

/**
 * Finds unique chunks that contain any of the given keywords, limited to maxItems.
 */
function findMentions(
  chunks: string[],
  keywords: readonly string[],
  maxItems: number
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks) {
    if (out.length >= maxItems) break;
    const lower = chunk.toLowerCase();
    if (!chunkContainsAnyKeyword(lower, keywords)) continue;
    const key = normalizeWhitespace(chunk).slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeWhitespace(chunk).slice(0, 500));
  }
  return out;
}

export type DerivedFields = {
  rate_mentions: string[];
  material_mentions: string[];
  scope_mentions: string[];
  compliance_mentions: string[];
  detected_keywords: string[];
};

/**
 * First-pass heuristic extraction from extracted text. No AI; regex and keyword lists only.
 */
function deriveHeuristicFields(text: string): DerivedFields {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return {
      rate_mentions: [],
      material_mentions: [],
      scope_mentions: [],
      compliance_mentions: [],
      detected_keywords: [],
    };
  }
  const chunks = splitIntoChunks(normalized);
  const rate_mentions = findMentions(chunks, RATE_KEYWORDS, MAX_MENTIONS);
  const material_mentions = findMentions(chunks, MATERIAL_KEYWORDS, MAX_MENTIONS);
  const scope_mentions = findMentions(chunks, SCOPE_KEYWORDS, MAX_MENTIONS);
  const compliance_mentions = findMentions(chunks, COMPLIANCE_KEYWORDS, MAX_MENTIONS);

  const keywordSet = new Set<string>();
  const textLower = normalized.toLowerCase();
  [...RATE_KEYWORDS, ...MATERIAL_KEYWORDS, ...SCOPE_KEYWORDS, ...COMPLIANCE_KEYWORDS].forEach(
    (kw) => {
      if (textLower.includes(kw.toLowerCase())) keywordSet.add(kw);
    }
  );
  const detected_keywords = [...keywordSet].slice(0, MAX_MENTIONS);

  return {
    rate_mentions,
    material_mentions,
    scope_mentions,
    compliance_mentions,
    detected_keywords,
  };
}

function applyDerivedFields(
  payload: ExtractionPayload,
  fullText: string
): void {
  const derived = deriveHeuristicFields(fullText);
  payload.fields.rate_mentions = derived.rate_mentions;
  payload.fields.material_mentions = derived.material_mentions;
  payload.fields.scope_mentions = derived.scope_mentions;
  payload.fields.compliance_mentions = derived.compliance_mentions;
  payload.fields.detected_keywords = derived.detected_keywords;
}

/**
 * Extracts text from PDF bytes using pdf-parse. Returns null on failure or empty result.
 */
async function extractPdfText(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const pdf = (await import('pdf-parse')).default as
      | ((buffer: Buffer) => Promise<{ text?: string }>)
      | undefined;
    if (typeof pdf !== 'function') return null;
    const buffer = Buffer.from(bytes);
    const result = await pdf(buffer);
    const raw = result?.text;
    if (typeof raw !== 'string') return null;
    const text = normalizeWhitespace(raw);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function buildBase(
  metadata: DocumentMetadata,
  mode: 'text' | 'pdf_text' | 'pdf_fallback' | 'binary_fallback',
  textPreview: string | null
): ExtractionPayload {
  const title = metadata.title ?? metadata.name;
  return {
    status: 'completed',
    source: 'server_analysis',
    summary: 'Server-side extraction completed',
    document_id: metadata.id,
    document_title: title,
    analyzed_at: new Date().toISOString(),
    file: {
      name: metadata.name,
      path: metadata.storage_path,
      mime_type: null,
      size_bytes: null,
    },
    extraction: {
      mode,
      text_preview: textPreview,
      detected_document_type: metadata.document_type ?? null,
    },
    fields: {
      detected_document_type: metadata.document_type ?? null,
      file_name: metadata.name,
      title: metadata.title ?? null,
    },
  };
}

/**
 * Extracts structured information from file bytes. Text-like files get a preview;
 * PDFs attempt real text extraction, then fall back to metadata-only; other binary get fallback.
 */
export async function extractDocument(
  metadata: DocumentMetadata,
  fileBytes: ArrayBuffer,
  mimeType: string | null,
  fileName: string
): Promise<ExtractionPayload> {
  const size = fileBytes.byteLength;
  const ext = getExtension(fileName);

  if (isTextLike(fileName, mimeType)) {
    const fullDecoded = decodeTextPreview(fileBytes);
    const textPreview =
      fullDecoded != null && fullDecoded.length > MAX_PREVIEW_CHARS
        ? fullDecoded.slice(0, MAX_PREVIEW_CHARS)
        : fullDecoded;
    const payload = buildBase(metadata, 'text', textPreview);
    payload.file.mime_type = mimeType;
    payload.file.size_bytes = size;
    if (fullDecoded && fullDecoded.length > 0) {
      applyDerivedFields(payload, fullDecoded);
    }
    return payload;
  }

  if (isPdf(fileName, mimeType)) {
    const extractedText = await extractPdfText(fileBytes);
    const textPreview =
      extractedText != null && extractedText.length > 0
        ? extractedText.length > MAX_PREVIEW_CHARS
          ? extractedText.slice(0, MAX_PREVIEW_CHARS)
          : extractedText
        : null;

    if (textPreview != null && textPreview.length > 0) {
      const payload = buildBase(metadata, 'pdf_text', textPreview);
      payload.file.mime_type = mimeType ?? 'application/pdf';
      payload.file.size_bytes = size;
      applyDerivedFields(payload, extractedText ?? '');
      return payload;
    }

    const payload = buildBase(metadata, 'pdf_fallback', null);
    payload.file.mime_type = mimeType ?? 'application/pdf';
    payload.file.size_bytes = size;
    payload.summary =
      'File received; PDF extraction is not yet deeply parsed server-side.';
    return payload;
  }

  const payload = buildBase(metadata, 'binary_fallback', null);
  payload.file.mime_type = mimeType;
  payload.file.size_bytes = size;
  return payload;
}

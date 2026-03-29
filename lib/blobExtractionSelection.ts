export type BlobExtractionRow = {
  id?: string | null;
  created_at?: string | null;
  data?: Record<string, unknown> | null;
};

function hasMeaningfulFieldValue(
  value: unknown,
  opts: { treatZeroAsMeaningful: boolean },
): boolean {
  if (value == null) return false;

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    return opts.treatZeroAsMeaningful ? true : value > 0;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulFieldValue(item, opts));
  }

  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasMeaningfulFieldValue(item, opts),
    );
  }

  return false;
}

/**
 * True when the blob carries PDF body text or evidence under content_layers_v1 (parser-native path).
 * Without this, {@link pickPreferredExtractionBlob} skips newer rows that only populate layers and
 * falls back to an older OCR blob — the live document page then never sees page-level clauses.
 */
function hasPdfContentLayersBody(extraction: Record<string, unknown> | null): boolean {
  if (!extraction) return false;
  const layers = extraction.content_layers_v1 as Record<string, unknown> | null | undefined;
  if (layers == null || typeof layers !== 'object') return false;
  const pdf = layers.pdf as Record<string, unknown> | null | undefined;
  if (pdf == null || typeof pdf !== 'object') return false;

  const text = pdf.text as Record<string, unknown> | null | undefined;
  const pages = text?.pages;
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (page == null || typeof page !== 'object') continue;
      const p = page as Record<string, unknown>;
      const blocks = p.plain_text_blocks;
      if (
        Array.isArray(blocks)
        && blocks.some((b) => {
          const t = (b as { text?: unknown }).text;
          return typeof t === 'string' && t.trim().length > 0;
        })
      ) {
        return true;
      }
      const pageText = p.text;
      if (typeof pageText === 'string' && pageText.trim().length > 0) return true;
    }
  }

  const pdfEvidence = pdf.evidence;
  return Array.isArray(pdfEvidence) && pdfEvidence.length > 0;
}

export function hasUsableExtractionBlobData(
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!data) return false;

  const extraction = (data.extraction as Record<string, unknown> | null) ?? null;
  const fields = (data.fields as Record<string, unknown> | null) ?? null;
  const evidence = (extraction?.evidence_v1 as Record<string, unknown> | null) ?? null;

  if (hasPdfContentLayersBody(extraction)) return true;

  const textPreview = typeof extraction?.text_preview === 'string'
    ? extraction.text_preview.trim()
    : '';
  if (textPreview.length > 0) return true;

  const pageText =
    (evidence?.page_text as Array<{ text?: string | null }> | null | undefined) ?? [];
  if (pageText.some((page) => typeof page?.text === 'string' && page.text.trim().length > 0)) {
    return true;
  }

  if (
    hasMeaningfulFieldValue(fields?.typed_fields, { treatZeroAsMeaningful: true }) ||
    hasMeaningfulFieldValue(evidence?.structured_fields, { treatZeroAsMeaningful: true }) ||
    hasMeaningfulFieldValue(evidence?.section_signals, { treatZeroAsMeaningful: false })
  ) {
    return true;
  }

  const mentionKeys = [
    'rate_mentions',
    'material_mentions',
    'scope_mentions',
    'compliance_mentions',
    'detected_keywords',
  ] as const;

  return mentionKeys.some((key) => {
    const value = fields?.[key];
    return Array.isArray(value) && value.length > 0;
  });
}

export function pickPreferredExtractionBlob<T extends BlobExtractionRow>(
  rows: readonly T[] | null | undefined,
): T | null {
  if (!rows || rows.length === 0) return null;
  return rows.find((row) => hasUsableExtractionBlobData(row.data ?? null)) ?? rows[0] ?? null;
}

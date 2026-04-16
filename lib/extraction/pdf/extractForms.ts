import type { ExtractionGap } from '@/lib/extraction/types';
import type { PdfLayout } from '@/lib/extraction/pdf/extractText';
import { stripUnsafeTextControls } from '@/lib/extraction/textSanitization';

export interface PdfFormField {
  id: string;
  page_number: number;
  label: string;
  value: string;
  nearby_text?: string;
  confidence: number;
}

export interface PdfFormExtractionResult {
  fields: PdfFormField[];
  confidence: number;
  gaps: ExtractionGap[];
}

const FIELD_PATTERNS = [
  /^([A-Z][A-Za-z0-9 #/&().,'-]{2,48})\s*[:\-]\s*(.+)$/i,
  /^([A-Z][A-Za-z0-9 #/&().,'-]{2,48})\s*[._]{2,}\s*(.+)$/i,
];

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.page ?? 'global'}`,
    source: 'pdf',
    ...input,
  };
}

function parseField(text: string): { label: string; value: string } | null {
  const candidate = stripUnsafeTextControls(text).trim();
  if (candidate.length < 4 || candidate.length > 160) return null;

  for (const pattern of FIELD_PATTERNS) {
    const match = candidate.match(pattern);
    const label = match?.[1]?.trim();
    const value = match?.[2]?.trim();
    if (!label || !value) continue;
    if (value.length > 120) continue;
    return { label, value };
  }

  return null;
}

export function buildPdfFormExtraction(params: {
  layout: PdfLayout;
}): PdfFormExtractionResult {
  const fields: PdfFormField[] = [];
  const gaps: ExtractionGap[] = [...params.layout.gaps];

  for (const page of params.layout.pages) {
    page.lines.forEach((line, index) => {
      if (line.kind !== 'form_candidate') return;
      const parsed = parseField(line.text);
      if (!parsed) return;
      fields.push({
        id: `pdf:form:p${page.page_number}:f${fields.length + 1}`,
        page_number: page.page_number,
        label: parsed.label,
        value: parsed.value,
        nearby_text:
          stripUnsafeTextControls(page.lines[index + 1]?.text ?? '').trim() ||
          stripUnsafeTextControls(page.lines[index - 1]?.text ?? '').trim() ||
          undefined,
        confidence: 0.86,
      });
    });
  }

  if (fields.length === 0) {
    gaps.push(buildGap({
      category: 'form_fields_missing',
      severity: 'info',
      message: 'No form-like label/value fields were detected in the PDF.',
    }));
  }

  const confidence = fields.length > 0
    ? Number((fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length).toFixed(3))
    : 0;

  return {
    fields,
    confidence,
    gaps,
  };
}

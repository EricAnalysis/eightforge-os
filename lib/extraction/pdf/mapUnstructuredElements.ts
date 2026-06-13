import type { ExtractionGap } from '@/lib/extraction/types';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import type { PdfTableExtractionResult } from '@/lib/extraction/pdf/extractTables';
import type {
  ParsedElementsV1,
  ParsedPdfCoordinates,
  ParsedPdfElement,
  ParsedPdfElementType,
  UnstructuredElement,
  UnstructuredPartitionResult,
} from '@/lib/extraction/pdf/types';
import { stripUnsafeTextControls } from '@/lib/extraction/textSanitization';

const PREVIEW_LIMIT = 180;
const TABLE_MATCH_THRESHOLD = 0.18;
const IGNORED_ELEMENT_TYPES = new Set([
  'footer',
  'header',
  'pagebreak',
  'page-number',
  'pagenumber',
  'image',
  'figurecaption',
]);

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:parsed_elements:${input.category}:${input.page ?? 'global'}`,
    source: 'pdf',
    ...input,
  };
}

function normalizeWhitespace(value: string): string {
  return stripUnsafeTextControls(value).replace(/\s+/g, ' ').trim();
}

function previewText(value: string): string {
  if (value.length <= PREVIEW_LIMIT) return value;
  return `${value.slice(0, PREVIEW_LIMIT - 3).trimEnd()}...`;
}

function stripHtml(value: string): string {
  return normalizeWhitespace(value.replace(/<[^>]+>/g, ' '));
}

function normalizeText(raw: unknown, htmlFallback?: string | null): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return normalizeWhitespace(raw);
  }
  if (htmlFallback && htmlFallback.trim().length > 0) {
    return stripHtml(htmlFallback);
  }
  return '';
}

function normalizeRawType(rawType: string | undefined): string {
  return (rawType ?? '').replace(/[\s-]+/g, '').toLowerCase();
}

function isHeaderLike(text: string): boolean {
  const lettersOnly = text.replace(/[^A-Za-z]/g, '');
  if (lettersOnly.length < 4) return false;
  const uppercaseRatio =
    lettersOnly.replace(/[^A-Z]/g, '').length / Math.max(1, lettersOnly.length);
  return uppercaseRatio >= 0.7 || /^(section|exhibit|attachment|appendix)\b/i.test(text);
}

function classifyElementType(params: {
  rawElement: UnstructuredElement;
  normalizedRawType: string;
  text: string;
  hasDocumentTitle: boolean;
  pageNumber: number | null;
}): ParsedPdfElementType | null {
  const { normalizedRawType, text, hasDocumentTitle, pageNumber } = params;

  if (!normalizedRawType || IGNORED_ELEMENT_TYPES.has(normalizedRawType)) return null;
  if (normalizedRawType === 'table') return 'table';
  if (normalizedRawType === 'listitem') return 'list_item';
  if (
    normalizedRawType === 'narrativetext'
    || normalizedRawType === 'compositeelement'
    || normalizedRawType === 'uncategorizedtext'
  ) {
    return 'narrative_text';
  }

  if (normalizedRawType === 'title') {
    if (!hasDocumentTitle && (pageNumber == null || pageNumber === 1) && !isHeaderLike(text)) {
      return 'title';
    }
    return 'section_header';
  }

  if (normalizedRawType === 'sectionheader') return 'section_header';
  return null;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9$]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 || /\d/.test(token)),
  );
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) matches += 1;
  }

  return matches / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

function tableSearchText(table: PdfTable): string {
  return normalizeWhitespace(
    [
      table.headers.join(' '),
      ...table.header_context,
      ...table.rows.map((row) => row.raw_text),
    ].join(' '),
  );
}

function countTableRows(textAsHtml: string | null | undefined, fallbackText: string): number | null {
  if (textAsHtml) {
    const rowCount = (textAsHtml.match(/<tr\b/gi) ?? []).length;
    if (rowCount > 0) return rowCount;
  }

  const lineCount = fallbackText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
  return lineCount > 1 ? lineCount : null;
}

function normalizeCoordinates(
  raw: UnstructuredElement['metadata'],
): ParsedPdfCoordinates | null {
  const coordinates = raw?.coordinates;
  if (!coordinates || !Array.isArray(coordinates.points) || coordinates.points.length === 0) {
    return null;
  }

  const points = coordinates.points
    .filter((point): point is number[] => Array.isArray(point) && point.length >= 2)
    .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (points.length === 0) return null;

  return {
    points,
    system_name: typeof coordinates.system?.name === 'string' ? coordinates.system.name : undefined,
    layout_width:
      typeof coordinates.system?.layout_width === 'number'
        ? coordinates.system.layout_width
        : undefined,
    layout_height:
      typeof coordinates.system?.layout_height === 'number'
        ? coordinates.system.layout_height
        : undefined,
    orientation:
      typeof coordinates.system?.orientation === 'string'
        ? coordinates.system.orientation
        : undefined,
  };
}

function findMatchingTable(
  pageNumber: number | null,
  text: string,
  tables: PdfTableExtractionResult,
): PdfTable | null {
  if (pageNumber == null) return null;

  const candidates = tables.tables.filter((table) => table.page_number === pageNumber);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let bestMatch: PdfTable | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = overlapScore(text, tableSearchText(candidate));
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= TABLE_MATCH_THRESHOLD ? bestMatch : null;
}

export function mapUnstructuredElements(params: {
  partition: UnstructuredPartitionResult;
  tables: PdfTableExtractionResult;
}): ParsedElementsV1 {
  if (params.partition.status === 'failed') {
    return {
      parser_version: 'parsed_elements_v1',
      source_kind: 'pdf',
      provider: 'unstructured',
      status: 'failed',
      confidence: 0,
      element_count: 0,
      elements: [],
      gaps: [
        buildGap({
          category: 'unstructured_partition_failed',
          severity: 'warning',
          message:
            params.partition.error
            ?? `Unstructured partition request failed with ${params.partition.response_status ?? 'unknown'} status.`,
        }),
      ],
    };
  }

  const elements: ParsedPdfElement[] = [];
  const gaps: ExtractionGap[] = [];
  const sectionLabelsById = new Map<string, string>();
  const currentSectionByPage = new Map<number, string>();
  let hasDocumentTitle = false;
  let lastSeenPage: number | null = null;

  params.partition.elements.forEach((rawElement, index) => {
    const metadata = rawElement.metadata;
    const textAsHtml = typeof metadata?.text_as_html === 'string' ? metadata.text_as_html : null;
    const pageNumber =
      typeof metadata?.page_number === 'number'
        ? metadata.page_number
        : lastSeenPage;
    const text = normalizeText(rawElement.text, textAsHtml);
    const normalizedRawType = normalizeRawType(rawElement.type);
    const elementType = classifyElementType({
      rawElement,
      normalizedRawType,
      text,
      hasDocumentTitle,
      pageNumber,
    });

    if (!elementType) return;
    if (!text && elementType !== 'table') return;

    const sourceElementId =
      typeof rawElement.element_id === 'string' && rawElement.element_id.trim().length > 0
        ? rawElement.element_id.trim()
        : `unstructured:${index + 1}`;
    const parentElementId =
      typeof metadata?.parent_id === 'string' && metadata.parent_id.trim().length > 0
        ? metadata.parent_id.trim()
        : null;
    const categoryDepth =
      typeof metadata?.category_depth === 'number' ? metadata.category_depth : null;
    const matchedTable =
      elementType === 'table' ? findMatchingTable(pageNumber, text, params.tables) : null;
    const sectionLabel =
      elementType === 'title' || elementType === 'section_header'
        ? text || null
        : (parentElementId ? sectionLabelsById.get(parentElementId) ?? null : null)
          ?? (pageNumber != null ? currentSectionByPage.get(pageNumber) ?? null : null);

    const parsedElement: ParsedPdfElement = {
      id: `parsed:${sourceElementId}`,
      provider: 'unstructured',
      source_element_id: sourceElementId,
      element_type: elementType,
      raw_element_type: rawElement.type ?? 'unknown',
      page_number: pageNumber ?? null,
      text,
      text_preview: previewText(text),
      section_label: sectionLabel,
      parent_element_id: parentElementId,
      category_depth: categoryDepth,
      table_linkage:
        elementType === 'table'
          ? {
              matched_table_id: matchedTable?.id ?? null,
              text_as_html: textAsHtml,
              row_count_hint: countTableRows(textAsHtml, text),
              header_context:
                matchedTable != null
                  ? (matchedTable.headers.length > 0
                      ? matchedTable.headers
                      : matchedTable.header_context)
                  : undefined,
            }
          : undefined,
      coordinates: normalizeCoordinates(metadata),
      metadata: {
        api_url: params.partition.api_url,
        strategy: params.partition.strategy,
        page_number: pageNumber ?? null,
        parent_id: parentElementId,
        category_depth: categoryDepth,
        text_as_html_present: Boolean(textAsHtml),
      },
    };

    elements.push(parsedElement);

    if (pageNumber != null) {
      lastSeenPage = pageNumber;
    }
    if ((elementType === 'title' || elementType === 'section_header') && text) {
      if (elementType === 'title') hasDocumentTitle = true;
      sectionLabelsById.set(sourceElementId, text);
      if (pageNumber != null) {
        currentSectionByPage.set(pageNumber, text);
      }
    }
  });

  if (params.partition.elements.length > 0 && elements.length === 0) {
    gaps.push(buildGap({
      category: 'parsed_elements_missing',
      severity: 'info',
      message: 'Unstructured returned elements, but none mapped into supported parsed element types.',
    }));
  }

  const elementsWithPages = elements.filter((element) => element.page_number != null).length;
  if (elements.length > 0 && elementsWithPages < elements.length) {
    gaps.push(buildGap({
      category: 'parsed_elements_partial_page_metadata',
      severity: 'info',
      message: 'Some parsed elements were missing page metadata.',
    }));
  }

  const tableElements = elements.filter((element) => element.element_type === 'table');
  const linkedTables = tableElements.filter((element) => element.table_linkage?.matched_table_id).length;
  const sectionedElements = elements.filter((element) => element.section_label).length;
  const confidence = elements.length === 0
    ? 0
    : Number(
        Math.min(
          0.96,
          0.55
            + (elementsWithPages / Math.max(1, elements.length)) * 0.2
            + (sectionedElements / Math.max(1, elements.length)) * 0.12
            + (tableElements.length > 0
                ? (linkedTables / Math.max(1, tableElements.length)) * 0.09
                : 0.09),
        ).toFixed(3),
      );

  return {
    parser_version: 'parsed_elements_v1',
    source_kind: 'pdf',
    provider: 'unstructured',
    status: 'available',
    confidence,
    element_count: elements.length,
    elements,
    gaps,
  };
}

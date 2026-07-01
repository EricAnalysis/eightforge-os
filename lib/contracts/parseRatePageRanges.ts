const SEGMENT_RE = /^(\d+)(?:\s*-\s*(\d+))?$/;

export class RatePageRangeParseError extends Error {}

export type RatePageRange = { start: number; end: number };

/**
 * Parses operator free-text page hints ("8-12", "8, 10, 14-16") into
 * {start,end} pairs — the storage shape for contract_upload_guidance
 * .rate_schedule_page_ranges, matching document_fact_anchors' startPage/
 * endPage convention. Rejects malformed input rather than dropping or
 * guessing at it.
 */
export function parseRatePageRanges(input: string): RatePageRange[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const segments = trimmed.split(',').map((segment) => segment.trim());
  const ranges: RatePageRange[] = [];

  for (const segment of segments) {
    if (!segment) {
      throw new RatePageRangeParseError('Empty page entry between commas.');
    }

    const match = SEGMENT_RE.exec(segment);
    if (!match) {
      throw new RatePageRangeParseError(
        `Invalid page range "${segment}". Use single pages (e.g. "8") or ranges (e.g. "8-12"), comma-separated.`,
      );
    }

    const start = Number.parseInt(match[1], 10);
    const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : start;

    if (start < 1 || end < 1) {
      throw new RatePageRangeParseError(`Page numbers must be positive: "${segment}".`);
    }
    if (end < start) {
      throw new RatePageRangeParseError(`Range "${segment}" ends before it starts.`);
    }

    ranges.push({ start, end });
  }

  return ranges;
}

/**
 * Expands {start,end} pairs into a flat, deduplicated, ascending page-number
 * array — the shape analyzeContractIntelligence's rateSchedulePages merge
 * already expects (see analyzeContractIntelligence.ts's numberArray merge).
 */
export function expandRatePageRanges(ranges: readonly RatePageRange[]): number[] {
  const pages = new Set<number>();
  for (const range of ranges) {
    for (let page = range.start; page <= range.end; page += 1) {
      pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

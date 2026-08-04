import { collapseWhitespace } from '@/lib/contracts/textCleanupPrimitives';

export type CanonicalRouteKind =
  | 'row_to_dms'
  | 'dms_to_final_disposal'
  | 'row_to_final_disposal'
  | 'site_to_site'
  | 'other'
  | 'unresolved';

export type PricingDimensionParseState =
  | 'explicit'
  | 'partial'
  | 'ambiguous'
  | 'unresolved';

export type ParsedDistanceBand = {
  readonly minMiles: number | null;
  readonly maxMiles: number | null;
  readonly openEnded: boolean;
  readonly exactMiles: number | null;
  readonly rawExpression: string | null;
};

export type ParsedPricingDimensions = {
  readonly routeKind: CanonicalRouteKind;
  readonly routeRawSpan: string | null;
  readonly distanceBand: ParsedDistanceBand | null;
  readonly distanceRawSpan: string | null;
  /** Null because regex interpretation has no calibrated probability. */
  readonly confidence: number | null;
  readonly parseState: PricingDimensionParseState;
  readonly unresolvedReason: string | null;
};

type RouteMatch = {
  readonly kind: Exclude<CanonicalRouteKind, 'unresolved'>;
  readonly rawSpan: string;
};

type DistanceMatch = {
  readonly band: ParsedDistanceBand;
  readonly ambiguous: boolean;
};

const ROUTE_SEPARATOR = String.raw`(?:-*to-*|t[06]|10|[-\u2013\u2014]|(?:-+>)|\u2192)`;

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function rawMatches(value: string, expression: RegExp): readonly string[] {
  return [...value.matchAll(expression)]
    .map((match) => match[0])
    .filter((match) => match.trim().length > 0);
}

function routeMatches(value: string): readonly RouteMatch[] {
  const matches: RouteMatch[] = [];
  const add = (kind: RouteMatch['kind'], expression: RegExp) => {
    for (const rawSpan of rawMatches(value, expression)) matches.push({ kind, rawSpan });
  };

  add('row_to_final_disposal', new RegExp(String.raw`\bROW\)?\s*${ROUTE_SEPARATOR}\s*(?:final\s+disposal|FDS)\b`, 'gi'));
  add('dms_to_final_disposal', new RegExp(String.raw`\bDMS\s*${ROUTE_SEPARATOR}\s*(?:final\s+disposal|FDS)\b`, 'gi'));
  add('row_to_dms', new RegExp(String.raw`\bROW\)?\s*${ROUTE_SEPARATOR}\s*DMS\b`, 'gi'));

  if (matches.length === 0) {
    add(
      'site_to_site',
      new RegExp(
        String.raw`\b(?:site|facility|yard|DMS)\s+[A-Z0-9][A-Z0-9._-]*\s*${ROUTE_SEPARATOR}\s*(?:site|facility|yard|DMS)\s+[A-Z0-9][A-Z0-9._-]*\b`,
        'gi',
      ),
    );
  }
  if (matches.length === 0) {
    add(
      'other',
      new RegExp(
        String.raw`\b(?:plant|landfill|facility|site|yard)\b[^|\r\n]{0,40}?\s${ROUTE_SEPARATOR}\s[^|\r\n]{0,40}?\b(?:plant|landfill|facility|site|yard)\b`,
        'gi',
      ),
    );
  }

  return matches;
}

function distanceBand(input: {
  readonly minMiles: number | null;
  readonly maxMiles: number | null;
  readonly openEnded?: boolean;
  readonly exactMiles?: number | null;
  readonly rawExpression: string;
}): ParsedDistanceBand {
  return {
    minMiles: input.minMiles,
    maxMiles: input.maxMiles,
    openEnded: input.openEnded ?? false,
    exactMiles: input.exactMiles ?? null,
    rawExpression: input.rawExpression,
  };
}

function distanceMatches(value: string): readonly DistanceMatch[] {
  const matches: DistanceMatch[] = [];

  for (const match of value.matchAll(/\b(\d{1,3})\s*(?:-|\u2013|\u2014|to)\s*(\d{1,3})\s*mil(?:es|as?)\b/gi)) {
    const rawExpression = match[0];
    let minMiles = Number(match[1]);
    let maxMiles = Number(match[2]);
    let ambiguous = false;
    if (minMiles === 0 && maxMiles === 16) {
      maxMiles = 15;
      ambiguous = true;
    } else if (minMiles === 81 && maxMiles === 60) {
      minMiles = 31;
      ambiguous = true;
    }
    if (minMiles > maxMiles && !ambiguous) ambiguous = true;
    matches.push({
      band: distanceBand({ minMiles: Math.min(minMiles, maxMiles), maxMiles: Math.max(minMiles, maxMiles), rawExpression }),
      ambiguous,
    });
  }
  for (const match of value.matchAll(/\b(0|16|31|60)\s*(?:-|\u2013|\u2014|to)\s*(15|16|30|60)\b(?!\s*mil(?:es|as?))/gi)) {
    const rawExpression = match[0];
    const minMiles = Number(match[1]);
    let maxMiles = Number(match[2]);
    let ambiguous = false;
    if (minMiles === 0 && maxMiles === 16) {
      maxMiles = 15;
      ambiguous = true;
    }
    matches.push({ band: distanceBand({ minMiles, maxMiles, rawExpression }), ambiguous });
  }
  for (const match of value.matchAll(/\b(\d{1,3})\s*(?:\+|plus)(?:\s*mil(?:es|as?))?(?!\w)/gi)) {
    const minMiles = Number(match[1]);
    matches.push({
      band: distanceBand({ minMiles, maxMiles: null, openEnded: true, rawExpression: match[0] }),
      ambiguous: false,
    });
  }
  for (const match of value.matchAll(/\b(?:over|more\s+than)\s+(\d{1,3})\s*mil(?:es|as?)\b/gi)) {
    const minMiles = Number(match[1]);
    matches.push({
      band: distanceBand({ minMiles, maxMiles: null, openEnded: true, rawExpression: match[0] }),
      ambiguous: false,
    });
  }
  for (const match of value.matchAll(/\bup\s+to\s+(\d{1,3})\s*mil(?:es|as?)\b/gi)) {
    const maxMiles = Number(match[1]);
    matches.push({
      band: distanceBand({ minMiles: 0, maxMiles, rawExpression: match[0] }),
      ambiguous: false,
    });
  }
  for (const match of value.matchAll(/\bany\s+distance\b/gi)) {
    matches.push({
      band: distanceBand({ minMiles: 0, maxMiles: null, openEnded: true, rawExpression: match[0] }),
      ambiguous: false,
    });
  }
  if (matches.length === 0) {
    for (const match of value.matchAll(/\b(?:exactly\s+)?(\d{1,3})\s*mil(?:es|as?)\b/gi)) {
      const exactMiles = Number(match[1]);
      matches.push({
        band: distanceBand({ minMiles: exactMiles, maxMiles: exactMiles, exactMiles, rawExpression: match[0] }),
        ambiguous: false,
      });
    }
  }
  return matches;
}

function distanceKey(band: ParsedDistanceBand): string {
  if (band.rawExpression?.match(/\bany\s+distance\b/i)) return 'miles:any';
  if (band.exactMiles != null) return `miles:exact:${band.exactMiles}`;
  return `miles:${band.minMiles ?? '*'}:${band.openEnded ? '*' : (band.maxMiles ?? '*')}`;
}

export function parseAuthoredPricingDimensions(value: string | null | undefined): ParsedPricingDimensions {
  const source = value?.trim() ?? '';
  if (!source) {
    return {
      routeKind: 'unresolved', routeRawSpan: null, distanceBand: null,
      distanceRawSpan: null, confidence: null, parseState: 'unresolved',
      unresolvedReason: 'source_text_unavailable',
    };
  }

  const routes = uniqueBy(routeMatches(source), (match) => match.kind);
  const distances = uniqueBy(distanceMatches(source), (match) => distanceKey(match.band));
  const routeAmbiguous = routes.length > 1;
  const distanceAmbiguous = distances.length > 1;
  const selectedRoute = routeAmbiguous ? null : routes[0] ?? null;
  const selectedDistance = distanceAmbiguous ? null : distances[0] ?? null;
  const anyAmbiguity = routeAmbiguous || distanceAmbiguous || selectedDistance?.ambiguous === true;
  const hasRoute = selectedRoute != null;
  const hasDistance = selectedDistance != null;

  return {
    routeKind: selectedRoute?.kind ?? 'unresolved',
    routeRawSpan: selectedRoute?.rawSpan ?? null,
    distanceBand: selectedDistance?.band ?? null,
    distanceRawSpan: selectedDistance?.band.rawExpression ?? null,
    confidence: null,
    parseState: anyAmbiguity
      ? 'ambiguous'
      : hasRoute && hasDistance
        ? 'explicit'
        : hasRoute || hasDistance
          ? 'partial'
          : 'unresolved',
    unresolvedReason: routeAmbiguous
      ? 'multiple_explicit_routes'
      : distanceAmbiguous
        ? 'multiple_explicit_distance_bands'
        : selectedDistance?.ambiguous
          ? 'ocr_ambiguous_distance'
          : hasRoute || hasDistance
            ? null
            : 'no_explicit_pricing_dimensions',
  };
}

export function pricingRouteMatchingKey(value: CanonicalRouteKind | ParsedPricingDimensions): string | null {
  const kind = typeof value === 'string' ? value : value.routeKind;
  return kind === 'unresolved' ? null : kind;
}

export function pricingDistanceMatchingKey(band: ParsedDistanceBand | null): string | null {
  return band ? distanceKey(band) : null;
}

export function pricingRouteDisplayLabel(
  kind: CanonicalRouteKind,
  rawSpan: string | null = null,
): string | null {
  switch (kind) {
    case 'row_to_dms': return 'ROW to DMS';
    case 'dms_to_final_disposal': return /\bFDS\b/i.test(rawSpan ?? '') ? 'DMS to FDS' : 'DMS to Final Disposal';
    case 'row_to_final_disposal': return 'ROW to Final Disposal';
    case 'site_to_site':
    case 'other': return rawSpan ? collapseWhitespace(rawSpan) : null;
    default: return null;
  }
}

export function pricingDistanceDisplayLabel(band: ParsedDistanceBand | null): string | null {
  if (!band) return null;
  if (band.rawExpression?.match(/\bany\s+distance\b/i)) return 'Any Distance';
  if (band.exactMiles != null) return `${band.exactMiles} Miles`;
  if (band.openEnded && band.minMiles != null) return `${band.minMiles}+ Miles`;
  if (band.minMiles != null && band.maxMiles != null) return `${band.minMiles} to ${band.maxMiles} Miles`;
  return null;
}

/** Compatibility translation for the assembler's legacy display vocabulary. */
export function toLegacyContractPricingDimensions(parsed: ParsedPricingDimensions): {
  readonly route: string | null;
  readonly distanceBand: string | null;
  readonly ocrAmbiguous: boolean;
} {
  return {
    route: pricingRouteDisplayLabel(parsed.routeKind, parsed.routeRawSpan),
    distanceBand: pricingDistanceDisplayLabel(parsed.distanceBand),
    ocrAmbiguous: parsed.parseState === 'ambiguous',
  };
}

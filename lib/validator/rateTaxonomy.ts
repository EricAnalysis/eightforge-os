import { normalizeRateDescription } from '@/lib/validator/billingKeys';

export const MIN_CONFIDENT_CANONICAL_CATEGORY = 0.68;

export type CanonicalRateCategoryBasis =
  | 'existing'
  | 'source_category'
  | 'descriptor'
  | 'combined'
  | 'unresolved';

export type CanonicalRateCategoryResolution = {
  source_category: string | null;
  canonical_category: string | null;
  category_confidence: number | null;
  basis: CanonicalRateCategoryBasis;
  matched_alias: string | null;
};

type CanonicalRateCategoryRule = {
  canonical_category: string;
  source_category_aliases: readonly string[];
  descriptor_aliases: readonly string[];
};

const CATEGORY_RULES: readonly CanonicalRateCategoryRule[] = [
  {
    canonical_category: 'tree_operations',
    source_category_aliases: [
      'tree',
      'tree operations',
      'hazardous tree',
      'hazard trees',
    ],
    descriptor_aliases: [
      'tree operations',
      'hazardous tree',
      'hazard tree',
      'tree removal',
      'hanging limb',
      'hanging limbs',
      'hazardous hanging limb',
      'hanger',
      'hangers',
      'leaner',
      'leaners',
      'stump',
      'stumps',
      'limb removal',
    ],
  },
  {
    canonical_category: 'construction_demolition',
    source_category_aliases: [
      'c&d',
      'c d',
      'c and d',
      'construction demolition',
      'construction and demolition',
      'mixed c&d',
      'mixed c d',
    ],
    descriptor_aliases: [
      'c&d',
      'c d',
      'c and d',
      'construction demolition',
      'construction and demolition',
      'mixed c&d',
      'mixed c d',
      'mixed construction demolition',
      'mixed construction and demolition',
    ],
  },
  {
    canonical_category: 'vegetative_removal',
    source_category_aliases: [
      'vegetative',
      'vegetation',
      'mulch',
      'vegetative debris',
    ],
    descriptor_aliases: [
      'vegetative',
      'vegetation',
      'vegetative debris',
      'mulch',
      'grinding chipping vegetative',
      'grinding/chipping vegetative',
      'grinding chipping vegetation',
      'pickup and haul vegetative',
      'pick up haul vegetative',
      'haul vegetative',
      'vegetative haul',
      'chipping vegetative',
    ],
  },
  {
    canonical_category: 'monitoring',
    source_category_aliases: [
      'monitoring',
      'debris monitoring',
    ],
    descriptor_aliases: [
      'monitoring',
      'debris monitoring',
    ],
  },
] as const;

const STRONG_MANAGEMENT_REDUCTION_DESCRIPTORS = [
  'debris mgmt site management',
  'debris management site management',
  'reduction of vegetative debris',
  'grinding and chipping vegetative debris',
  'grinding chipping vegetative debris',
] as const;

const STRONG_FINAL_DISPOSAL_DESCRIPTORS = [
  'loading hauling to final disposal',
  'dms to final disposal',
  'dms to fds',
] as const;

function containsNormalizedPhrase(text: string, phrase: string): boolean {
  return text === phrase
    || text.startsWith(`${phrase} `)
    || text.endsWith(` ${phrase}`)
    || text.includes(` ${phrase} `);
}

function strongActionDescriptorCategory(descriptors: readonly string[]): {
  canonicalCategory: 'management_reduction' | 'final_disposal';
  matchedPhrase: string;
} | null {
  for (const descriptor of descriptors) {
    for (const phrase of STRONG_MANAGEMENT_REDUCTION_DESCRIPTORS) {
      if (containsNormalizedPhrase(descriptor, phrase)) {
        return { canonicalCategory: 'management_reduction', matchedPhrase: phrase };
      }
    }
    for (const phrase of STRONG_FINAL_DISPOSAL_DESCRIPTORS) {
      if (containsNormalizedPhrase(descriptor, phrase)) {
        return { canonicalCategory: 'final_disposal', matchedPhrase: phrase };
      }
    }
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | null {
  return normalizeRateDescription(value);
}

function normalizeCanonicalCategory(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/\s+/g, '_') : null;
}

function scoreAliasMatch(
  text: string | null,
  aliases: readonly string[],
  weights: {
    exact: number;
    contains: number;
    tokens: number;
  },
): {
  score: number;
  alias: string | null;
} {
  if (!text) {
    return { score: 0, alias: null };
  }

  let bestScore = 0;
  let bestAlias: string | null = null;

  for (const alias of aliases) {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) continue;

    let score = 0;
    if (text === normalizedAlias) {
      score = weights.exact;
    } else if (text.includes(normalizedAlias)) {
      score = weights.contains;
    } else {
      const aliasTokens = normalizedAlias.split(' ').filter((token) => token.length > 0);
      if (
        aliasTokens.length > 0
        && aliasTokens.every((token) => text.includes(token))
      ) {
        score = weights.tokens;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestAlias = alias;
    }
  }

  return { score: bestScore, alias: bestAlias };
}

export function resolveCanonicalRateCategory(params: {
  sourceCategory?: string | null;
  sourceDescriptors?: readonly (string | null | undefined)[];
  existingCanonicalCategory?: string | null;
  existingConfidence?: number | null;
}): CanonicalRateCategoryResolution {
  const source_category = params.sourceCategory?.trim() || null;
  const existingCanonicalCategory = normalizeCanonicalCategory(params.existingCanonicalCategory);
  const existingConfidence =
    typeof params.existingConfidence === 'number' && Number.isFinite(params.existingConfidence)
      ? Math.max(0, Math.min(1, Number(params.existingConfidence.toFixed(3))))
      : null;

  const normalizedSourceCategory = normalizeText(source_category);
  const normalizedDescriptors = (params.sourceDescriptors ?? [])
    .map((descriptor) => normalizeText(descriptor))
    .filter((descriptor): descriptor is string => descriptor != null);
  const strongActionCategory = strongActionDescriptorCategory(normalizedDescriptors);

  if (existingCanonicalCategory) {
    if (existingCanonicalCategory === 'vegetative_removal' && strongActionCategory) {
      return {
        source_category,
        canonical_category: strongActionCategory.canonicalCategory,
        category_confidence: 0.88,
        basis: 'descriptor',
        matched_alias: strongActionCategory.matchedPhrase,
      };
    }
    return {
      source_category,
      canonical_category: existingCanonicalCategory,
      category_confidence: existingConfidence ?? 0.95,
      basis: 'existing',
      matched_alias: null,
    };
  }

  if (strongActionCategory) {
    return {
      source_category,
      canonical_category: strongActionCategory.canonicalCategory,
      category_confidence: 0.88,
      basis: 'descriptor',
      matched_alias: strongActionCategory.matchedPhrase,
    };
  }

  if (normalizedSourceCategory === 'management reduction' || normalizedSourceCategory === 'management and reduction') {
    return {
      source_category,
      canonical_category: 'management_reduction',
      category_confidence: 0.96,
      basis: 'source_category',
      matched_alias: normalizedSourceCategory,
    };
  }

  if (normalizedSourceCategory === 'final disposal') {
    return {
      source_category,
      canonical_category: 'final_disposal',
      category_confidence: 0.96,
      basis: 'source_category',
      matched_alias: normalizedSourceCategory,
    };
  }

  let best: {
    canonical_category: string;
    score: number;
    basis: CanonicalRateCategoryBasis;
    matched_alias: string | null;
  } | null = null;

  for (const rule of CATEGORY_RULES) {
    const sourceCategoryMatch = scoreAliasMatch(
      normalizedSourceCategory,
      rule.source_category_aliases,
      { exact: 0.96, contains: 0.9, tokens: 0.82 },
    );
    const descriptorMatch = normalizedDescriptors.reduce(
      (current, descriptor) => {
        const next = scoreAliasMatch(
          descriptor,
          rule.descriptor_aliases,
          { exact: 0.88, contains: 0.82, tokens: 0.74 },
        );
        return next.score > current.score ? next : current;
      },
      { score: 0, alias: null as string | null },
    );

    let score = Math.max(sourceCategoryMatch.score, descriptorMatch.score);
    const basis: CanonicalRateCategoryBasis =
      sourceCategoryMatch.score > 0 && descriptorMatch.score > 0
        ? 'combined'
        : sourceCategoryMatch.score > 0
          ? 'source_category'
          : descriptorMatch.score > 0
            ? 'descriptor'
            : 'unresolved';

    if (basis === 'combined') {
      score = Math.max(
        score,
        Math.min(0.98, Math.max(sourceCategoryMatch.score, descriptorMatch.score) + 0.06),
      );
    }

    if (
      best == null
      || score > best.score
      || (score === best.score && rule.canonical_category.localeCompare(best.canonical_category, 'en-US') < 0)
    ) {
      best = {
        canonical_category: rule.canonical_category,
        score,
        basis,
        matched_alias: sourceCategoryMatch.alias ?? descriptorMatch.alias ?? null,
      };
    }
  }

  if (!best || best.score < 0.5) {
    return {
      source_category,
      canonical_category: null,
      category_confidence: null,
      basis: 'unresolved',
      matched_alias: null,
    };
  }

  return {
    source_category,
    canonical_category: best.canonical_category,
    category_confidence: Number(best.score.toFixed(3)),
    basis: best.basis,
    matched_alias: best.matched_alias,
  };
}

export function hasConfidentCanonicalRateCategory(
  resolution: Pick<CanonicalRateCategoryResolution, 'canonical_category' | 'category_confidence'>,
): boolean {
  return (
    typeof resolution.canonical_category === 'string'
    && resolution.canonical_category.trim().length > 0
    && typeof resolution.category_confidence === 'number'
    && resolution.category_confidence >= MIN_CONFIDENT_CANONICAL_CATEGORY
  );
}

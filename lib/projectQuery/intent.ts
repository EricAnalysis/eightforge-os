import type { ProjectQueryType } from '@/lib/projectQuery/types';

export type ParsedProjectQueryIntent = {
  type: ProjectQueryType;
  raw: string;
  normalized: string;
  value: string;
  routingLabel: string;
};

function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function stripPrefix(input: string): { forcedType: ProjectQueryType | null; rest: string } {
  const s = input.trim();
  const match = s.match(/^\/?(fact|derive|verify|list|search|signal|missing|table)\s+(.+)$/i);
  if (!match) return { forcedType: null, rest: s };
  const keyword = match[1]?.toLowerCase();
  const rest = match[2] ?? '';
  switch (keyword) {
    case 'fact':
      return { forcedType: 'FACT', rest };
    case 'derive':
      return { forcedType: 'DERIVE', rest };
    case 'verify':
      return { forcedType: 'VERIFY', rest };
    case 'list':
      return { forcedType: 'LIST', rest };
    case 'search':
      return { forcedType: 'SEARCH', rest };
    case 'signal':
      return { forcedType: 'SIGNAL', rest };
    case 'missing':
      return { forcedType: 'SEARCH', rest };
    case 'table':
      return { forcedType: 'LIST', rest };
    default:
      return { forcedType: null, rest: s };
  }
}

/** LIST: documents, rates, table, list, show me, which */
function isListIntent(normalized: string): boolean {
  if (normalized.includes('show me')) return true;
  return /\b(documents?|rates?|table|list|which)\b/.test(normalized);
}

/** SIGNAL: blocking, risk, issues, exposure, approval only */
function isSignalIntent(normalized: string): boolean {
  return /\b(blocking|risk|risks|issues?|exposure|approval)\b/.test(normalized);
}

function inferType(normalized: string): { type: ProjectQueryType; label: string } {
  if (
    /\b(vs|versus|compare|exceed|exceeds|mismatch|match|reconcile|difference|delta)\b/.test(
      normalized,
    )
    || normalized.startsWith('does ')
    || normalized.startsWith('is ')
    || normalized.startsWith('are ')
  ) {
    return { type: 'VERIFY', label: 'keyword:verify' };
  }

  if (isListIntent(normalized)) {
    return { type: 'LIST', label: 'keyword:list' };
  }

  if (isSignalIntent(normalized)) {
    return { type: 'SIGNAL', label: 'keyword:signal' };
  }

  if (
    /\b(search|referenced|reference|where is|where are|defined terms|exhibit)\b/.test(
      normalized,
    )
    || normalized.startsWith('where ')
  ) {
    return { type: 'SEARCH', label: 'keyword:search' };
  }

  if (/\b(remaining|capacity|exposure|used|percent)\b/.test(normalized)) {
    return { type: 'DERIVE', label: 'keyword:derive' };
  }

  return { type: 'FACT', label: 'default:fact' };
}

export function parseProjectQueryIntent(input: string): ParsedProjectQueryIntent | null {
  const raw = input.trim();
  if (!raw) return null;

  const { forcedType, rest } = stripPrefix(raw);
  const normalized = normalize(rest);
  if (!normalized) return null;

  if (forcedType) {
    return {
      type: forcedType,
      raw,
      normalized,
      value: rest.trim(),
      routingLabel: 'prefix',
    };
  }

  const inferred = inferType(normalized);
  return {
    type: inferred.type,
    raw,
    normalized,
    value: rest.trim(),
    routingLabel: inferred.label,
  };
}

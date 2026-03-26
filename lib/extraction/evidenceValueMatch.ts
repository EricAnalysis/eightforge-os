import type { EvidenceObject } from '@/lib/extraction/types';

function evidenceHaystack(evidence: EvidenceObject): string {
  return [
    evidence.location.label,
    evidence.text,
    evidence.value != null ? String(evidence.value) : '',
    typeof evidence.location.nearby_text === 'string' ? evidence.location.nearby_text : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

/** Strings / number formats to search for in evidence text when label/regex grounding failed. */
export function collectValueNeedles(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.length >= 2) out.push(t);
    if (t.length > 48) out.push(t.slice(0, 48));

    // If value is an ISO date (YYYY-MM-DD), also search for common document renderings.
    // This helps ground normalized dates back to PDF text like "August 28, 2025" or
    // "28th day of August, 2025".
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (iso) {
      const year = iso[1];
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const monthNames = [
        '', 'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const monthName = monthNames[month] ?? '';
      if (monthName && day >= 1 && day <= 31) {
        out.push(`${monthName} ${day}, ${year}`);
        const suffix =
          day % 10 === 1 && day % 100 !== 11 ? 'st'
          : day % 10 === 2 && day % 100 !== 12 ? 'nd'
          : day % 10 === 3 && day % 100 !== 13 ? 'rd'
          : 'th';
        out.push(`${day}${suffix} day of ${monthName}, ${year}`);
        out.push(`${day}${suffix} day of ${monthName} ${year}`);
      }
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(String(value));
    const rounded = Math.round(value);
    if (Math.abs(value - rounded) < 1e-9) {
      out.push(rounded.toLocaleString('en-US'));
    }
    try {
      out.push(
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 2,
        }).format(value),
      );
    } catch {
      // ignore
    }
  }
  return [...new Set(out)].filter((n) => n.length >= 2);
}

export function hasInspectableValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Match evidence objects whose text/value contains the normalized field value.
 * Used when primary label/regex grounding produced no evidence refs.
 */
export function findEvidenceByValueMatch(
  evidence: EvidenceObject[],
  value: unknown,
  options?: { max?: number },
): EvidenceObject[] {
  if (typeof value === 'boolean') return [];
  const needles = collectValueNeedles(value);
  if (needles.length === 0) return [];
  const max = options?.max ?? 8;
  const hits: EvidenceObject[] = [];
  const seen = new Set<string>();
  for (const ev of evidence) {
    const hay = evidenceHaystack(ev).toLowerCase();
    if (!hay) continue;
    for (const n of needles) {
      if (n.length >= 2 && hay.includes(n.toLowerCase())) {
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          hits.push(ev);
        }
        break;
      }
    }
    if (hits.length >= max) break;
  }
  return hits;
}

import type { EvidenceAnchor } from '@/lib/projectQuery/types';

const DECISION_HREF = /\/platform\/decisions\/([a-f0-9-]{8,})/i;

/**
 * Dedupe SIGNAL evidence by decision id, rule id, or stable source id (first wins).
 */
export function dedupeSignalEvidence(items: EvidenceAnchor[]): EvidenceAnchor[] {
  const seen = new Set<string>();
  const out: EvidenceAnchor[] = [];

  for (const ev of items) {
    const key = signalEvidenceDedupeKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function signalEvidenceDedupeKey(ev: EvidenceAnchor): string {
  if (ev.ruleId?.trim()) {
    return `rule:${ev.ruleId.trim()}`;
  }

  const sid = ev.sourceId?.trim();
  if (sid) {
    if (sid.startsWith('decision:')) return sid;
    if (sid.startsWith('rule:')) return sid;
  }

  const fromHref = ev.href.match(DECISION_HREF);
  if (fromHref?.[1]) {
    return `decision:${fromHref[1]}`;
  }

  if (sid) return `source:${sid}`;
  return `fallback:${ev.href}|${ev.label}`;
}

import type {
  OperationalFeedbackException,
  OperationalDocumentSignal,
} from '@/lib/server/operationalQueue';

export type AggregateCount = {
  label: string;
  value: number;
};

function groupCounts<T>(items: T[], getKey: (item: T) => string | null | undefined): AggregateCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item)?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, value]) => ({ label: label.replace(/_/g, ' '), value }))
    .sort((a, b) => b.value - a.value);
}

export function summarizeLowTrustModes(items: OperationalDocumentSignal[]): AggregateCount[] {
  return groupCounts(items, (item) => item.low_trust_mode);
}

export function summarizeFeedbackReasons(items: OperationalFeedbackException[]): AggregateCount[] {
  return groupCounts(items, (item) => item.review_error_type);
}

export function summarizeReviewDocumentTypes(items: OperationalDocumentSignal[]): AggregateCount[] {
  return groupCounts(items, (item) => item.document_type);
}

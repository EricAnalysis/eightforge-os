/**
 * Shared aging utilities for open work items.
 *
 * Classifies items by how long they have been open using created_at.
 * Buckets: 0–2 days, 3–7 days, 8–14 days, 15+ days.
 */

export type AgingBucketKey = '0_2' | '3_7' | '8_14' | '15_plus';

export interface AgingBucket {
  key: AgingBucketKey;
  label: string;
  shortLabel: string;
  minDays: number;
  maxDays: number;
}

export const AGING_BUCKETS: readonly AgingBucket[] = [
  { key: '0_2', label: '0–2 days', shortLabel: '0–2d', minDays: 0, maxDays: 2 },
  { key: '3_7', label: '3–7 days', shortLabel: '3–7d', minDays: 3, maxDays: 7 },
  { key: '8_14', label: '8–14 days', shortLabel: '8–14d', minDays: 8, maxDays: 14 },
  { key: '15_plus', label: '15+ days', shortLabel: '15+d', minDays: 15, maxDays: Infinity },
] as const;

const MS_PER_DAY = 86_400_000;

export function ageDays(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / MS_PER_DAY);
}

export function ageBucketKey(createdAt: string): AgingBucketKey {
  const days = ageDays(createdAt);
  for (const b of AGING_BUCKETS) {
    if (days >= b.minDays && days <= b.maxDays) return b.key;
  }
  return '15_plus';
}

export type AgingCounts = Record<AgingBucketKey, number>;

export function computeAgingCounts(dates: string[]): AgingCounts {
  const counts: AgingCounts = { '0_2': 0, '3_7': 0, '8_14': 0, '15_plus': 0 };
  for (const d of dates) {
    counts[ageBucketKey(d)]++;
  }
  return counts;
}

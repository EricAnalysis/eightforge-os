type QueueVisibilityRecord = {
  details?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
};

export function isSupersededGeneratedRecord(record: QueueVisibilityRecord): boolean {
  const supersededAt = record.details?.superseded_at ?? record.source_metadata?.superseded_at;
  return typeof supersededAt === 'string' && supersededAt.length > 0;
}

export function isCurrentQueueRecord(record: QueueVisibilityRecord): boolean {
  return !isSupersededGeneratedRecord(record);
}

export function filterCurrentQueueRecords<T extends QueueVisibilityRecord>(records: T[]): T[] {
  return records.filter(isCurrentQueueRecord);
}

export function isHistoryStatusFilter(
  filterStatus: string,
  openStatuses: readonly string[],
): boolean {
  return filterStatus.length > 0 && !openStatuses.includes(filterStatus);
}

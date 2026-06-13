import assert from 'node:assert/strict';
import test from 'node:test';

const {
  filterCurrentQueueRecords,
  isHistoryStatusFilter,
  isSupersededGeneratedRecord,
} = await import(
  new URL('../lib/currentWork.ts', import.meta.url).href,
);

test('current work filter excludes superseded generated rows', () => {
  const rows = [
    { id: 'current-open', details: null },
    { id: 'superseded', details: { superseded_at: '2026-03-18T10:00:00Z' } },
    { id: 'current-manual', details: { note: 'manual' } },
  ];

  assert.equal(isSupersededGeneratedRecord(rows[0]), false);
  assert.equal(isSupersededGeneratedRecord(rows[1]), true);

  const filtered = filterCurrentQueueRecords(rows);
  assert.deepEqual(
    filtered.map((row: { id: string }) => row.id),
    ['current-open', 'current-manual'],
  );
});

test('history status detection only flips on terminal status filters', () => {
  assert.equal(isHistoryStatusFilter('', ['open', 'in_review']), false);
  assert.equal(isHistoryStatusFilter('open', ['open', 'in_review']), false);
  assert.equal(isHistoryStatusFilter('resolved', ['open', 'in_review']), true);
});

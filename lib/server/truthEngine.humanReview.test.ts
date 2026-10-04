import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { humanReviewedFindingIds } from '@/lib/server/truthEngine';

describe('truth answers keep the human-reviewed marker (B3.1)', () => {
  it('marks only findings whose evidence rests on a human-reviewed value', () => {
    expect([...humanReviewedFindingIds([
      { finding_id: 'f-1', note: 'Human-reviewed contract rate (operator entered on page 8; ...).' },
      { finding_id: 'f-2', note: 'Matched governing contract schedule line.' },
      { finding_id: 'f-3', note: null },
      { finding_id: 'f-1', note: 'Matched governing contract schedule line.' },
    ])]).toEqual(['f-1']);
  });
});

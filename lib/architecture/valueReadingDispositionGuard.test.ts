import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
const original = read('supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql');
const migration = read('supabase/migrations/20261005004024_forgewing_value_reading_disposition_guard.sql');
const b3Start = 'CREATE OR REPLACE FUNCTION public.record_region_bound_human_fact_assertion(';

describe('B4.4 value-reading disposition database boundary', () => {
  it('changes only the existing B3 disposition guard and shared row locks', () => {
    const oldB3 = original.slice(original.indexOf(b3Start));
    const newB3 = migration.slice(migration.indexOf(b3Start));
    expect(newB3
      .replace('AND proposal_version = 3 FOR UPDATE;', 'AND proposal_version = 3;')
      .replace(/    -- Share the proposal row lock[\s\S]*?(?=    v_asserted_rate_row :=)/, ''))
      .toBe(oldB3);
    const oldReview = original.slice(original.indexOf('CREATE FUNCTION public.record_forgewing_value_reading_review('),
      original.indexOf('REVOKE ALL ON FUNCTION public.record_forgewing_value_reading_review(')).trim();
    const newReview = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.record_forgewing_value_reading_review('),
      migration.indexOf(b3Start)).trim();
    expect(newReview.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replace('AND proposal_version = 3 FOR UPDATE;', 'AND proposal_version = 3;')).toBe(oldReview);
  });

  it('serializes legacy review and owner inserts through the existing trigger too', () => {
    const trigger = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.reject_value_reading_approving_review('),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.record_forgewing_value_reading_review('));
    expect(trigger).toMatch(/WHERE proposal\.id = NEW\.proposal_row_id AND proposal\.proposal_version = 3 FOR UPDATE;/);
    expect(trigger).toMatch(/NEW\.disposition IN \('accepted', 'modified'\) AND v_proposal_version = 3/);
    expect(trigger).toMatch(/USING ERRCODE = '42501'/);
  });
  it('preserves exact assertion replay and does not rewrite historical truth or permissions', () => {
    const b3 = migration.slice(migration.indexOf(b3Start));
    expect(b3.indexOf('RETURN QUERY SELECT v_existing.id, false;'))
      .toBeLessThan(b3.indexOf("review.disposition IN ('rejected', 'deferred')"));
    expect(b3).toMatch(/review\.proposal_row_id = v_proposal\.id/);
    expect(b3).toMatch(/rejected or deferred' USING ERRCODE = '23514'/);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER|GRANT|REVOKE)\b|UPDATE public\.|DELETE FROM public\./);
  });
});

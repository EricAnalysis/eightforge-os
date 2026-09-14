import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadExtractionPageGuidance } from '@/lib/contracts/contractUploadGuidance';

function adminReturning(result: { data: unknown; error: unknown }): SupabaseClient {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => result,
  };
  return { from: () => query } as unknown as SupabaseClient;
}

const ROW = {
  id: 'guidance-1', organization_id: 'org-1', project_id: null, document_id: 'doc-1',
  rate_schedule_included: 'yes', rate_schedule_location_type: 'exhibit', operator_note: null,
  created_by: null, created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
};

describe('extraction page guidance', () => {
  it('expands persisted ranges into ascending unique pages as inspection priority', async () => {
    const guidance = await loadExtractionPageGuidance(adminReturning({
      data: { ...ROW, rate_schedule_page_ranges: [{ start: 107, end: 108 }, { start: 106, end: 107 }] },
      error: null,
    }), 'doc-1');
    expect(guidance).toEqual({
      rate_schedule_guidance_state: 'loaded',
      rate_schedule_page_hints: [106, 107, 108],
      rate_schedule_page_ranges: [{ start: 107, end: 108 }, { start: 106, end: 107 }],
      rate_schedule_included: 'yes',
    });
  });

  it('records malformed persisted ranges without widening or narrowing inspection', async () => {
    const guidance = await loadExtractionPageGuidance(adminReturning({
      data: { ...ROW, rate_schedule_page_ranges: [{ start: 9, end: 3 }] },
      error: null,
    }), 'doc-1');
    expect(guidance.rate_schedule_guidance_state).toBe('malformed');
    expect(guidance.rate_schedule_page_hints).toEqual([]);
    expect(guidance.rate_schedule_page_ranges).toBeNull();
  });

  it('treats no row as absent guidance', async () => {
    const guidance = await loadExtractionPageGuidance(adminReturning({ data: null, error: null }), 'doc-1');
    expect(guidance.rate_schedule_guidance_state).toBe('absent');
    expect(guidance.rate_schedule_page_hints).toEqual([]);
  });

  it('surfaces an unreadable guidance row as unavailable instead of failing extraction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guidance = await loadExtractionPageGuidance(adminReturning({
      data: null, error: { code: '08006', message: 'connection failure' },
    }), 'doc-1');
    expect(guidance.rate_schedule_guidance_state).toBe('unavailable');
    expect(guidance.rate_schedule_page_hints).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseClient', () => ({ supabase: {} }));

import { latestProjectValidationLabel } from '@/components/validator/ProjectValidationRunStatus';

describe('latest project validation presentation', () => {
  it('distinguishes pending, completed, and failed runs without claiming correction convergence', () => {
    expect(latestProjectValidationLabel('pending')).toBe('Pending');
    expect(latestProjectValidationLabel('running')).toBe('Running');
    expect(latestProjectValidationLabel('complete')).toBe('Completed');
    expect(latestProjectValidationLabel('failed')).toBe('Failed');
    expect(latestProjectValidationLabel(null)).toBe('No verified run status');
  });
});

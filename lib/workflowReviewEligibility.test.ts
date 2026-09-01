import { describe, expect, it } from 'vitest';

import { PROJECT_ADMIN_ROLES } from '@/lib/projectAdmin';
import {
  canReviewWorkflowAssessment,
  resolveWorkflowReviewEligibility,
} from '@/lib/workflowReviewEligibility';

describe('workflow review eligibility', () => {
  it('reuses the existing project admin role vocabulary', () => {
    // If a parallel reviewer-role system is ever introduced, this fails and
    // forces the decision to be explicit rather than accidental.
    for (const role of PROJECT_ADMIN_ROLES) {
      expect(canReviewWorkflowAssessment(role)).toBe(true);
    }
  });

  it.each([['owner'], ['admin'], ['OWNER'], ['  Admin  ']])(
    'accepts %j regardless of casing or padding', (role) => {
      expect(canReviewWorkflowAssessment(role)).toBe(true);
      expect(resolveWorkflowReviewEligibility(role).eligible).toBe(true);
    },
  );

  it.each([
    ['viewer'], ['member'], ['analyst'], ['operator'], ['reviewer'],
    ['service_role'], ['anon'], ['authenticated'], ['owner_'], ['adminx'],
  ])('rejects %j', (role) => {
    expect(canReviewWorkflowAssessment(role)).toBe(false);
    expect(resolveWorkflowReviewEligibility(role)).toEqual({
      eligible: false, reason: 'role_not_permitted',
    });
  });

  it.each([[null], [undefined], [''], ['   ']])(
    'treats %j as no role on the profile', (role) => {
      expect(canReviewWorkflowAssessment(role as string | null)).toBe(false);
      expect(resolveWorkflowReviewEligibility(role as string | null)).toEqual({
        eligible: false, reason: 'no_role_on_profile',
      });
    },
  );

  it('returns the normalized role so callers record what was matched', () => {
    const result = resolveWorkflowReviewEligibility('  ADMIN ');
    expect(result).toEqual({ eligible: true, role: 'admin' });
  });

  it.each([[123], [{}], [[]], [true]])('rejects non-string role %j', (role) => {
    expect(canReviewWorkflowAssessment(role as never)).toBe(false);
  });
});

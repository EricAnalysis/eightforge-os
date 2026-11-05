import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('FDE approval policy boundary', () => {
  it('keeps the Workflow Assessment allowlist separate from FDE decisions', () => {
    const fde = source('lib/server/fdePlanApproval.ts');
    const assessment = source('app/api/internal/workflow-assessments/[assessmentId]/review/route.ts');
    expect(fde).not.toContain('resolveWorkflowPlatformReviewAccess');
    expect(fde).not.toContain('reviewer_not_eligible');
    expect(assessment).toContain('resolveWorkflowPlatformReviewAccess');
  });

  it('shows FDE decision and waiver controls to anyone who can read the organization-scoped plan', () => {
    const page = source('app/platform/workflows/fde-plans/[assessmentId]/page.tsx');
    expect(page).not.toContain('reviewerEligible');
    expect(page).toContain('<FdeEvidenceWaiverControl');
    expect(page).toContain('Record FDE plan decision');
    expect(page).toContain('Approved — Acknowledged Evidence Waiver');
    expect(page).not.toContain('Customer-Acknowledged Evidence Waiver');
  });
});

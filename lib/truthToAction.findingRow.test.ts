import { describe, expect, it } from 'vitest';

import {
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
} from '@/lib/truthToAction';

// The shape the truth engine selects from project_validation_findings.
const persistedFinding = {
  id: 'finding-1',
  rule_id: 'CONTRACT_CEILING_UNCONFIRMED',
  severity: 'critical' as const,
  status: 'open' as const,
  subject_type: 'contract',
  subject_id: 'project-1',
  field: null,
  expected: null,
  actual: null,
  blocked_reason: null,
  decision_eligible: false,
  action_eligible: true,
  linked_decision_id: null,
  linked_action_id: null,
};

describe('finding label helpers on a persisted finding row', () => {
  it('derive label, gate impact and next action without throwing', () => {
    expect(findingApprovalLabel(persistedFinding)).toBe('Requires Verification');
    expect(typeof findingGateImpact(persistedFinding)).toBe('string');
    expect(findingGateImpact(persistedFinding).length).toBeGreaterThan(0);
    expect(typeof findingNextAction(persistedFinding)).toBe('string');
    expect(findingNextAction(persistedFinding).length).toBeGreaterThan(0);
  });

  it('handle a warning row with a field but no expected/actual values', () => {
    const warning = {
      ...persistedFinding,
      severity: 'warning' as const,
      field: 'contract_ceiling',
      blocked_reason: 'Contract ceiling not established.',
    };
    expect(() => findingApprovalLabel(warning)).not.toThrow();
    expect(() => findingGateImpact(warning)).not.toThrow();
    expect(() => findingNextAction(warning)).not.toThrow();
  });
});

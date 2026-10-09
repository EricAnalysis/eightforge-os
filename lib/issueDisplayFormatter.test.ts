import { describe, expect, it } from 'vitest';
import { getIssueDisplayLabel } from './issueDisplayFormatter';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';

describe('deterministic source-rule explanations', () => {
  it('explains emitted source findings by exact rule ID without changing their authority', () => {
    const input = {
      project: { id: 'project' }, validationPhase: 'billing_review', ruleStateByRuleId: new Map(),
      truthCategoryDocumentIds: { contract_identity: ['contract'], pricing: [] },
      familyDocumentIds: { rate_sheet: [], invoice: [] }, governingDocumentIds: { invoice: [] },
      factLookups: { contractCeilingType: 'rate_based', hasRateScheduleFacts: false },
      mobileTickets: [], loadTickets: [], invoices: [], invoiceLines: [], transactionData: null,
    } as unknown as Parameters<typeof runRequiredSourcesRules>[0];
    const findings = runRequiredSourcesRules(input);
    expect(findings).toHaveLength(3);
    const before = JSON.stringify(findings);
    for (const finding of findings) {
      const display = getIssueDisplayLabel(finding.rule_id);
      expect(display.category).toBe('Source documents');
      expect(display.raw_key).toBe(finding.rule_id);
      expect(display.explanation).not.toContain('identified an issue');
      expect(display.recommended_action).toContain('upload or link');
    }
    expect(JSON.stringify(findings)).toBe(before);
  });

  it('retains full audit keys and a safe fallback for unknown rules', () => {
    expect(getIssueDisplayLabel('SOURCES_NO_CONTRACT:project')).toMatchObject({
      title: 'Project contract is missing', raw_key: 'SOURCES_NO_CONTRACT:project',
    });
    expect(getIssueDisplayLabel('NEW_RULE:subject', 'Source review')).toMatchObject({
      title: 'Source review', raw_key: 'NEW_RULE:subject', category: 'Validation',
      recommended_action: 'Review the issue details and record a decision.',
    });
  });
});

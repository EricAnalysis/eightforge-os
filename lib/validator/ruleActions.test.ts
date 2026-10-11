import { describe, expect, it } from 'vitest';

import { MANUAL_RATE_LINK_RULE_IDS } from '@/lib/server/manualRateLinkRules';
import { resolveValidatorRuleActions } from '@/lib/validator/ruleActions';
import { VALIDATOR_RULE_ACTION_KINDS, VALIDATOR_RULE_EXPLANATIONS } from '@/lib/validator/ruleExplanations';

const base = { projectId: 'p1', findingId: 'f1', subjectId: 'line-1', evidence: [] };

describe('Validator rule action vocabulary', () => {
  it('gives every rule at least one action, all from the fixed vocabulary, never mark_unresolved', () => {
    const vocabulary = new Set<string>(VALIDATOR_RULE_ACTION_KINDS);
    expect(vocabulary.has('mark_unresolved')).toBe(false);
    for (const [ruleId, entry] of Object.entries(VALIDATOR_RULE_EXPLANATIONS)) {
      expect(entry.actions.length, ruleId).toBeGreaterThan(0);
      expect(new Set(entry.actions).size, ruleId).toBe(entry.actions.length);
      for (const action of entry.actions) expect(vocabulary.has(action), `${ruleId}: ${action}`).toBe(true);
    }
  });

  it('offers the manual rate link on exactly the rules a manual link closes', () => {
    const offering = Object.entries(VALIDATOR_RULE_EXPLANATIONS)
      .filter(([, entry]) => entry.actions.includes('open_manual_rate_link'))
      .map(([ruleId]) => ruleId).sort();
    expect(offering).toEqual([...MANUAL_RATE_LINK_RULE_IDS].sort());
  });
});

describe('resolveValidatorRuleActions', () => {
  it('resolves source-document actions to the existing upload and project-documents routes', () => {
    expect(resolveValidatorRuleActions({ ...base, ruleId: 'SOURCES_NO_CONTRACT' })).toEqual([
      { kind: 'upload_document', href: '/platform/documents' },
      { kind: 'open_linked_documents', href: '/platform/projects/p1#project-documents' },
    ]);
  });

  it('opens evidence only when the finding cites a source document, at its page', () => {
    expect(resolveValidatorRuleActions({ ...base, ruleId: 'FINANCIAL_NTE_EXCEEDED' })).toEqual([]);
    expect(resolveValidatorRuleActions({
      ...base, ruleId: 'FINANCIAL_NTE_EXCEEDED',
      evidence: [{ documentId: null, page: 3 }, { documentId: 'doc-9', page: 4 }],
    })).toEqual([{ kind: 'open_evidence_inspector', href: '/platform/documents/doc-9?page=4' }]);
    expect(resolveValidatorRuleActions({
      ...base, ruleId: 'FINANCIAL_NTE_EXCEEDED', evidence: [{ documentId: 'doc-9', page: null }],
    })).toEqual([{ kind: 'open_evidence_inspector', href: '/platform/documents/doc-9' }]);
  });

  it('resolves the manual rate link to the existing endpoint for the finding and its invoice line', () => {
    expect(resolveValidatorRuleActions({ ...base, ruleId: 'FINANCIAL_RATE_CODE_MISSING' })[0]).toEqual({
      kind: 'open_manual_rate_link', method: 'POST', endpoint: '/api/projects/p1/invoice-line-rate-link',
      findingId: 'f1', invoiceLineSubjectId: 'line-1',
    });
  });

  it('never resolves enter_reviewed_value from page-cited Validator evidence', () => {
    const resolved = resolveValidatorRuleActions({
      ...base, ruleId: 'HUMAN_REVIEWED_VALUE_HELD_FOR_REREVIEW', evidence: [{ documentId: 'doc-1', page: 2 }],
    });
    expect(VALIDATOR_RULE_EXPLANATIONS.HUMAN_REVIEWED_VALUE_HELD_FOR_REREVIEW.actions).toContain('enter_reviewed_value');
    expect(resolved.map((action) => action.kind)).toEqual(['open_evidence_inspector']);
  });

  it('offers nothing for a rule the catalogue does not know', () => {
    expect(resolveValidatorRuleActions({ ...base, ruleId: 'NOT_A_RULE' })).toEqual([]);
  });
});

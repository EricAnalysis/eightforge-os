import { describe, expect, it } from 'vitest';

import { investigationUnavailableMessage, rankedActionLabels } from './caseInvestigationView';

describe('case investigation view', () => {
  it('names only the four navigation kinds, never a decision', () => {
    expect(rankedActionLabels(['link_invoice_line_rate', 'open_document'])).toEqual([
      'Link the invoice line to a contract rate', 'Open the cited document',
    ]);
    expect(rankedActionLabels(['resolve_execution_item', 'open_in_validator', 'enter_reviewed_value'])).toEqual([]);
  });

  it('explains every refusal in plain words', () => {
    expect(investigationUnavailableMessage({ status: 'gated', reason: 'activation_disabled' }))
      .toBe('Forgewing case investigation is not enabled yet: it is awaiting qualification.');
    expect(investigationUnavailableMessage({ status: 'budget_exhausted' })).toBe("Today's Forgewing investigation budget is used up.");
    expect(investigationUnavailableMessage({ error: 'Case not found' })).toBe('Case not found');
    expect(investigationUnavailableMessage({})).toBe('Forgewing case investigation is unavailable.');
  });
});

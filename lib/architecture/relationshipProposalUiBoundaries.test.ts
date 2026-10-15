import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * P3.2 UI. A relationship proposal is prefilled into the operator's existing
 * Link Relationship form and nothing more: the panel never links documents,
 * never records an acceptance, and the only `link_relationship` request stays
 * the operator's Save Link action.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PANEL = 'components/projects/RelationshipProposalsPanel.tsx';
const SECTION = 'components/projects/DocumentPrecedenceSection.tsx';

describe('relationship proposal UI boundaries (P3.2)', () => {
  it('the panel never links documents or records an acceptance', () => {
    const panel = code(PANEL);
    expect(panel).not.toContain('link_relationship');
    expect(panel).not.toContain('document-precedence');
    expect(panel).not.toMatch(/disposition:\s*'(accepted|already_linked)'/);
    expect(panel).not.toMatch(/['"]accepted['"]\s*[,}]/);
    // Only reject / defer reviews and the deterministic proposal check.
    expect(panel.match(/method: 'POST'/g)).toHaveLength(2);
  });

  it('the proposal id reaches link_relationship only through the exact-match helper', () => {
    const section = code(SECTION);
    expect(section).toContain('proposalIdForLink(');
    expect(section).toMatch(/\.\.\.\(linkedProposalId \? \{ forgewingProposalId: linkedProposalId \} : \{\}\)/);
    expect(section.match(/forgewingProposalId:\s+(?!undefined\b|linkedProposalId\b|proposal\.id\b|form\.forgewingProposalId\b)\S/g) ?? [])
      .toEqual([]);
  });
});

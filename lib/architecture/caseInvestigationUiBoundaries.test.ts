import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The Forgewing case investigation panel explains and ranks navigation only.
 * It calls nothing but the investigation route, offers no decision, and
 * appears only where Forgewing suggestions are already shown.
 */

const code = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PANEL = 'components/resolution/CaseInvestigationPanel.tsx';

describe('case investigation UI boundaries', () => {
  it('calls only the investigation route and offers no decision', () => {
    const panel = code(PANEL);
    const urls = panel.match(/\/api\/[^`'"\s]+/g) ?? [];
    expect(urls.every((url) => url.includes('/resolution-cases/investigation'))).toBe(true);
    expect(panel).not.toMatch(/approve|override|resolve_execution_item|execution-items|outcome|decisions|document-precedence|link_relationship/i);
    expect(panel.match(/method: 'POST'/g)).toHaveLength(1);
  });

  it('is shown only for Validator findings where Forgewing suggestions are included', () => {
    const workspace = code('components/resolution/ResolutionWorkspace.tsx');
    expect(workspace).toContain("{forgewingSuggestionsIncluded && entry.kind === 'validator_finding' ? (\n        <CaseInvestigationPanel")
      ;
    expect(workspace.match(/<CaseInvestigationPanel/g)).toHaveLength(1);
  });
});

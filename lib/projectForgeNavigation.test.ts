import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { PROJECT_FORGE_TABS, projectTabFromHash } from './projectForgeNavigation';

describe('projectForgeNavigation', () => {
  it('uses the target Forge order without a standalone Actions tab', () => {
    assert.deepEqual(
      PROJECT_FORGE_TABS.map((tab) => tab.label),
      ['Overview', 'Documents', 'Facts', 'Validator', 'Decisions', 'Audit'],
    );
  });

  it('routes legacy actions hashes to the Decisions surface', () => {
    assert.equal(projectTabFromHash('#project-actions'), 'decisions');
    assert.equal(projectTabFromHash('#project-decisions'), 'decisions');
  });
});

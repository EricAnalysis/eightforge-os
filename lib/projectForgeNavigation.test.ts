import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { PROJECT_FORGE_TABS, projectTabFromHash } from './projectForgeNavigation';

describe('projectForgeNavigation', () => {
  it('uses the target Forge order without a standalone Actions, Facts, or Decisions tab', () => {
    assert.deepEqual(
      PROJECT_FORGE_TABS.map((tab) => tab.label),
      ['Overview', 'Documents', 'Validator', 'Audit'],
    );
  });

  it('routes legacy actions and decisions hashes to the consolidated Validator surface', () => {
    assert.equal(projectTabFromHash('#project-actions'), 'validator');
    assert.equal(projectTabFromHash('#project-decisions'), 'validator');
    assert.equal(projectTabFromHash('#project-validator'), 'validator');
  });

  it('routes the legacy Facts hash to the Documents surface', () => {
    assert.equal(projectTabFromHash('#project-facts'), 'documents');
    assert.equal(projectTabFromHash('#project-documents'), 'documents');
  });
});

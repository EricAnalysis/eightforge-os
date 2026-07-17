import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { PROJECT_FORGE_TABS, projectTabFromHash } from './projectForgeNavigation';

const root = process.cwd();

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Four-surface Forge boundary', () => {
  it('keeps the consolidated project navigation and legacy hashes on their current surfaces', () => {
    assert.deepEqual(
      PROJECT_FORGE_TABS.map((tab) => tab.label),
      ['Overview', 'Documents', 'Validator', 'Audit'],
    );
    assert.equal(projectTabFromHash('#project-facts'), 'documents');
    assert.equal(projectTabFromHash('#project-decisions'), 'validator');
    assert.equal(projectTabFromHash('#project-actions'), 'validator');
  });

  it('keeps document impact and canonical facts in the Documents surface', () => {
    const source = readProjectFile('components/projects/ProjectOverview.tsx');

    assert.equal(source.includes('id="project-documents"'), true);
    assert.equal(source.includes('id="project-facts"'), true);
    assert.equal(source.includes('Decision Impact'), true);
    assert.equal(source.includes('documentImpact('), true);
  });

  it('keeps extracted facts and relationship data in ProjectDocumentsForge', () => {
    const source = readProjectFile('components/projects/ProjectDocumentsForge.tsx');

    for (const required of [
      'Key Extracted Facts',
      'Extracted Content',
      'Relationships',
      'DocumentPrecedenceSection',
      'DocumentIntelligenceStrip',
      'useForgeDocumentDetail',
      'pickKeyFacts',
      'authority_status',
      'effective_date',
    ]) {
      assert.equal(source.includes(required), true, `${required} should remain in ProjectDocumentsForge`);
    }
  });

  it('keeps findings, evidence, decisions, and execution in the Validator surface', () => {
    const overviewSource = readProjectFile('components/projects/ProjectOverview.tsx');
    const validatorSource = readProjectFile('components/projects/ValidatorTab.tsx');

    assert.equal(overviewSource.includes('id="project-validator"'), true);
    assert.equal(overviewSource.includes('id="project-decisions"'), true);
    assert.equal(overviewSource.includes('id="project-actions"'), true);
    assert.equal(overviewSource.includes('validatorTab(issueObjects)'), true);

    for (const required of [
      'ValidatorFindingsPanel',
      'ValidatorEvidenceDrawer',
      'ValidatorDecisionExecutionPanel',
      'Findings / Evidence &amp; Truth / Decision &amp; Execution',
    ]) {
      assert.equal(validatorSource.includes(required), true, `${required} should remain in Validator`);
    }
  });
});

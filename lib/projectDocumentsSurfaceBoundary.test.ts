import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

const root = process.cwd();

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Documents surface boundary', () => {
  it('does not render Decision Impact in the active Documents tab', () => {
    const source = readProjectFile('components/projects/ProjectOverview.tsx');

    assert.equal(source.includes('Decision Impact'), false);
    assert.equal(source.includes('documentImpact('), false);
  });

  it('does not render extracted facts or relationship data in ProjectDocumentsForge', () => {
    const source = readProjectFile('components/projects/ProjectDocumentsForge.tsx');

    for (const forbidden of [
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
      assert.equal(source.includes(forbidden), false, `${forbidden} should not be in ProjectDocumentsForge`);
    }
  });
});

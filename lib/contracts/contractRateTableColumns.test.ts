import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

describe('contract rate table columns', () => {
  it('does not render Route or Distance as operator-facing columns', () => {
    const detailExperience = readFileSync(
      'components/document-intelligence/DocumentDetailExperience.tsx',
      'utf8',
    );
    const factLedger = readFileSync(
      'components/document-intelligence/FactLedger.tsx',
      'utf8',
    );

    for (const source of [detailExperience, factLedger]) {
      assert.ok(source.includes('Description or Scope'));
      assert.ok(source.includes('Unit'));
      assert.ok(source.includes('Rate'));
      assert.ok(!source.includes('<span>Route</span>'));
      assert.ok(!source.includes('<span>Distance</span>'));
      assert.ok(!source.includes('>Route</th>'));
      assert.ok(!source.includes('>Distance</th>'));
    }
  });
});

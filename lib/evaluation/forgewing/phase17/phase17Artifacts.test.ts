import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  phase17ForbiddenKeyPaths,
  verifyPhase17CommittedRun,
} from '@/lib/evaluation/forgewing/phase17/phase17Artifacts';

const COMMITTED_ROOT = path.join(process.cwd(), 'scripts/evaluation/artifacts/phase17');

describe('Phase 17 artifact safety', () => {
  it('finds source-text and provider-payload keys at any depth', () => {
    expect(phase17ForbiddenKeyPaths({ units: [{ ok: 1, nested: { rawOutput: 'x' } }],
      evidenceBound: true, inputJson: '{}' })).toEqual(['$.units[0].nested.rawOutput', '$.inputJson']);
  });

  it('rejects a summary that is not bound to the exact freeze bytes', () => {
    expect(() => verifyPhase17CommittedRun('{}', '{}')).toThrow();
  });

  it('verifies every committed Phase 17 run: schema, no source text, freeze binding', () => {
    // CI integrity gate for normalized artifacts a human chose to commit.
    const runs = existsSync(COMMITTED_ROOT)
      ? readdirSync(COMMITTED_ROOT).filter((entry) => /^phase17-[a-f0-9]{24}$/.test(entry)) : [];
    for (const run of runs) {
      const directory = path.join(COMMITTED_ROOT, run);
      expect(readdirSync(directory).filter((entry) => entry !== 'local').sort(), run)
        .toEqual(['freeze.json', 'summary.json']);
      const { freeze, summary } = verifyPhase17CommittedRun(
        readFileSync(path.join(directory, 'freeze.json'), 'utf8'),
        readFileSync(path.join(directory, 'summary.json'), 'utf8'));
      expect(freeze.promotionAuthorized).toBe(false);
      expect(summary.qualification.promotionAuthorized).toBe(false);
    }
  });
});

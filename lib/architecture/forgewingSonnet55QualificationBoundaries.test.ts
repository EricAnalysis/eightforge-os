import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const walk = (directory: string): string[] => {
  const absolute = path.join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((name) => {
    const relative = `${directory}/${name}`;
    if (['node_modules', '.next', '.git'].includes(name)) return [];
    return statSync(path.join(ROOT, relative)).isDirectory() ? walk(relative) : [relative];
  });
};

describe('additive Sonnet 5.5 qualification boundaries', () => {
  it('keeps both 5.5 request clients outside production import paths', () => {
    const production = ['app', 'components', 'lib'].flatMap(walk)
      .filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => !file.startsWith('lib/evaluation/'));
    for (const client of ['valueReadingClientV2', 'valueReadingClientV3', 'valueReadingQualificationRenderer']) {
      expect(production.filter(file => read(file).includes(client) && file !== 'lib/server/valueReadingQualificationRenderer.ts')).toEqual([]);
    }
    expect(production.filter((file) => read(file).includes('phase17Sonnet55QualificationClient')))
      .toEqual([]);
    expect(production.filter((file) => read(file).includes('phase17Sonnet55SchemaCompatQualificationClient')))
      .toEqual([]);
    expect(production.filter((file) => read(file).includes('phase17Sonnet55NoUpfrontThinkingQualificationClient')))
      .toEqual([]);
  }, 60_000);

  it('registers manual commands with distinct artifact roots and no production model mutation', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['eval:b461-sonnet-5-5']).toContain('scripts/evaluation/b461/runQualificationV2.ts');
    expect(scripts['eval:phase17-sonnet-5-5-continuation'])
      .toContain('scripts/evaluation/phase17/runPhase17Sonnet55ContinuationEvaluation.ts');
    expect(read('scripts/evaluation/b461/runQualificationV2.ts'))
      .toContain("scripts/evaluation/artifacts/b461-sonnet-5-5/local");
    expect(read('scripts/evaluation/phase17/runPhase17Sonnet55ContinuationEvaluation.ts'))
      .toContain("scripts/evaluation/artifacts/phase17-sonnet-5-5");
    for (const file of [
      'scripts/evaluation/b461/runQualificationV2.ts',
      'scripts/evaluation/b461/runQualificationV3.ts',
      'scripts/evaluation/b461/runQualificationV4.ts',
      'scripts/evaluation/phase17/runPhase17Sonnet55ContinuationEvaluation.ts',
      'lib/evaluation/forgewing/phase17/phase17Sonnet55Run.ts',
    ]) {
      expect(read(file), file).not.toMatch(/process\.env\.FORGEWING_MODEL\s*=|FORGEWING_MODEL\s*=/);
    }
  });

  it('keeps paid qualification commands and credentials out of CI', () => {
    for (const workflow of readdirSync(path.join(ROOT, '.github/workflows'))) {
      const source = read(`.github/workflows/${workflow}`);
      expect(source, workflow).not.toMatch(/eval:b461-sonnet-5-5|eval:phase17-sonnet-5-5|runQualificationV2|runQualificationV3|runQualificationV4|ANTHROPIC_API_KEY/);
    }
  });
});

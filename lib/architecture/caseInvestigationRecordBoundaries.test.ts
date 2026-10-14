import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * P3c durable Case Investigation records are evidence / proposal history only:
 * no truth, Validator, precedence or contract path reads them; they are written
 * only through the record function; and the database pins their authority and
 * the action vocabulary they may rank.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return /\.(ts|tsx)$/.test(dir) ? [dir] : [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
  });
}

describe('case investigation record boundaries (P3c)', () => {
  it('no truth, Validator, precedence or contract path reads investigation records', () => {
    const truthRoots = ['lib/canonical', 'lib/validator', 'lib/contracts', 'lib/truthQuery.ts', 'lib/truthQuery',
      'lib/projectFacts.ts', 'lib/projectFacts', 'lib/effectiveFacts.ts', 'lib/effectiveFacts', 'lib/resolution',
      'lib/documentPrecedence.ts', 'lib/server/documentPrecedence.ts'];
    const readers = truthRoots.flatMap((root) => walk(root))
      .filter((file) => /forgewing_case_investigations|caseInvestigationRecords/.test(code(file)));
    expect(readers).toEqual([]);
  }, 120_000);

  it('only the investigation route records or reads them, through the record function', () => {
    const users = ['app', 'components', 'lib', 'scripts'].flatMap(walk)
      .filter((file) => /caseInvestigationRecords'|forgewing_case_investigations/.test(code(file)))
      .filter((file) => file !== 'lib/server/caseInvestigationRecords.ts');
    expect(users).toEqual(['app/api/projects/[id]/resolution-cases/investigation/route.ts']);
    const records = code('lib/server/caseInvestigationRecords.ts');
    expect(records).not.toMatch(/\.from\([^)]*\)[\s\S]{0,160}?\.(insert|update|upsert|delete)\(/);
  }, 120_000);

  it('the database pins authority, the case kind and the rankable vocabulary', () => {
    const migration = readFileSync('supabase/migrations/20261014200000_forgewing_case_investigations.sql', 'utf8');
    expect(migration).toContain("CHECK (authority = 'non_authoritative')");
    expect(migration).toContain("CHECK (case_kind = 'validator_finding')");
    expect(migration).toContain("ARRAY['open_document', 'link_invoice_line_rate', 'upload_document', 'open_linked_documents']");
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/resolve_execution_item|approve|override/i);
  });
});

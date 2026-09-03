import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Every ALTER / REVOKE / GRANT on a function must name a signature that some
// migration actually creates.
//
// A reversed argument list -- (uuid, integer, uuid, text, jsonb) where the
// function is (uuid, integer, uuid, jsonb, text) -- names an overload that does
// not exist. Postgres then raises "function does not exist", and under
// ON_ERROR_STOP=1 the whole replay aborts: every later migration silently never
// runs. The failure is fatal, invisible to type checking, and invisible to any
// test that does not execute SQL.
//
// This checks it statically, so the defect cannot reach a migration gate again.

const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');

/** Normalizes a SQL argument list for comparison. */
function normalizeArgs(raw: string): string {
  return raw
    .split(',')
    .map((arg) => arg.trim().replace(/"/g, '').toLowerCase())
    // Strip parameter names and DEFAULTs, keeping the type only.
    .map((arg) => arg.replace(/\bdefault\b[\s\S]*$/i, '').trim())
    .map((arg) => {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '';
      // "p_step_reviews jsonb" -> "jsonb"; a bare "jsonb" stays "jsonb".
      return parts.length > 1 ? parts.slice(1).join(' ') : parts[0]!;
    })
    .filter(Boolean)
    .join(',');
}

function readAll(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      file: name,
      sql: readFileSync(path.join(MIGRATIONS, name), 'utf8'),
    }));
}

/**
 * Reads an argument list from an opening parenthesis, balancing nested parens
 * so a type like numeric(10,2) does not truncate the list.
 */
function argsAt(sql: string, open: number): string | null {
  if (sql[open] !== '(') return null;
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  return null;
}

/** Every function signature created anywhere in the migration set. */
function createdSignatures(): Set<string> {
  const created = new Set<string>();
  for (const { sql } of readAll()) {
    const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?public"?\."?([a-z_0-9]+)"?\s*\(/gi;
    for (const match of sql.matchAll(pattern)) {
      const args = argsAt(sql, match.index! + match[0].length - 1);
      if (args === null) continue;
      created.add(`${match[1]!.toLowerCase()}(${normalizeArgs(args)})`);
    }
  }
  return created;
}

/** Every function signature referenced by ALTER / REVOKE / GRANT. */
function referencedSignatures(): Array<{ file: string; reference: string }> {
  const references: Array<{ file: string; reference: string }> = [];
  for (const { file, sql } of readAll()) {
    const pattern = /(?:ALTER\s+FUNCTION|REVOKE\s+[\s\S]{0,40}?ON\s+FUNCTION|GRANT\s+[\s\S]{0,40}?ON\s+FUNCTION)\s+"?public"?\."?([a-z_0-9]+)"?\s*\(/gi;
    for (const match of sql.matchAll(pattern)) {
      const open = match.index! + match[0].length - 1;
      const parsed = argsAt(sql, open);
      if (parsed === null) continue;
      references.push({
        file,
        reference: `${match[1]!.toLowerCase()}(${normalizeArgs(parsed)})`,
      });
    }
  }
  return references;
}

describe('migration function signature integrity', () => {
  it('finds the function definitions it is meant to check', () => {
    const created = createdSignatures();
    expect(created.size).toBeGreaterThan(0);
    // The function whose reversed signature made this guard necessary.
    expect([...created].some((signature) =>
      signature.startsWith('record_workflow_assessment_review('))).toBe(true);
  });

  it('every ALTER/REVOKE/GRANT names a signature some migration creates', () => {
    const created = createdSignatures();
    const orphans = referencedSignatures()
      .filter((entry) => !created.has(entry.reference))
      .map((entry) => `${entry.file}: ${entry.reference}`);
    expect(orphans).toEqual([]);
  });

  it('pins the review write function to its effective argument order', () => {
    const created = createdSignatures();
    // Argument order is load-bearing: Postgres resolves overloads positionally,
    // so a reversed list is a different (nonexistent) function.
    expect(created).toContain(
      'record_workflow_assessment_review(uuid,integer,uuid,jsonb,text)',
    );
    expect(created).not.toContain(
      'record_workflow_assessment_review(uuid,integer,uuid,text,jsonb)',
    );
  });
});

describe('canonical closure validator stays pure', () => {
  // It is on the Forgewing outbound allowlist solely because one closure
  // implementation must serve both new output and historical review. That is
  // only safe with an explicit closed dependency graph: closure -> canonical
  // schema -> Zod. No server, provider, environment, or authority dependencies.
  it('has only the exact canonical schema and Zod dependency graph', () => {
    for (const [file, dependencies] of [
      ['workflowAssessmentProposalClosure.ts', ['@/lib/workflowAssessmentSchema']],
      ['workflowAssessmentSchema.ts', ['zod']],
    ] as const) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
        .map((match) => match[1]);
      expect(imports).toEqual(dependencies);
      expect(source).not.toMatch(/require\s*\(/);
      expect(source).not.toMatch(/\bimport\s*\(/);
      expect(source).not.toMatch(/\bprocess\s*\./);
    }
  });

  it('names no authority-bearing module even in prose', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'lib', 'workflowAssessmentProposalClosure.ts'), 'utf8',
    );
    for (const authority of [
      'lib/canonical', 'lib/validator', 'projectFacts', 'supabaseAdmin', 'forgewing/runtime',
    ]) {
      expect(source).not.toContain(authority);
    }
  });
});

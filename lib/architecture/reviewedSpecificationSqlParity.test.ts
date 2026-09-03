import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { describe, expect, it } from 'vitest';

import {
  REVIEWED_SPECIFICATION_SCHEMAS,
  type ReviewedClassification,
} from '@/lib/workflowReviewedSpecification';

// Inspect the last committed definition in replay order, not an obsolete
// migration. This checks structural parity only, not semantic refinements,
// string bounds, enum membership, or array cardinality.
const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');
function effectiveFunction(name: string): { definition: string; body: string; migration: string } {
  let effective: { definition: string; body: string; migration: string } | undefined;
  for (const file of readdirSync(MIGRATIONS).filter((entry) => entry.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const pattern = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?public"?\\."?${name}"?\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[a-z_0-9]*\\$)([\\s\\S]*?)\\1\\s*;`, 'gi',
    );
    for (const match of sql.matchAll(pattern)) {
      effective = { definition: match[0], body: match[2]!, migration: sql };
    }
  }
  if (!effective) throw new Error(`Missing SQL function: ${name}`);
  return effective;
}

function jsonShape(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodEffects) return jsonShape(schema.innerType());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return jsonShape(schema._def.innerType);
  }
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodArray) return `${jsonShape(schema.element)}_array`;
  // A new shape must extend this explicit parity check instead of silently
  // inheriting UI rendering metadata or being skipped.
  throw new Error(`Unrepresented canonical JSON shape: ${schema._def.typeName}`);
}

function sqlArraysFor(classification: string): { required: string[]; allowed: string[] } {
  const sql = effectiveFunction('workflow_reviewed_specification_keys').body;
  // Two CASE blocks in order: required first, then allowed.
  const blocks = sql.split("WHEN '" + classification + "' THEN ARRAY[");
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  const parse = (fragment: string): string[] => {
    const body = fragment.slice(0, fragment.indexOf(']'));
    return body.split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter(Boolean).sort();
  };
  return { required: parse(blocks[1]!), allowed: parse(blocks[2]!) };
}

describe('reviewed specification SQL key parity', () => {
  const classifications = Object.keys(
    REVIEWED_SPECIFICATION_SCHEMAS,
  ) as ReviewedClassification[];

  it.each(classifications)('%s allowed keys match the TypeScript schema', (classification) => {
    const schemaKeys = Object.keys(
      REVIEWED_SPECIFICATION_SCHEMAS[classification].shape,
    ).sort();
    expect(sqlArraysFor(classification).allowed).toEqual(schemaKeys);
  });

  it.each(classifications)('%s required keys are the non-optional fields', (classification) => {
    const required = Object.entries(REVIEWED_SPECIFICATION_SCHEMAS[classification].shape)
      .filter(([, schema]) => !schema.isOptional())
      .map(([name]) => name)
      .sort();
    expect(sqlArraysFor(classification).required).toEqual(required);
  });

  it('forbids the same executable-shaped keys the contract omits', () => {
    const sql = effectiveFunction('workflow_specification_has_executable_key').body;
    for (const key of [
      'code', 'sql', 'query', 'expression', 'script',
      'command', 'runtime', 'deploy', 'executable',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
  });

  it('keeps the write function security properties intact', () => {
    const effective = effectiveFunction('record_workflow_assessment_review');
    const replacement = effective.definition;
    expect(replacement).toContain('SECURITY DEFINER');
    expect(replacement).toContain('SET search_path = public, pg_temp');
    expect(effective.migration).toMatch(/OWNER TO\s+"?postgres"?/);
    expect(effective.migration).toMatch(/TO\s+"?service_role"?/);
    // No table DML grants may appear in a function-only migration.
    expect(replacement).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL) ON TABLE/);
    // The assertion must run before anything is written.
    const body = effective.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    const assertAt = body.indexOf('PERFORM public.assert_workflow_reviewed_specification');
    const insertAt = body.indexOf('INSERT INTO public.workflow_assessment_reviews');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(insertAt);
    expect(body).not.toMatch(/CASE\s+WHEN\s+jsonb_typeof[^;]*accepted_specification/);
    expect(body).toMatch(/v_entry\s*->\s*'accepted_specification'/);
  });
});

describe('queue projection reads live assessment metrics', () => {
  const QUEUE = path.join(
    process.cwd(), 'supabase', 'migrations',
    '20260904000300_review_queue_terminology.sql',
  );

  // The queue previously read automationAssessment.deterministicCandidateSteps,
  // a property renamed when trusted qualification was removed. The SQL kept
  // compiling and silently returned 0 for every row, so a rename verified only
  // in TypeScript is not verified at all.
  it('reads only metric properties the task actually emits', () => {
    const sql = readFileSync(QUEUE, 'utf8');
    const referenced = [...sql.matchAll(/automationAssessment'->>'([A-Za-z]+)'/g)]
      .map((match) => match[1]!);
    expect(referenced.length).toBeGreaterThan(0);

    const task = readFileSync(
      path.join(process.cwd(), 'lib', 'forgewing', 'tasks', 'workflowAssessment.ts'),
      'utf8',
    );
    for (const property of referenced) {
      // Each referenced property must appear as a field of the emitted metrics.
      expect(task).toContain(`${property}:`);
    }
  });

  it('no longer names a trusted-qualification metric anywhere', () => {
    const sql = readFileSync(QUEUE, 'utf8');
    // Comments explain the removed name; the SQL body must not use it.
    const body = sql.replace(/^\s*--.*$/gm, ' ');
    expect(body).not.toContain('deterministicCandidateSteps');
    expect(body).not.toContain('qualified_deterministic_count');
  });
});

describe('reviewed specification structural validation', () => {
  it.each(Object.keys(REVIEWED_SPECIFICATION_SCHEMAS) as ReviewedClassification[])(
    '%s SQL shapes match canonical Zod fields', (classification) => {
      const sql = effectiveFunction('workflow_reviewed_specification_field_type').body;
      const declared = new Map(
        [...sql.matchAll(/WHEN '([A-Za-z]+)' THEN '([a-z_]+)'/g)]
          .map((match) => [match[1]!, match[2]!] as const),
      );
      for (const [name, schema] of Object.entries(REVIEWED_SPECIFICATION_SCHEMAS[classification].shape)) {
        expect(declared.get(name), `${classification}.${name}`).toBe(jsonShape(schema));
      }
    },
  );

  it('derives requiredness from Zod even when an array may be empty', () => {
    for (const classification of ['RULE', 'VERIFY'] as const) {
      for (const name of ['userDescribedExceptions', 'unresolvedAssumptions'] as const) {
        const schema = REVIEWED_SPECIFICATION_SCHEMAS[classification].shape[name];
        expect(schema.safeParse([]).success).toBe(true);
        expect(schema.safeParse(undefined).success).toBe(false);
        expect(sqlArraysFor(classification).required).toContain(name);
      }
    }
  });

  it('rejects executable-shaped keys recursively, not just at the top level', () => {
    const sql = effectiveFunction('workflow_specification_has_executable_key').body;
    // Nesting was the obvious way around a top-level check.
    expect(sql).toMatch(/workflow_specification_has_executable_key\("p_value" -> v_key\)/);
    expect(sql).toMatch(/workflow_specification_has_executable_key\(v_child\)/);
    expect(sql).toContain('jsonb_array_elements');
  });

  it('refuses a non-object specification instead of normalizing it to NULL', () => {
    const sql = effectiveFunction('assert_workflow_reviewed_specification').body;
    expect(sql).toMatch(/jsonb_typeof\("?p_specification"?\) <> 'object'/);
    // The old CASE that silently turned a scalar into NULL must be gone.
    expect(sql).not.toMatch(/THEN "p_specification" ELSE NULL END/);
  });

  it('stays structural and does not encode business meaning', () => {
    const sql = effectiveFunction('assert_workflow_reviewed_specification').body.toLowerCase();
    // No semantic vocabulary: SQL must not judge whether a rule reads sensibly.
    for (const semantic of ['deterministic_enough', 'reasonable', 'quality', 'similar']) {
      expect(sql).not.toContain(semantic);
    }
  });
});

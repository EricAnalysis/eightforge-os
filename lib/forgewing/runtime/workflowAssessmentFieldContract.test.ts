import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const create = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: () => ({ messages: { create } }) }));

import { callClaudeForWorkflowAssessment } from '@/lib/forgewing/runtime/client';
import {
  createObservedWorkflowAssessmentProvider,
  loadObservedWorkflowAssessmentPrompt,
} from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import {
  buildWorkflowAssessmentFieldContract,
  WORKFLOW_ASSESSMENT_FIELD_CONTRACT_BEGIN,
  WORKFLOW_ASSESSMENT_FIELD_CONTRACT_END,
} from '@/lib/forgewing/runtime/workflowAssessmentFieldContract';
import {
  WORKFLOW_ASSESSMENT_ENVELOPE_PROMPT_VERSION,
  WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA,
  WORKFLOW_DETERMINISM_CONDITIONS,
  WORKFLOW_INTAKE_SOURCE_QUESTIONS,
  WORKFLOW_RULE_CONDITION_TYPES,
  WORKFLOW_STEP_CLASSIFICATIONS,
  WorkflowAssessmentModelOutputSchema,
} from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

const PROMPT_PATH = 'lib/forgewing/prompts/workflowAssessment.md';
const schema = WorkflowAssessmentModelOutputSchema;

afterEach(() => create.mockReset());

function embeddedContract(prompt: string): string {
  const normalized = prompt.replace(/\r\n/g, '\n');
  expect(normalized.split(WORKFLOW_ASSESSMENT_FIELD_CONTRACT_BEGIN)).toHaveLength(2);
  expect(normalized.split(WORKFLOW_ASSESSMENT_FIELD_CONTRACT_END)).toHaveLength(2);
  return normalized.slice(
    normalized.indexOf(WORKFLOW_ASSESSMENT_FIELD_CONTRACT_BEGIN) + WORKFLOW_ASSESSMENT_FIELD_CONTRACT_BEGIN.length + 1,
    normalized.indexOf(WORKFLOW_ASSESSMENT_FIELD_CONTRACT_END) - 1,
  );
}

// ---- Reading the embedded contract back as text, independently of the generator ----
// These checks interpret only the prompt text and judge it with the unchanged strict
// validator, so a contract that misstates the schema fails even if it matches a snapshot.

type Field = { key: string; type: string };
function parseContract(text: string): Map<string, Field[]> {
  const records = new Map<string, Field[]>();
  for (const line of text.split('\n')) {
    const match = /^- `(assessment[^`]*)`: (.*)\.$/.exec(line);
    if (!match) continue;
    records.set(match[1]!, match[2]!.split('; ').map((part) => {
      const colon = part.indexOf(': ');
      return { key: part.slice(0, colon), type: part.slice(colon + 2) };
    }));
  }
  return records;
}

type Path = (string | number)[];
type Site =
  | { path: Path; kind: 'string'; min: number; max: number; target: number }
  | { path: Path; kind: 'array'; min: number; max: number; stringItems: boolean }
  | { path: Path; kind: 'boolean' }
  | { path: Path; kind: 'enum'; values: string[]; key: string }
  | { path: Path; kind: 'object'; nullable: boolean };

/** A sample at every stated string maximum, recording each place a stated constraint applies. */
function build(records: Map<string, Field[]>, type: string, contractPath: string, valuePath: Path,
  sites: Site[], key = ''): unknown {
  const nullable = type.endsWith(' or null');
  const base = nullable ? type.slice(0, -' or null'.length) : type;
  const string = /^string\((\d+)-(\d+), aim ≤(\d+)\)$/.exec(base);
  if (string) {
    sites.push({ path: valuePath, kind: 'string', min: Number(string[1]), max: Number(string[2]), target: Number(string[3]) });
    return 'x'.repeat(Number(string[2]));
  }
  if (base === 'boolean') { sites.push({ path: valuePath, kind: 'boolean' }); return true; }
  const enumMatch = /^enum\(([^)]+)\)$/.exec(base);
  if (enumMatch) {
    const values = enumMatch[1]!.split('|');
    sites.push({ path: valuePath, kind: 'enum', values, key });
    return values[0];
  }
  const array = /^array of (.+) \[(\d+)-(\d+) items\]$/.exec(base);
  if (array) {
    const [, itemType, min, max] = array;
    sites.push({ path: valuePath, kind: 'array', min: Number(min), max: Number(max),
      stringItems: itemType!.startsWith('string(') });
    return Array.from({ length: Math.max(Number(min), 1) }, (_, index) =>
      build(records, itemType!, `${contractPath}[]`, [...valuePath, index], index === 0 ? sites : [], key));
  }
  if (base === 'object') {
    const fields = records.get(contractPath);
    if (!fields) throw new Error(`no contract line for ${contractPath}`);
    sites.push({ path: valuePath, kind: 'object', nullable });
    return Object.fromEntries(fields.map((field) => [field.key,
      build(records, field.type, `${contractPath}.${field.key}`, [...valuePath, field.key], sites, field.key)]));
  }
  throw new Error(`unreadable contract type ${type}`);
}

function mutate(value: unknown, path: Path, change: (current: unknown) => unknown): unknown {
  if (path.length === 0) return change(structuredClone(value));
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let parent = copy;
  for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  parent[last] = change(parent[last]);
  return copy;
}

const accepts = (value: unknown) => schema.safeParse(value).success;

describe('Workflow Assessment prompt field contract (D3)', () => {
  const contract = embeddedContract(readFileSync(PROMPT_PATH, 'utf8'));
  const records = parseContract(contract);
  const sites: Site[] = [];
  const sample = build(records, 'object', 'assessment', [], sites);

  it('embeds exactly the contract generated from the strict schema', () => {
    // On failure, regenerate the marked block from buildWorkflowAssessmentFieldContract().
    expect(contract).toBe(buildWorkflowAssessmentFieldContract());
  });

  it('represents every schema field: a sample built only from the prompt text passes the strict schema', () => {
    // The schema is strict and every field is required, so a missing, misnamed or
    // invented field in the prompt makes this sample fail.
    const parsed = schema.safeParse(sample);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(sites.filter((site) => site.kind === 'object')).toHaveLength(records.size);
  });

  it('states every field type: each stated type is enforced and each wrong type is rejected', () => {
    const wrong: string[] = [];
    for (const site of sites) {
      const label = `${site.kind} ${site.path.join('.') || '(root)'}`;
      const cases: unknown[] = site.kind === 'string' ? [42, ['x']]
        : site.kind === 'boolean' ? ['true', 1]
          : site.kind === 'array' ? [{}, ...(site.stringItems ? ['x'] : [])]
            : site.kind === 'enum' ? [42] : ['x', []];
      for (const value of cases) if (accepts(mutate(sample, site.path, () => value))) wrong.push(`${label} accepts ${JSON.stringify(value)}`);
      if (site.kind === 'object' && site.path.length > 0) {
        if (accepts(mutate(sample, site.path, () => null)) !== site.nullable) wrong.push(`${label} null handling`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('states every length and count limit exactly, at both ends', () => {
    const wrong: string[] = [];
    for (const site of sites) {
      const label = `${site.kind} ${site.path.join('.')}`;
      if (site.kind === 'string') {
        if (accepts(mutate(sample, site.path, () => 'x'.repeat(site.max + 1)))) wrong.push(`${label} above max`);
        if (accepts(mutate(sample, site.path, () => 'x'.repeat(Math.max(site.min - 1, 0))))) wrong.push(`${label} below min`);
      }
      if (site.kind === 'array') {
        const resize = (length: number) => mutate(sample, site.path, (current) =>
          Array.from({ length }, () => structuredClone((current as unknown[])[0])));
        if (!accepts(resize(site.max))) wrong.push(`${label} rejects max`);
        if (accepts(resize(site.max + 1))) wrong.push(`${label} above max`);
        if (accepts(resize(site.min)) !== true) wrong.push(`${label} rejects min`);
        if (site.min > 0 && accepts(resize(site.min - 1))) wrong.push(`${label} below min`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lists every enum value the schema accepts and no other', () => {
    const wrong: string[] = [];
    const expected: Record<string, readonly string[]> = {
      classification: WORKFLOW_STEP_CLASSIFICATIONS, conditionType: WORKFLOW_RULE_CONDITION_TYPES,
      condition: WORKFLOW_DETERMINISM_CONDITIONS, sourceQuestion: WORKFLOW_INTAKE_SOURCE_QUESTIONS,
      sourceQuestions: WORKFLOW_INTAKE_SOURCE_QUESTIONS, severity: ['low', 'moderate', 'high'],
    };
    const enums = sites.filter((site): site is Extract<Site, { kind: 'enum' }> => site.kind === 'enum');
    expect(enums.length).toBeGreaterThanOrEqual(8);
    for (const site of enums) {
      const label = site.path.join('.');
      expect(expected[site.key], `unexpected enum field ${label}`).toBeDefined();
      if ([...site.values].sort().join() !== [...expected[site.key]!].sort().join()) wrong.push(`${label} lists ${site.values}`);
      for (const value of site.values) if (!accepts(mutate(sample, site.path, () => value))) wrong.push(`${label} rejects ${value}`);
      if (accepts(mutate(sample, site.path, () => 'NOT_A_LISTED_VALUE'))) wrong.push(`${label} accepts unlisted`);
    }
    expect(wrong).toEqual([]);
  });

  it('prohibits unknown fields everywhere, as the prompt states', () => {
    expect(contract).toContain('no other fields are allowed');
    const open = sites.filter((site) => site.kind === 'object')
      .filter((site) => accepts(mutate(sample, site.path, (current) => ({ ...(current as object), extraField: 'x' }))))
      .map((site) => site.path.join('.') || '(root)');
    expect(open).toEqual([]);
  });

  it('gives every string an 85% writing target derived from its own hard limit (D4), except the D-7 fields, which keep their pre-D-7 target', () => {
    const strings = sites.filter((site): site is Extract<Site, { kind: 'string' }> => site.kind === 'string');
    expect(strings.length).toBeGreaterThan(50);
    // D-7 (2026-11-07): the hard limit rose; the writing target stayed at 85% of the previous limit.
    const D7: Record<string, { max: number; target: number }> = {
      'deterministicRuleProposals.plainLanguageRule': { max: 1000, target: 510 },
      'verificationRuleProposals.plainLanguageRule': { max: 1000, target: 510 },
      'deterministicRuleProposals.expectedEvidence': { max: 300, target: 170 },
      'verificationRuleProposals.expectedEvidence': { max: 300, target: 170 },
      'extractionRequirements.describedFact': { max: 450, target: 255 },
      'humanDecisionPoints.description': { max: 600, target: 340 },
      'advisorySteps.description': { max: 1200, target: 680 },
    };
    const keyOf = (site: { path: Path }) => site.path.filter((p) => typeof p === 'string').join('.');
    const declared = strings.filter((site) => keyOf(site) in D7);
    expect(declared.map(keyOf).sort()).toEqual(Object.keys(D7).sort());
    for (const site of declared) expect({ max: site.max, target: site.target }, keyOf(site)).toEqual(D7[keyOf(site)]);
    const wrong = strings.filter((site) => (keyOf(site) in D7 ? false : site.target !== Math.floor(site.max * 0.85))
      || site.target >= site.max || site.target < site.min).map((site) => site.path.join('.'));
    expect(wrong).toEqual([]);
    const recordText = contract.split('\n').filter((line) => line.startsWith('- `assessment')).join('\n');
    expect((recordText.match(/string\(\d+-\d+\)/g) ?? [])).toEqual([]);
    // Writing at every target is valid: a target never asks for something the schema rejects.
    const atTargets = strings.reduce<unknown>((value, site) => mutate(value, site.path, () => 'x'.repeat(site.target)), sample);
    expect(accepts(atTargets)).toBe(true);
  });

  it('warns against the D3 run 1 overrun patterns (D4)', () => {
    expect(contract).toContain('never copy a longer step description or rationale into a detail field with a smaller limit');
    expect(contract).toContain('put one requirement or fact in each item');
    // The pattern it addresses still exists in the schema: human-decision descriptions are shorter than step descriptions.
    const type = (record: string, key: string) => records.get(record)!.find((field) => field.key === key)!.type;
    expect(type('assessment.workflowSteps[]', 'description')).toBe('string(1-600, aim ≤510)');
    expect(type('assessment.humanDecisionPoints[]', 'description')).toBe('string(1-600, aim ≤340)'); // D-7: limit 600, target kept
    expect(type('assessment.advisorySteps[]', 'description')).toBe('string(1-1200, aim ≤680)'); // D-6 then D-7
  });

  it('names the exact fields that failed in D2 run 2', () => {
    for (const record of ['deterministicRuleProposals', 'verificationRuleProposals']) {
      const fields = records.get(`assessment.${record}[]`)!;
      const type = (key: string) => fields.find((field) => field.key === key)?.type;
      expect(type('expectedEvidence')).toBe('array of string(1-300, aim ≤170) [1-12 items]'); // D-7
      expect(type('userDescribedExceptions')).toBe('array of string(1-300, aim ≤255) [0-12 items]');
      expect(type('plainLanguageRule')).toBe('string(1-1000, aim ≤510)'); // D-7
    }
    expect(contract).toContain('evidenceRequirements: array of string(1-350, aim ≤297) [0-12 items]');
    expect(contract).toContain('limitations: array of string(1-300, aim ≤255) [0-16 items]');
    expect(contract).toContain('never a single string, even for one item');
    expect(contract).toContain('Never omit a workflow step');
  });

  it('cannot describe a schema it cannot state truthfully', () => {
    expect(() => buildWorkflowAssessmentFieldContract(z.object({ a: z.string() }).strict()))
      .toThrow('field_contract_unbounded_string');
    expect(() => buildWorkflowAssessmentFieldContract(z.object({ a: z.array(z.string().max(3)) }).strict()))
      .toThrow('field_contract_unbounded_array');
    expect(() => buildWorkflowAssessmentFieldContract(z.object({ a: z.number() }).strict()))
      .toThrow('field_contract_unsupported_type');
    expect(() => buildWorkflowAssessmentFieldContract(z.object({ a: z.string().max(3).optional() }).strict()))
      .toThrow('field_contract_unsupported_type');
    expect(() => buildWorkflowAssessmentFieldContract(z.object({ a: z.string().max(3) })))
      .toThrow('field_contract_non_strict_object');
    // A schema change changes the generated text, so the embedded-equality test fails.
    expect(buildWorkflowAssessmentFieldContract(z.object({ a: z.string().min(1).max(7) }).strict()))
      .toContain('- `assessment`: a: string(1-7, aim ≤5).');
  });
});

describe('D3 leaves the D1 envelope and both provider paths aligned', () => {
  it('keeps the D1 compact provider envelope byte-for-byte', () => {
    expect(WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA).toEqual({
      type: 'object', additionalProperties: false, required: ['assessmentJson'],
      properties: { assessmentJson: { type: 'string' } },
    });
  });

  it('sends identical v9 instructions through the standard and observed providers', async () => {
    create.mockResolvedValue({ id: 'm', _request_id: 'r', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{}' }] });
    const request = { model: 'claude-sonnet-4-6', timeoutMs: 420_000, maxOutputTokens: 20_000, inputJson: '{}' };
    await callClaudeForWorkflowAssessment(request);
    await createObservedWorkflowAssessmentProvider(vi.fn())(request);
    const [standard] = create.mock.calls[0]!;
    const [observed] = create.mock.calls[1]!;
    expect(observed.system).toBe(standard.system);
    expect(standard.system).toBe(loadObservedWorkflowAssessmentPrompt());
    expect(embeddedContract(standard.system)).toBe(buildWorkflowAssessmentFieldContract());
    expect(WORKFLOW_ASSESSMENT_ENVELOPE_PROMPT_VERSION).toBe('v9'); // D-7 changed the embedded contract
  });
});

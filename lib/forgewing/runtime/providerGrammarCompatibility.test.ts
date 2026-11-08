// Offline provider-grammar compatibility gate.
//
// The Claude structured-output API rejects some JSON Schema validation keywords outright: HTTP 400, with only
// the first offender named. Verified on claude-sonnet-4-6 on 2026-11-06, the rejected keywords are `maxItems`,
// `uniqueItems`, number `minimum`/`maximum` and `oneOf`. Any task whose grammar carries one of them fails every
// call. This gate captures the grammar each production request builder actually sends, by driving every
// provider against a stubbed client. Builders are enumerated dynamically from their module exports, so a new
// provider is covered automatically. The gate then walks every nested schema position and fails on any keyword
// outside the verified subset. Bounds the grammar cannot carry stay enforced by each task's strict Zod parser;
// the parser parity tests prove that. This file makes no network call.
//
// The decomposed Workflow Assessment (P4) sends grammars generated at runtime from the strict Zod schema through
// createObservedWorkflowAssessmentStageProvider: stage A for each intake version, and stage B shaped by each
// step's classification. They are not registered constants, so they are captured separately by driving that
// provider over every shape the pipeline can send. Stage B uses `$defs`/`$ref`, accepted on claude-sonnet-4-6
// in the 2026-11-06 P1 compile probes (p1-probes); the walker allows them only at the root, and every `$ref`
// must resolve.
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/ai/claudeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai/claudeClient')>()),
  getClaudeClient: () => ({ messages: { create: messagesCreate } }),
}));

import * as clientModule from '@/lib/forgewing/runtime/client';
import * as structuredOutput from '@/lib/forgewing/runtime/structuredOutput';
import * as repositoryPlanOutput from '@/lib/forgewing/runtime/repositoryPlanGuidanceStructuredOutput';
import * as workflowAssessmentOutput from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import { createObservedForgewingProvider, OBSERVED_PROVIDER_TASKS, type ObservedProviderTask } from '@/lib/forgewing/runtime/observedProviders';
import { createObservedWorkflowAssessmentProvider, createObservedWorkflowAssessmentStageProvider } from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import {
  buildStageAGrammar, buildStageBGrammar, STAGE_B_DETAIL_SCHEMAS, STAGE_B_MAX_STEPS_PER_CALL, STAGE_SOURCE_QUESTIONS,
  type StageIntakeVersion, type StageStep,
} from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
import { buildCaseInvestigationMessagesRequest, CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/caseInvestigationClient';
import { buildValueReadingMessagesRequest } from '@/lib/forgewing/runtime/valueReadingClient';
import { buildValueReadingMessagesRequestV2 } from '@/lib/forgewing/runtime/valueReadingClientV2';
import { buildValueReadingMessagesRequestV3 } from '@/lib/forgewing/runtime/valueReadingClientV3';
import { VALUE_READING_EXECUTION, VALUE_READING_OUTPUT_JSON_SCHEMA, type ValueReadingProviderRequest } from '@/lib/valueReadingContract';
import { askOperatorGuidanceWithClaude, OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA } from '@/lib/server/ai/askProject';

/** Every keyword allowed at a schema position, each verified accepted on claude-sonnet-4-6 (2026-11-06). */
const VERIFIED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf',
  'minItems', // only 0 or 1
  'pattern', // only fixed-count quantifiers; range quantifiers are rejected on Sonnet 5.5
  'minLength', 'maxLength', // accepted; maxLength is a hint, not enforced (the Zod parser is the bound)
  '$defs', '$ref', // accepted in the P1 compile probes; root-level $defs only, and every $ref must resolve
]);
const KNOWN_REJECTED = ['maxItems', 'uniqueItems', 'minimum', 'maximum', 'oneOf'];

type Violation = Readonly<{ path: string; keyword: string }>;

/** Walks schema positions only (not property names or enum values) and reports every unverified construct. */
function grammarViolations(root: unknown): Violation[] {
  const defs = (root && typeof root === 'object' ? (root as { $defs?: unknown }).$defs : undefined) as Record<string, unknown> | undefined;
  const walk = (schema: unknown, path: string): Violation[] => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [{ path, keyword: '<non-object schema>' }];
    const out: Violation[] = [];
    const node = schema as Record<string, unknown>;
    for (const [keyword, value] of Object.entries(node)) {
      if (!VERIFIED_KEYWORDS.has(keyword)) { out.push({ path, keyword }); continue; }
      if (keyword === 'minItems' && value !== 0 && value !== 1) out.push({ path, keyword: `minItems=${String(value)}` });
      if (keyword === 'pattern' && (typeof value !== 'string' || /\{\d*,\d*\}/.test(value))) out.push({ path, keyword: 'pattern range quantifier' });
      if (keyword === 'additionalProperties' && value !== false) out.push({ path, keyword: 'additionalProperties!=false' });
      if (keyword === '$defs' && path !== '$') out.push({ path, keyword: 'nested $defs' });
      if (keyword === '$ref' && !(typeof value === 'string' && value.startsWith('#/$defs/') && defs && value.slice(8) in defs)) {
        out.push({ path, keyword: `unresolved $ref ${String(value)}` });
      }
      if (keyword === 'properties' || keyword === '$defs') {
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) out.push(...walk(child, `${path}.${keyword}.${name}`));
      }
      if (keyword === 'items') out.push(...walk(value, `${path}.items`));
      if (keyword === 'anyOf') (value as unknown[]).forEach((child, index) => out.push(...walk(child, `${path}.anyOf[${index}]`)));
    }
    const declaresObject = node.type === 'object' || 'properties' in node;
    if (declaresObject && node.additionalProperties !== false) out.push({ path, keyword: 'open object' });
    if ('properties' in node) {
      const declared = new Set(Object.keys(node.properties as object));
      for (const key of (node.required as string[] | undefined) ?? []) if (!declared.has(key)) out.push({ path, keyword: `required '${key}' undeclared` });
    }
    return out;
  };
  return walk(root, '$');
}

const REQUEST = { model: 'claude-sonnet-4-6', timeoutMs: 1_000, maxOutputTokens: 16, inputJson: '{}' };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const VALUE_REQUEST: ValueReadingProviderRequest = {
  requestDigestSha256: 'd'.repeat(64), renderDigestSha256: createHash('sha256').update(PNG).digest('hex'),
  model: 'claude-sonnet-4-6', timeoutMs: VALUE_READING_EXECUTION.timeoutMs, maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens,
  promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId, promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
  outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion, image: { mediaType: 'image/png', bytes: PNG }, textExcerpts: null,
};

const sentSchema = (): unknown => {
  const body = messagesCreate.mock.calls.at(-1)?.[0] as { output_config?: { format?: { type?: string; schema?: unknown } } };
  expect(body.output_config?.format?.type).toBe('json_schema');
  return body.output_config?.format?.schema;
};

/** Captures, per sending path, the grammar object exactly as it is placed in the provider request body. */
async function captureProviderGrammars(): Promise<Map<string, unknown>> {
  const captured = new Map<string, unknown>();
  const providers = Object.entries(clientModule).filter(([name, value]) => name.startsWith('callClaudeFor') && typeof value === 'function');
  expect(providers.length).toBeGreaterThanOrEqual(11); // all are driven below, including any added later
  for (const [name, provider] of providers) {
    await (provider as (request: typeof REQUEST, prompt: string) => Promise<string>)(REQUEST, 'EVALUATION PROMPT');
    captured.set(`client.${name}`, sentSchema());
  }
  await clientModule.createObservedRecoveryCandidateV2EvaluationProvider(() => undefined)(REQUEST);
  captured.set('client.createObservedRecoveryCandidateV2EvaluationProvider', sentSchema());
  for (const task of Object.keys(OBSERVED_PROVIDER_TASKS) as ObservedProviderTask[]) {
    await createObservedForgewingProvider(task, () => undefined)(REQUEST);
    captured.set(`observed.${task}`, sentSchema());
  }
  await createObservedWorkflowAssessmentProvider(() => undefined)(REQUEST);
  captured.set('observed.workflow_assessment', sentSchema());
  await askOperatorGuidanceWithClaude({ question: 'q', intent: 'i', allowedNextSteps: [], context: {}, model: 'claude-sonnet-4-6' });
  captured.set('askProject.askOperatorGuidanceWithClaude', sentSchema());
  captured.set('caseInvestigation.build', buildCaseInvestigationMessagesRequest('claude-sonnet-4-6',
    { system: 's', context: {}, offeredActionKinds: [] }).body.output_config.format.schema);
  captured.set('valueReading.v1', buildValueReadingMessagesRequest(VALUE_REQUEST, 'P').body.output_config.format.schema);
  captured.set('valueReading.v2', buildValueReadingMessagesRequestV2(VALUE_REQUEST, 'P').body.output_config.format.schema);
  captured.set('valueReading.v3', buildValueReadingMessagesRequestV3({ ...VALUE_REQUEST, model: 'claude-sonnet-5-5', maxOutputTokens: 500 },
    'P').body.output_config.format.schema); // V3 is bound to its qualified model and output cap
  return captured;
}

/** The decomposed Workflow Assessment's runtime-generated grammars, captured from the real stage provider. */
async function captureStageGrammars(): Promise<Map<string, unknown>> {
  const provider = createObservedWorkflowAssessmentStageProvider(() => undefined);
  const classifications = Object.keys(STAGE_B_DETAIL_SCHEMAS) as (keyof typeof STAGE_B_DETAIL_SCHEMAS)[];
  const steps = (count: number): StageStep[] => Array.from({ length: count },
    (_, i) => ({ stepId: `step-${String(i + 1).padStart(2, '0')}`, classification: classifications[i % classifications.length]! }));
  const shapes: [string, 'A' | 'B', unknown][] = [
    ...(Object.keys(STAGE_SOURCE_QUESTIONS) as StageIntakeVersion[]).map((v): [string, 'A', unknown] => [`stageA.${v}`, 'A', buildStageAGrammar(v)]),
    ...classifications.map((c): [string, 'B', unknown] => [`stageB.single.${c}`, 'B', buildStageBGrammar([{ stepId: 'step-01', classification: c }])]),
    ['stageB.allClassifications', 'B', buildStageBGrammar(steps(classifications.length))],
    ['stageB.maxBatch', 'B', buildStageBGrammar(steps(STAGE_B_MAX_STEPS_PER_CALL))],
  ];
  const captured = new Map<string, unknown>();
  for (const [name, stage, grammar] of shapes) {
    await provider(REQUEST, { stage, batch: 0, prompt: 'STAGE PROMPT', grammar: grammar as never });
    const schema = sentSchema();
    expect(schema, `${name} is sent unchanged`).toBe(grammar);
    captured.set(name, schema);
  }
  return captured;
}

/** Every exported provider grammar constant, by name. */
const grammarConstants = (): Map<unknown, string> => {
  const named = new Map<unknown, string>();
  for (const exportsOf of [structuredOutput, repositoryPlanOutput, workflowAssessmentOutput]) {
    for (const [name, value] of Object.entries(exportsOf)) if (name.endsWith('_OUTPUT_JSON_SCHEMA')) named.set(value, name);
  }
  named.set(CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA, 'CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA');
  named.set(VALUE_READING_OUTPUT_JSON_SCHEMA, 'VALUE_READING_OUTPUT_JSON_SCHEMA');
  named.set(OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA, 'OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA');
  return named;
};

/**
 * Known exceptions: none. Recovery V2 was the last one, corrected 2026-11-07 together with its reviewed
 * Phase 17 pin migration. Adding an entry here requires the same kind of review.
 */
const KNOWN_INCOMPATIBLE: Readonly<Record<string, readonly Violation[]>> = {};

describe('provider grammar compatibility (offline)', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({ id: 'msg', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{}' }] });
  });

  it('the walker catches each known-rejected keyword at any depth, including nested and anyOf positions', () => {
    for (const keyword of KNOWN_REJECTED) {
      const nested = { type: 'object', additionalProperties: false, required: ['a'], properties: {
        a: { type: 'array', items: { anyOf: [{ type: 'object', additionalProperties: false, properties: { b: { type: 'number', [keyword]: 1 } } }] } } } };
      expect(grammarViolations(nested)).toEqual([{ path: '$.properties.a.items.anyOf[0].properties.b', keyword }]);
    }
    expect(grammarViolations({ type: 'array', items: { type: 'string' }, minItems: 2 })).toEqual([{ path: '$', keyword: 'minItems=2' }]);
    expect(grammarViolations({ type: 'string', pattern: '^[a-f]{1,64}$' })).toEqual([{ path: '$', keyword: 'pattern range quantifier' }]);
    expect(grammarViolations({ type: 'object', properties: {} })).toEqual([{ path: '$', keyword: 'open object' }]);
    expect(grammarViolations({ type: 'string', format: 'uri' })).toEqual([{ path: '$', keyword: 'format' }]);
    // A property NAMED like a keyword is not a keyword.
    expect(grammarViolations({ type: 'object', additionalProperties: false, required: ['maximum'], properties: { maximum: { type: 'number' } } })).toEqual([]);
    // $defs are walked, nested $defs are refused, and every $ref must resolve to a root definition.
    for (const keyword of KNOWN_REJECTED) {
      expect(grammarViolations({ type: 'object', additionalProperties: false, required: ['s'], properties: { s: { $ref: '#/$defs/X' } },
        $defs: { X: { type: 'object', additionalProperties: false, properties: { n: { type: 'number', [keyword]: 1 } } } } }))
        .toEqual([{ path: '$.$defs.X.properties.n', keyword }]);
    }
    expect(grammarViolations({ type: 'object', additionalProperties: false, properties: { s: { $ref: '#/$defs/Missing' } }, $defs: {} }))
      .toEqual([{ path: '$.properties.s', keyword: 'unresolved $ref #/$defs/Missing' }]);
    expect(grammarViolations({ type: 'object', additionalProperties: false, properties: { s: { $defs: {} } } }))
      .toEqual([{ path: '$.properties.s', keyword: 'nested $defs' }]);
  });

  it('every decomposed Workflow Assessment stage grammar the stage provider sends uses only provider-verified keywords', async () => {
    const captured = await captureStageGrammars();
    // 2 intake versions, one single-step stage B per classification, all classifications, and a full 30-step batch.
    expect(captured.size).toBe(Object.keys(STAGE_SOURCE_QUESTIONS).length + Object.keys(STAGE_B_DETAIL_SCHEMAS).length + 2);
    for (const [name, grammar] of captured) expect(grammarViolations(grammar), name).toEqual([]);
  });

  it('enumerates every provider grammar from the actual request builders, and the enumeration is complete', async () => {
    const captured = await captureProviderGrammars();
    const named = grammarConstants();
    // Every grammar actually sent is a named, audited constant (no ad-hoc inline grammar escapes the gate) ...
    for (const [site, schema] of captured) expect(named.has(schema), `${site} sends an unregistered grammar`).toBe(true);
    // ... and every exported grammar constant is actually sent by some production builder.
    const sent = new Set(captured.values());
    for (const [schema, name] of named) expect(sent.has(schema), `${name} is exported but never sent`).toBe(true);
    expect([...named.values()].sort()).toEqual([
      'CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA', 'COLUMN_MAPPING_OUTPUT_JSON_SCHEMA', 'OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA',
      'OPERATOR_GUIDANCE_OUTPUT_JSON_SCHEMA', 'PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA', 'PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA',
      'PRICING_RATE_CLUSTER_RECOVERY_OUTPUT_JSON_SCHEMA', 'RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA', 'REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA',
      'REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA', 'TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA', 'VALUE_READING_OUTPUT_JSON_SCHEMA',
      'WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA',
    ]);
  });

  it('every sent grammar uses only provider-verified keywords, with no exceptions', async () => {
    const captured = await captureProviderGrammars();
    const named = grammarConstants();
    const byName = new Map<string, Violation[]>();
    for (const schema of new Set(captured.values())) byName.set(named.get(schema)!, grammarViolations(schema));
    for (const [name, violations] of byName) expect(violations, name).toEqual(KNOWN_INCOMPATIBLE[name] ?? []);
  });

  it('the five corrected task grammars carry none of the provider-rejected keywords', () => {
    for (const schema of [structuredOutput.COLUMN_MAPPING_OUTPUT_JSON_SCHEMA, structuredOutput.OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA,
      structuredOutput.TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA, structuredOutput.PRICING_RATE_CLUSTER_RECOVERY_OUTPUT_JSON_SCHEMA,
      repositoryPlanOutput.REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA]) {
      const text = JSON.stringify(schema);
      for (const keyword of KNOWN_REJECTED) expect(text).not.toContain(`"${keyword}"`);
      expect(grammarViolations(schema)).toEqual([]);
    }
  });
});

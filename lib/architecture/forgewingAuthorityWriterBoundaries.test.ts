import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing S4: broad in investigation, narrow in authority.
 *
 * No AI surface may reach a human-authority writer, directly or through any
 * chain of runtime imports. An AI surface is any production module that
 * imports a provider SDK, the shared Claude client, the Forgewing runtime, the
 * legacy AI modules, or one of the named Forgewing consumer seams. Surfaces are
 * derived from the import graph, so a new provider caller is covered the moment
 * it exists. Human-authority writers change truth, clear findings, approve
 * relationships, review proposals or activate mappings: they belong to typed
 * human routes only.
 *
 * Document-precedence (relationship) writes live inside their route handler,
 * which nothing can import; the route is listed so that stays true.
 */

const ROOTS = ['app', 'components', 'lib', 'scripts'];
const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.(test|spec)\.tsx?$/;

const HUMAN_AUTHORITY_WRITERS = [
  'lib/server/regionBoundHumanAssertionWriter.ts', // reviewed values (human_fact_assertions)
  'lib/server/forgewingRecoveryReview.ts', // recovery proposal review
  'lib/server/customerHeaderMappingLifecycle.ts', // mapping approval / activation
  'lib/server/decisionClosure.ts', // finding / decision clearance
  'lib/server/manualRateLinkClosure.ts', // rate-link finding closure
  'lib/server/executionQueue.ts', // execution outcomes
  'lib/server/workflowAssessmentReview.ts', // assessment review
  'lib/server/workflowEngineeringReview.ts', // engineering recommendation review
  'lib/server/workflowTasks.ts', // operator work queue
  'lib/server/decisionPersistence.ts', // operator decisions
  'lib/server/legacyWorkflowEngine.ts', // workflow rule execution
  'app/api/projects/[id]/document-precedence/route.ts', // relationship / precedence approval
] as const;

/** Imports that make a module an AI surface. */
const AI_ENTRY = [
  /^@anthropic-ai\/sdk$/, /^openai$/, /^@instructor-ai\/instructor$/,
  /^@\/lib\/server\/ai\//, /^@\/lib\/forgewing\//, /^@\/lib\/ai\//,
];
/** Named Forgewing consumer seams (importBoundaries FORGEWING_AUTHORIZED_CONSUMERS) and provider runners. */
const NAMED_AI_SURFACES = [
  'lib/extraction/persistence/complianceShadow.ts',
  'lib/server/workflowAssessment.ts',
  'lib/server/workflowAssessmentClaim.ts',
  'lib/server/repositoryPlanGenerationWorker.ts',
  'lib/forgewingRecoveryProposal.ts',
  'lib/server/forgewingRecoveryProposalPersistence.ts',
  'lib/server/valueReadingEngine.ts',
  'lib/server/caseInvestigationRunner.ts',
  'lib/server/documentAiEnrichment.ts',
  'lib/server/aiDecisionPersistence.ts',
  // Long-running worker entry points that host provider reasoning.
  'scripts/workers/repository-plan-worker.ts',
  'scripts/workers/improvement-deployment-worker.ts',
];

const posix = (file: string) => file.split(path.sep).join('/');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return SOURCE.test(name) && !TEST.test(name) ? [posix(full)] : [];
  });
}

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

type Graph = Readonly<{ files: Set<string>; edges: Map<string, Set<string>>; specifiers: Map<string, string[]> }>;
let cached: Graph | null = null;
function graph(): Graph {
  if (cached) return cached;
  const files = new Set(ROOTS.flatMap(walk));
  const resolve = (from: string, specifier: string): string | null => {
    const base = specifier.startsWith('@/') ? specifier.slice(2)
      : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : null;
    if (!base) return null;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => files.has(candidate)) ?? null;
  };
  const edges = new Map<string, Set<string>>();
  const specifiers = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const out = new Set<string>();
    const named: string[] = [];
    for (const match of text.matchAll(IMPORT)) {
      if (match[2]) continue; // `import type` carries no runtime reach
      const specifier = match[3] ?? match[4];
      named.push(specifier);
      const target = resolve(file, specifier);
      if (target) out.add(target);
    }
    edges.set(file, out);
    specifiers.set(file, named);
  }
  cached = { files, edges, specifiers };
  return cached;
}

function aiSurfaces(g: Graph): string[] {
  return [...g.files].filter((file) => NAMED_AI_SURFACES.includes(file)
    || file.startsWith('lib/forgewing/') || file.startsWith('lib/ai/') || file.startsWith('lib/server/ai/')
    || (g.specifiers.get(file) ?? []).some((specifier) => AI_ENTRY.some((entry) => entry.test(specifier))))
    // Evaluation harnesses measure Forgewing offline and are fenced by their own boundary tests.
    .filter((file) => !file.startsWith('lib/evaluation/') && !file.startsWith('scripts/evaluation/'));
}

function reachedWriters(g: Graph, start: string): string[] {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of g.edges.get(current) ?? []) {
      if (!parent.has(next)) { parent.set(next, current); queue.push(next); }
    }
  }
  return HUMAN_AUTHORITY_WRITERS.filter((writer) => parent.has(writer)).map((writer) => {
    const chain: string[] = [];
    for (let at: string | null | undefined = writer; at; at = parent.get(at)) chain.unshift(at);
    return chain.join(' -> ');
  });
}

const WALK_TIMEOUT_MS = 120_000;

describe('Forgewing authority-writer boundaries (S4)', () => {
  it('every listed human-authority writer exists', () => {
    const g = graph();
    expect(HUMAN_AUTHORITY_WRITERS.filter((writer) => !g.files.has(writer))).toEqual([]);
  }, WALK_TIMEOUT_MS);

  it('derives a non-trivial AI surface set that includes every provider path', () => {
    const surfaces = aiSurfaces(graph());
    for (const expected of ['lib/server/ai/claudeClient.ts', 'lib/ai/instructor/client.ts',
      'lib/server/documentAiEnrichment.ts', 'lib/server/valueReadingEngine.ts',
      'app/api/projects/[id]/ask/route.ts', 'app/api/projects/[id]/resolution-cases/value-reading/route.ts',
      'lib/extraction/persistence/complianceShadow.ts', 'scripts/workers/repository-plan-worker.ts']) {
      expect(surfaces).toContain(expected);
    }
  }, WALK_TIMEOUT_MS);

  it('no AI surface reaches a human-authority writer, directly or transitively', () => {
    const g = graph();
    const violations = aiSurfaces(g).flatMap((surface) => reachedWriters(g, surface));
    expect(violations).toEqual([]);
  }, WALK_TIMEOUT_MS);

  it('the reviewed-value read module exposes no writer', () => {
    const reader = readFileSync('lib/server/regionBoundHumanAssertions.ts', 'utf8');
    expect(reader).not.toMatch(/\.rpc\(|RECORD_REGION_BOUND_ASSERTION_RPC|recordRegionBoundAssertion/);
    const writer = readFileSync('lib/server/regionBoundHumanAssertionWriter.ts', 'utf8');
    expect(writer).toContain('export async function recordRegionBoundAssertion(');
  });

  it('the only production importers of the reviewed-value writer are human routes', () => {
    const g = graph();
    const importers = [...g.files].filter((file) =>
      (g.edges.get(file) ?? new Set()).has('lib/server/regionBoundHumanAssertionWriter.ts'));
    expect(importers.filter((file) => !file.startsWith('scripts/')).sort())
      .toEqual(['app/api/documents/[id]/facts/region-assertions/route.ts']);
  }, WALK_TIMEOUT_MS);
});

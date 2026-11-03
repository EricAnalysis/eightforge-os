import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Project intelligence (the unified Forgewing project context and operator
 * guidance) reads and explains. These hold the shape of that promise in source:
 * the pure layer has no reach, the read seam writes nothing, and the provider path
 * stays inside Project Ask's gates and never touches the parked Case Investigation
 * workflow. The S4 writer guard already derives this path as an AI surface.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PURE_ROOT = 'lib/projectIntelligence';
const pureFiles = readdirSync(PURE_ROOT)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => path.posix.join(PURE_ROOT, name));

const WRITES = ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('];

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

describe('project intelligence boundaries', () => {
  it('the pure layer reaches no database, provider, gate or authority writer', () => {
    expect(pureFiles.length).toBeGreaterThan(0);
    for (const file of pureFiles) {
      const source = code(file);
      for (const term of [...WRITES, '@/lib/server/', '@anthropic-ai/sdk', '@/lib/forgewing/', 'supabase']) {
        expect(`${file}:${term}:${source.includes(term)}`).toBe(`${file}:${term}:false`);
      }
    }
  });

  it('the read seam only reads', () => {
    const source = code('lib/server/projectIntelligenceRead.ts');
    for (const term of WRITES) expect(`${term}:${source.includes(term)}`).toBe(`${term}:false`);
    for (const term of ['@/lib/server/ai', 'forgewingGates']) expect(source).not.toContain(term);
  });

  it('no part of the path names the parked workflow or its prompt', () => {
    const route = code('app/api/projects/[id]/ask/route.ts');
    for (const file of [...pureFiles, 'lib/server/projectIntelligenceRead.ts', 'lib/server/ai/operatorGuidance.ts']) {
      expect(code(file)).not.toContain('case_investigation');
      expect(code(file)).not.toContain('CASE_INVESTIGATION_SYSTEM_PROMPT');
    }
    expect(route).not.toContain('case_investigation');
    expect(route).not.toContain('CASE_INVESTIGATION');
    // Only the pure citation and number helpers are shared with that runner, never its entry point.
    expect(code('lib/server/ai/operatorGuidance.ts')).not.toContain('runProviderCaseInvestigation');
  });

  it('guidance spends the Ask budget on the Ask route, behind its own switch and Ask\'s model guard', () => {
    const route = code('app/api/projects/[id]/ask/route.ts');
    const guidance = route.slice(route.indexOf('async function handleOperatorGuidance('), route.indexOf('export async function POST('));
    expect(guidance.indexOf('isProjectAskGuidanceProviderEnabled()')).toBeGreaterThan(-1);
    const gates = ["workflow: 'project_ask'", 'askModel.qualified', 'reserveForgewingProviderCall(', 'askOperatorGuidanceWithClaude('];
    const positions = gates.map((term) => guidance.indexOf(term));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('the plain Ask contract is untouched: same prompt, same output, answer and model only', () => {
    const route = code('app/api/projects/[id]/ask/route.ts');
    expect(route).toContain("'project_ask_v1', askModel.model, ASK_PROJECT_CLAUDE_SYSTEM_PROMPT, question, context");
    expect(route).toContain('return NextResponse.json({ answer: answer.answer, model: answer.model });');
  });

  it('the operator route never returns a product signal; only the platform-gated route does', () => {
    const route = code('app/api/projects/[id]/ask/route.ts');
    expect(route).toMatch(/return NextResponse\.json\(\{\s*recommendation,\s*model: providerStatus === 'accepted' \? askModel\.model : null,\s*\}\);/);
    const internal = code('app/api/internal/project-intelligence/signals/route.ts');
    expect(internal).toContain('resolveWorkflowPlatformReviewAccess(actor.actor)');
    expect(internal.indexOf('access.allowed')).toBeLessThan(internal.indexOf('deriveProductImprovementSignals(assessment)'));
    expect(internal).toContain(".eq('organization_id', actor.actor.organizationId)");
  });

  it('durable records are written and read only through their seam, and no truth path reads them', () => {
    const named = /project_intelligence_(?:guidance_events|signals|signal_reviews)|projectIntelligenceRecords'/;
    const users = ['app', 'components', 'lib', 'scripts'].flatMap(walk).filter((file) => named.test(code(file)));
    expect(users.sort()).toEqual([
      'app/api/internal/project-intelligence/signals/[signalId]/review/route.ts',
      'app/api/internal/project-intelligence/signals/route.ts',
      'app/api/projects/[id]/ask/route.ts',
      'lib/server/projectIntelligenceRecords.ts',
    ]);
  }, 120_000);

  it('the record seam appends to its own tables and can touch nothing else', () => {
    const source = code('lib/server/projectIntelligenceRecords.ts');
    for (const term of ['.update(', '.delete(', '.rpc(', 'forgewingGates', '@/lib/server/ai', '@/lib/validator', 'orchestrator_']) {
      expect(`${term}:${source.includes(term)}`).toBe(`${term}:${term === 'orchestrator_'}`);
    }
    const tables = [...source.matchAll(/\.from\(([^)]+)\)/g)].map((match) => match[1]);
    expect([...new Set(tables)].sort()).toEqual(['GUIDANCE_EVENTS_TABLE', 'SIGNALS_TABLE', 'SIGNAL_REVIEWS_TABLE']);
    expect(source).not.toContain('question');
  });

  it('a signal review is platform-gated before it reads a body or writes', () => {
    const review = code('app/api/internal/project-intelligence/signals/[signalId]/review/route.ts');
    expect(review.indexOf('access.allowed')).toBeGreaterThan(-1);
    expect(review.indexOf('access.allowed')).toBeLessThan(review.indexOf('request.json()'));
    expect(review.indexOf('access.allowed')).toBeLessThan(review.indexOf('recordSignalReview(admin'));
    expect(review).toContain('organizationId: actor.actor.organizationId');
    for (const term of ['improvement_signal', 'orchestrator', 'validator']) expect(review.toLowerCase()).not.toContain(term);
  });

  it('a recommendation and a signal share no type: neither contains the other', () => {
    expect(code('lib/projectIntelligence/operatorRecommendation.ts')).not.toContain('improvementSignal');
    expect(code('lib/projectIntelligence/improvementSignal.ts')).not.toContain('operatorRecommendation');
  });

  it('the first switch is off by default and strict', async () => {
    const { isProjectAskGuidanceProviderEnabled } = await import('@/lib/server/ai/askModel');
    expect(isProjectAskGuidanceProviderEnabled({})).toBe(false);
    for (const value of ['true', 'yes', '0', '']) {
      expect(isProjectAskGuidanceProviderEnabled({ FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED: value })).toBe(false);
    }
    expect(isProjectAskGuidanceProviderEnabled({ FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED: '1' })).toBe(true);
  });
});

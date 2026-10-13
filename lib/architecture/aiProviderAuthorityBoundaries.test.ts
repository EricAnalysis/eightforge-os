import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every AI provider path outside the Forgewing gates is evidence-only. A model
 * reading never becomes extraction truth, an operator decision or a workflow
 * task without a human. Forgewing surfaces have their own boundary tests; this
 * one fences the legacy paths (OpenAI Instructor assist, document AI
 * enrichment) and the provider SDKs themselves.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
let productionFiles: string[] | null = null;
const production = () => (productionFiles ??= ['lib', 'app', 'components'].flatMap(walk));
const WALK_TIMEOUT_MS = 60_000;
const posix = (file: string) => file.split(path.sep).join('/');

const PROVIDER_SDK_IMPORT = /from\s+['"](@anthropic-ai\/sdk|openai|@instructor-ai\/instructor)['"]/;

/** The legacy AI modules. None may import a canonical or human-authority writer. */
const LEGACY_AI_MODULES = [
  'lib/ai/instructor/client.ts',
  'lib/ai/instructor/classifyDocumentFamily.ts',
  'lib/ai/instructor/extractionAssist.ts',
  'lib/server/documentAiEnrichment.ts',
  'lib/server/aiDecisionPersistence.ts',
];

const AUTHORITY_WRITERS = [
  '@/lib/canonical', '@/lib/validator', '@/lib/contracts', '@/lib/projectFacts',
  '@/lib/truthQuery', '@/lib/effectiveFacts', '@/lib/humanFactAssertions',
  '@/lib/server/regionBoundHumanAssertions', '@/lib/server/decisionPersistence',
  '@/lib/server/decisionClosure', '@/lib/server/workflowTasks', '@/lib/server/legacyWorkflowEngine',
  '@/lib/server/forgewingRecoveryReview', '@/lib/server/customerHeaderMappingLifecycle',
  '@/lib/server/manualRateLinkClosure',
];

describe('AI provider authority boundaries (legacy paths are evidence only)', () => {
  it('provider SDKs are imported only by the named provider clients', () => {
    const importers = production().filter((file) => PROVIDER_SDK_IMPORT.test(code(file))).map(posix);
    // A further importer is a new provider path: route it through the shared
    // Claude client and the Forgewing gates, or add it here deliberately.
    expect(importers.sort()).toEqual([
      'app/api/test/anthropic/route.ts',
      'app/api/test/openai/route.ts',
      'lib/ai/instructor/client.ts',
      'lib/server/ai/claudeClient.ts',
      'lib/server/documentAiEnrichment.ts',
    ]);
  }, WALK_TIMEOUT_MS);

  it('the Instructor assist is explicit opt-in, never enabled by an OpenAI key alone', () => {
    const client = code('lib/ai/instructor/client.ts');
    expect(client).toContain("process.env.EIGHTFORGE_INSTRUCTOR_ENABLED === '1'");
    expect(client).not.toContain("EIGHTFORGE_INSTRUCTOR_ENABLED !== '0'");
  });

  it('the Instructor assist records its reading and never writes typed fields', () => {
    const assist = code('lib/ai/instructor/extractionAssist.ts');
    expect(assist).not.toContain('mergedTypedFields');
    expect(assist).toContain("authority: 'non_authoritative'");
    const extraction = code('lib/server/documentExtraction.ts');
    expect(extraction).not.toMatch(/typed_fields\s*=\s*extractionAssist/);
    expect(extraction).not.toContain('mergedTypedFields');
  });

  it('every heuristic decision run drops model-origin detections before persistence or workflows', () => {
    const callers = production().filter((file) => /await runDecisionEngine\(/.test(code(file))).map(posix);
    expect(callers.sort()).toEqual([
      'app/api/jobs/process/[jobId]/route.ts',
      'lib/pipeline/decisionEngine.ts',
    ]);
    for (const caller of callers) {
      expect(`${caller}:${/deterministicDecisionsOnly\(await runDecisionEngine\(/.test(code(caller))}`)
        .toBe(`${caller}:true`);
    }
    expect(code('lib/pipeline/decisionEngine.ts')).toContain("decision.source !== 'ai_enriched'");
  }, WALK_TIMEOUT_MS);

  it('legacy AI modules import no canonical or human-authority writer', () => {
    for (const file of LEGACY_AI_MODULES) {
      const source = code(file);
      const offenders = AUTHORITY_WRITERS.filter((writer) =>
        source.includes(`'${writer}'`) || source.includes(`'${writer}/`));
      expect(`${file}:${offenders.join(',')}`).toBe(`${file}:`);
    }
  });
});

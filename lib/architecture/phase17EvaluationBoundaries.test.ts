import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Phase 17 architecture guards.
 *
 * The live behavioral evaluation is only trustworthy if it cannot become
 * authority: no persistence, no database, no label leakage into production, no
 * qualification mutation, and no provider call from ordinary test or CI runs.
 */

const ROOT = process.cwd();
const SOURCE = /\.(?:ts|tsx)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx)$/;
const PHASE17_LIB = 'lib/evaluation/forgewing/phase17';
const PHASE17_SCRIPTS = 'scripts/evaluation/phase17';
const SEAMS = `${PHASE17_SCRIPTS}/phase17ProductionSeams.ts`;

function walk(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const relative = `${directory}/${entry}`;
    if (['node_modules', '.next', '.git', '.claude'].includes(entry)) return [];
    if (statSync(path.join(ROOT, relative)).isDirectory()) return walk(relative);
    return SOURCE.test(entry) ? [relative] : [];
  });
}

const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const code = (relative: string) => read(relative)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const phase17Sources = () => [...walk(PHASE17_LIB), ...walk(PHASE17_SCRIPTS)]
  .filter((relative) => !TEST.test(relative));

describe('Phase 17 evaluation boundaries', () => {
  it('keeps human labels out of every production path', () => {
    const offenders = ['app', 'components', 'lib', 'types']
      .flatMap(walk)
      .filter((relative) => !TEST.test(relative) && !relative.startsWith(`${PHASE17_LIB}/`))
      .filter((relative) => read(relative).includes('dnContinuationLabels'));
    expect(offenders).toEqual([]);
  }, 30_000);

  it('gives the harness no persistence, database, RPC or review reach', () => {
    const forbidden = [
      'getSupabaseAdmin', 'supabaseAdmin', '@supabase', '.rpc(', ".from('",
      'persistForgewingRecoveryProposal', 'persistForgewingRecoveryGenerationOutcome',
      'recordRecoveryGenerationOutcome', 'loadRecoveryEvaluationPriorState',
      'recordForgewingRecoveryProposalReview', 'forgewing_recovery_proposals',
      'forgewing_recovery_reviews', 'forgewing_recovery_generation_outcomes', 'document_extractions',
      'processDocument', 'recovery_reprocess',
    ];
    const offenders = phase17Sources().flatMap((relative) =>
      forbidden.filter((term) => code(relative).includes(term)).map((term) => `${relative} -> ${term}`));
    expect(offenders).toEqual([]);
  });

  it('imports exactly two production seams, only at the script layer', () => {
    const importers = phase17Sources().filter((relative) =>
      /from '@\/lib\/(?:server|extraction\/persistence)\//.test(code(relative)));
    expect(importers).toEqual([SEAMS]);
    const seamImports = [...code(SEAMS).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)]
      .filter((match) => !match[1])
      .map((match) => `${match[2]!.trim()} <- ${match[3]}`);
    expect(seamImports).toEqual([
      'scheduleRecoveryCandidateV2Shadow <- @/lib/extraction/persistence/complianceShadow',
      'buildDurableRecoveryProposalV2 <- @/lib/server/forgewingRecoveryProposalPersistence',
    ]);
  });

  it('replaces every scheduler IO dependency with an evaluation sink', () => {
    const progression = code(`${PHASE17_LIB}/phase17Progression.ts`);
    for (const dependency of ['register:', 'run: async', 'persistProposal: async',
      'persistOutcome: async', 'loadPriorState: async', 'budget,']) {
      expect(progression).toContain(dependency);
    }
    // The evaluation type makes every one of them required.
    const contract = progression.slice(progression.indexOf('export type Phase17SchedulerDependencies'),
      progression.indexOf('export type Phase17RecoveryScheduler'));
    expect(contract.length).toBeGreaterThan(0);
    expect(contract).not.toMatch(/^\s{2}(?:register|run|persistProposal|persistOutcome|loadPriorState|budget)\?:/m);
  });

  it('writes only through the artifact module and the label workbook script', () => {
    const writers = phase17Sources().filter((relative) => /\bwriteFileSync\s*\(/.test(code(relative)));
    expect(writers.sort()).toEqual([
      `${PHASE17_LIB}/phase17Artifacts.ts`,
      `${PHASE17_SCRIPTS}/preparePhase17DnLabels.ts`,
    ]);
    // Neither writes into policy or qualification source.
    for (const relative of writers) {
      expect(code(relative)).not.toMatch(/recoveryOperationalPolicy|modelConfig/);
    }
  });

  it('cannot promote qualification or authorize recommendations', () => {
    for (const relative of phase17Sources()) {
      const text = code(relative);
      expect(text, relative).not.toMatch(/promotionAuthorized:\s*true/);
      expect(text, relative).not.toMatch(/RECOVERY_OPERATIONAL_POLICY\s*\[[^\]]*\]\s*=|qualification:\s*'production_qualified'/);
    }
  });

  it('confines the observed provider seam to its definition and the executor', () => {
    const users = ['app', 'components', 'lib', 'scripts'].flatMap(walk)
      .filter((relative) => !TEST.test(relative))
      .filter((relative) => read(relative).includes('createObservedRecoveryCandidateV2EvaluationProvider'));
    expect(users.sort()).toEqual([
      `${PHASE17_LIB}/phase17Execution.ts`,
      'lib/forgewing/runtime/client.ts',
    ]);
  }, 30_000);

  it('keeps corpus, cohort and label preparation provider-free', () => {
    for (const relative of [
      `${PHASE17_LIB}/dnContinuationCohort.ts`,
      `${PHASE17_LIB}/dnContinuationLabels.ts`,
      `${PHASE17_SCRIPTS}/preparePhase17DnLabels.ts`,
    ]) {
      for (const term of ['@/lib/forgewing/runtime/client', '@anthropic-ai/sdk', 'claudeClient',
        'runRecoveryCandidateV2Recommendation', 'callClaude']) {
        expect(read(relative).includes(term), `${relative} -> ${term}`).toBe(false);
      }
    }
  });

  it('never skips: a missing corpus fails the explicit command', () => {
    const cli = read(`${PHASE17_SCRIPTS}/runPhase17ContinuationEvaluation.ts`);
    expect(cli).not.toMatch(/skipIf|\.skip\(|process\.exit\(0\)/);
    expect(cli).toContain('DN_PRICED_SCHEDULE_SOURCE_PDF is required');
    expect(read(`${PHASE17_LIB}/phase17Run.ts`)).toContain("fail('corpus_missing'");
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['eval:phase17-continuation'])
      .toContain('scripts/evaluation/phase17/runPhase17ContinuationEvaluation.ts');
  });

  it('keeps live provider evaluation and provider credentials out of CI', () => {
    const workflows = path.join(ROOT, '.github/workflows');
    for (const workflow of readdirSync(workflows)) {
      const text = readFileSync(path.join(workflows, workflow), 'utf8');
      expect(text, workflow).not.toMatch(/eval:phase17|runPhase17ContinuationEvaluation|ANTHROPIC_API_KEY/);
    }
  });

  it('makes every Phase 17 execution test fail closed on a real provider or database', () => {
    const executing = walk(PHASE17_LIB).filter((relative) => TEST.test(relative))
      .filter((relative) => /executePhase17Calls|runPhase17ContinuationEvaluation/.test(read(relative)));
    expect(executing.length).toBeGreaterThan(0);
    for (const relative of executing) {
      const text = read(relative);
      expect(text, relative).toContain("vi.mock('@/lib/server/ai/claudeClient'");
      expect(text, relative).toContain("vi.mock('@/lib/server/supabaseAdmin'");
    }
  });

  it('ignores raw payloads and labeling workbooks', () => {
    expect(read('.gitignore')).toContain('scripts/evaluation/artifacts/phase17/**/local/');
  });
});

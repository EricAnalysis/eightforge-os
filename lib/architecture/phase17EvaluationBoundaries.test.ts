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
/** The single audited module that references production seams for Phase 17. */
const SEAMS = 'lib/evaluation/phase17LiveSeams.ts';
const RUN = `${PHASE17_LIB}/phase17Run.ts`;

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
const phase17Sources = () => [...walk(PHASE17_LIB), ...walk(PHASE17_SCRIPTS), SEAMS]
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

  it('references exactly two production seams, from one audited module loaded only by the run', () => {
    const importers = phase17Sources().filter((relative) =>
      /from '@\/lib\/(?:server|extraction\/persistence)\//.test(code(relative)));
    expect(importers).toEqual([SEAMS]);
    // The provider-evaluation subtree never imports serving code statically; the
    // run loads the seam module lazily, and nothing else in production reaches it.
    const seamConsumers = ['app', 'components', 'lib', 'scripts'].flatMap(walk)
      .filter((relative) => !TEST.test(relative) && relative !== SEAMS)
      .filter((relative) => read(relative).includes('phase17LiveSeams'));
    expect(seamConsumers).toEqual([RUN]);
    expect(code(RUN)).toContain("await import('@/lib/evaluation/phase17LiveSeams')");
    expect(code(SEAMS)).toMatch(/export const PHASE17_TRUSTED_PROJECT_DURABLE_PROPOSAL = buildDurableRecoveryProposalV2;/);
    expect(code(SEAMS)).toMatch(/export const PHASE17_TRUSTED_SCHEDULE_RECOVERY = scheduleRecoveryCandidateV2Shadow;/);
    expect([...code(SEAMS).matchAll(/^export /gm)]).toHaveLength(2);
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

  it('checks Forgewing prompts out as exact LF request bytes', () => {
    expect(read('.gitattributes')).toMatch(/^lib\/forgewing\/prompts\/\*\*[ \t]+text[ \t]+eol=lf[ \t]*\r?$/m);
    for (const prompt of readdirSync(path.join(ROOT, 'lib/forgewing/prompts'))) {
      expect(readFileSync(path.join(ROOT, 'lib/forgewing/prompts', prompt)).includes(0x0d), prompt)
        .toBe(false);
    }
  });

  it('derives provider provenance in one place and lets no caller declare it', () => {
    const declaring = phase17Sources().filter((relative) => /'anthropic_live'/.test(code(relative)));
    // The vocabulary, the single derivation, and the two places that gate on it.
    expect(declaring.sort()).toEqual([
      `${PHASE17_LIB}/phase17Contract.ts`,
      `${PHASE17_LIB}/phase17Execution.ts`,
      `${PHASE17_LIB}/phase17Qualification.ts`,
      RUN,
    ]);
    expect([...code(`${PHASE17_LIB}/phase17Execution.ts`).matchAll(/\? 'anthropic_live'/g)]).toHaveLength(1);
    expect(code(`${PHASE17_LIB}/phase17Qualification.ts`))
      .toMatch(/input\.providerExecution === 'anthropic_live' \? \[\] : \['provider_execution_not_anthropic_live'\]/);
    // The explicit command never injects a provider, so its runs are the real seam or nothing.
    expect(code(`${PHASE17_SCRIPTS}/runPhase17ContinuationEvaluation.ts`)).not.toMatch(/createProvider/);
  });

  describe('harness integrity (M4)', () => {
    it('classifies every run override, and CI forces a decision for any new one', () => {
      const run = code(RUN);
      const listed = (name: string) => {
        const block = run.slice(run.indexOf(`export const ${name} = [`));
        return [...block.slice(0, block.indexOf('] as const;')).matchAll(/'([A-Za-z]+)'/g)]
          .map((match) => match[1]!);
      };
      const critical = listed('PHASE17_INTEGRITY_CRITICAL_OVERRIDES');
      const neutral = listed('PHASE17_INTEGRITY_NEUTRAL_OVERRIDES');
      const operatorControls = listed('PHASE17_OPERATOR_CONTROL_KEYS');
      // A deliberate, reviewed snapshot: adding or reclassifying an override must edit this list.
      expect(critical).toEqual(['buildCohort', 'computeContractPins', 'acceptedContractPins', 'loadPrompt',
        'qualificationSourceDigest', 'projectDurableProposal', 'scheduleRecovery', 'createProvider',
        'labelBytes', 'repoRoot', 'codeState', 'runtimeConfig', 'env', 'clock']);
      expect(neutral).toEqual(['now', 'runNonce']);
      expect(operatorControls).toEqual(['mode', 'corpusBytes', 'artifactRoot', 'maxCalls',
        'maxSpendUsd', 'inputUsdPerMillionTokens', 'outputUsdPerMillionTokens']);
      // Every override the run actually reads is classified...
      const used = [...new Set([...run.matchAll(/\bdependencies\.([A-Za-z]+)/g)].map((match) => match[1]!))];
      expect(used.filter((key) => !critical.includes(key) && !neutral.includes(key))).toEqual([]);
      // ...and the type-level assertion makes an unclassified type key a compile error.
      expect(run).toContain('AssertNever<Exclude<keyof Phase17RunDependencies, ClassifiedOverride>>');
      expect(run).toContain('AssertNever<Exclude<ClassifiedOverride, keyof Phase17RunDependencies>>');
      expect(run).toContain('AssertNever<Exclude<keyof Phase17RunParams, Phase17OperatorControl>>');
      expect(run).toContain('AssertNever<Exclude<Phase17OperatorControl, keyof Phase17RunParams>>');

      // Raw caller dependencies are read exactly once, inside the synchronous snapshot.
      const snapshotStart = run.indexOf('function snapshotPhase17RunDependencies(');
      const snapshotEnd = run.indexOf('\n}', snapshotStart);
      const rawReads = [...run.matchAll(/\bdependencies\.([A-Za-z]+)/g)];
      expect(rawReads.map((match) => match[1])).toEqual([...critical, ...neutral]);
      expect(rawReads.every((match) => match.index! > snapshotStart && match.index! < snapshotEnd))
        .toBe(true);
      // Trust roots are module-owned; callers cannot provide comparison references.
      const classifier = run.slice(run.indexOf('export async function derivePhase17HarnessIntegrity('));
      expect(classifier.slice(0, classifier.indexOf('): Promise'))).not.toContain('trustedSeams');
    });

    it('reads each caller-owned object exactly once, into a frozen snapshot, before anything else', () => {
      const run = code(RUN);
      const body = run.slice(run.indexOf('export async function runPhase17ContinuationEvaluation('));
      // The raw operator object is read only by its snapshot.
      expect([...run.matchAll(/\brawParams\b/g)].length).toBe(2);
      expect(body).toMatch(/const params = snapshotPhase17RunParams\(rawParams\);\s*const injected = snapshotPhase17RunDependencies\(dependencies\);/);
      expect(body.indexOf('const params = snapshotPhase17RunParams(rawParams);'))
        .toBeLessThan(body.indexOf('await '));
      expect(run).toMatch(/function snapshotPhase17RunParams[\s\S]*?Object\.freeze\(/);
      // Every operator key must be captured: omitting or adding one fails type-checking.
      expect(run).toContain('satisfies { readonly [Key in keyof Required<Phase17RunParams>]: Phase17RunParams[Key] }');
      // The raw object is dereferenced only inside its snapshot constructor.
      const snapshotter = run.slice(run.indexOf('function snapshotPhase17RunParams('),
        run.indexOf('export async function runPhase17ContinuationEvaluation('));
      expect([...snapshotter.matchAll(/\bparams\.([A-Za-z]+)/g)].map((match) => match[1]).sort())
        .toEqual(['artifactRoot', 'corpusBytes', 'inputUsdPerMillionTokens', 'maxCalls', 'maxSpendUsd',
          'mode', 'outputUsdPerMillionTokens']);
      expect(body).not.toMatch(/\brawParams\./);
    });

    it('decides integrity before reading the corpus, labels, pins or writing anything', () => {
      const run = code(RUN);
      const gate = run.indexOf("fail('harness_integrity_not_trusted'");
      expect(gate).toBeGreaterThan(0);
      for (const later of ['injected.buildCohort ?? buildPhase17DnCohort', 'PHASE17_LABEL_ARTIFACT_PATH)',
        'computeContractPins ?? computePhase17ContractPins', 'writePhase17Freeze(', 'executePhase17Calls(']) {
        expect(run.indexOf(later), later).toBeGreaterThan(gate);
      }
      expect(run).toMatch(/providerExecution === 'anthropic_live' && harnessIntegrity !== 'default_trusted'/);
    });

    it('lets the explicit command supply operator controls only', () => {
      const cli = code(`${PHASE17_SCRIPTS}/runPhase17ContinuationEvaluation.ts`);
      const call = cli.slice(cli.indexOf('runPhase17ContinuationEvaluation({'));
      const args = call.slice(0, call.indexOf('});') + 3);
      expect(args).not.toMatch(/\},\s*\{/); // no second (overrides) argument
      for (const key of ['buildCohort', 'computeContractPins', 'acceptedContractPins', 'loadPrompt',
        'qualificationSourceDigest', 'projectDurableProposal', 'scheduleRecovery', 'createProvider',
        'labelBytes', 'repoRoot', 'codeState', 'runtimeConfig', 'env']) {
        expect(args).not.toContain(`${key}:`);
      }
      expect(cli).not.toMatch(/--labels|--repo-root|--prompt|--cohort/);
      const flagBlock = (name: string) => {
        const block = cli.slice(cli.indexOf(`const ${name} = new Set([`));
        return [...block.slice(0, block.indexOf(']);')).matchAll(/'(--[a-z-]+)'/g)]
          .map((match) => match[1]!);
      };
      expect(flagBlock('VALUE_FLAGS')).toEqual(['--max-calls', '--max-spend-usd',
        '--input-usd-per-mtok', '--output-usd-per-mtok', '--artifact-root']);
      expect(flagBlock('BOOLEAN_FLAGS')).toEqual(['--execute-provider']);
    });

    it('requires default_trusted as well as anthropic_live to recommend', () => {
      expect(code(`${PHASE17_LIB}/phase17Qualification.ts`))
        .toMatch(/input\.harnessIntegrity === 'default_trusted' \? \[\] : \['harness_integrity_not_default_trusted'\]/);
    });
  });

  it('writes raw evidence before the summary', () => {
    const run = code(`${PHASE17_LIB}/phase17Run.ts`);
    const raw = run.indexOf('writePhase17LocalRaw(');
    const summary = run.indexOf('writePhase17Summary(params.artifactRoot');
    expect(raw).toBeGreaterThan(0);
    expect(summary).toBeGreaterThan(raw);
    expect(run.slice(run.lastIndexOf('try {', raw), raw)).toContain('} finally {');
  });

  it('ignores raw payloads and labeling workbooks', () => {
    expect(read('.gitignore')).toContain('scripts/evaluation/artifacts/phase17/**/local/');
  });
});

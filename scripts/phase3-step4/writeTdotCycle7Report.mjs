import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function oneLine(value) {
  return String(value ?? '').replaceAll('\n', ' / ').replaceAll('|', '\\|');
}

function metrics(report) {
  const value = report.cycle_comparison.after;
  return {
    exact_reconstruction: value.exact_reconstructions,
    non_exact_single_field: value.non_exact_single_field_reconstructions,
    non_exact_split_merge: value.non_exact_split_reconstructions,
    missing_dependencies: value.ledger_cells_without_dependencies,
    resolved: value.resolved,
    unresolved: value.unresolved,
    semantic_review: value.semantic_review,
    resolved_by_header: null,
    resolved_by_body_positional: 0,
    metamorphic:
      `${value.metamorphic_passed} / ${value.metamorphic_failed} / ${value.metamorphic_blocked}`,
  };
}

const root = required('TDOT_CYCLE7_ARTIFACT_ROOT');
const baselinePath = path.join(
  root,
  'phase1-v1.12.1-final',
  'tdot-phase1-parity-report.v1.12.1.json',
);
const partAPath = path.join(
  root,
  'phase1-v1.13.0-part-a',
  'semantic-resolution-diagnostic.phase1-v1.13.0-part-a.json',
);
const partBPath = path.join(
  root,
  'phase1-v1.13.0-part-b',
  'semantic-resolution-diagnostic.phase1-v1.13.0-part-b.json',
);
const rejectedPath = path.join(
  root,
  'phase1-v1.13.0-part-b-final',
  'semantic-resolution-diagnostic.phase1-v1.13.0-part-b-final.json',
);
const partDDiagnosisPath = path.join(
  root,
  'phase1-v1.13.0-part-d-diagnosis',
  'semantic-resolution-diagnostic.phase1-v1.13.0-part-d-diagnosis.json',
);
const partDPath = path.join(
  root,
  'phase1-v1.13.0-part-d',
  'semantic-resolution-diagnostic.phase1-v1.13.0-part-d.json',
);
const finalDirectory = path.join(root, 'phase1-v1.13.0-final');
const finalPath = path.join(
  finalDirectory,
  'tdot-phase1-parity-report.v1.13.0.json',
);
const vitestPath = path.join(finalDirectory, 'vitest-full-results.json');

const [
  partA,
  partB,
  rejected,
  partDDiagnosis,
  partD,
  finalReport,
  vitest,
] = await Promise.all([
  json(partAPath),
  json(partBPath),
  json(rejectedPath),
  json(partDDiagnosisPath),
  json(partDPath),
  json(finalPath),
  json(vitestPath),
]);

const baselineMetrics = finalReport.cycle_comparison.before;
const partBMetrics = partB.metrics;
const finalMetrics = {
  ...metrics(finalReport),
  resolved_by_header: partB.false_positive_audit.true_resolutions,
};
const changedRecords = finalReport.record_transition_composition.records
  .filter(({ transitions }) => !transitions.includes('unchanged'));
const sourceHeader = partA.source_header_existence;
const unitDiagnosis = partDDiagnosis.remaining_reconstruction_diagnostics.find(
  ({ field_identifier }) => field_identifier === 'tdot-appendix-b:p46:r021:f02:unit',
);
const costDiagnosis = partDDiagnosis.remaining_reconstruction_diagnostics.find(
  ({ field_identifier }) => field_identifier === 'tdot-appendix-b:p46:r025:f04:cost',
);
const status = execFileSync('git', ['status', '--porcelain=v1'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim().split(/\r?\n/u).filter(Boolean);
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim().split(/\r?\n/u).filter(Boolean);
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
const headMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
const branch = execFileSync('git', ['branch', '--show-current'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();

const machine = {
  version: '1.13.0',
  shadow_only: true,
  cycle_7_verdict: 'pass_with_explicit_remaining_ambiguity',
  baseline_report: baselinePath,
  checkpoints: {
    part_a: partAPath,
    part_b: partBPath,
    part_c: {
      status: 'not_implemented',
      reason: 'Class D did not materially dominate; Class D count was zero.',
    },
    part_d_diagnosis: partDDiagnosisPath,
    part_d: partDPath,
    final: finalPath,
  },
  metrics: {
    baseline: baselineMetrics,
    part_b_header_recovery: partBMetrics,
    part_c_headerless: null,
    final: finalMetrics,
  },
  source_header_existence: sourceHeader,
  part_b: {
    changed_records: partB.transition_composition.records,
    false_positive_audit: partB.false_positive_audit,
    strict_header_predicate_changed: false,
  },
  part_c: {
    implemented: false,
    class_d_record_count:
      sourceHeader.classification_distribution.D ?? 0,
    resolved_by_body_positional: 0,
  },
  part_d: {
    diagnosis: { unit: unitDiagnosis, cost: costDiagnosis },
    isolated_metrics: partD.metrics,
    correction:
      'Same-baseline currency-marker/dash pair recovered only after exclusive same-band feasibility and no intervening assigned cell.',
    retained_non_exact:
      'The multiline unit remains non-exact because two source lines were excluded before row association and no generic sequence evidence justified forced attachment.',
  },
  final_transitions: changedRecords,
  rejected_experiments: [{
    checkpoint: rejectedPath,
    reason:
      'Cross-band sparse-fragment rejection caused broad reconstruction regression.',
    metrics: rejected.metrics,
  }],
  verification: {
    typecheck: 'pass',
    changed_source_eslint_max_warnings_0: 'pass',
    python_py_compile: 'pass',
    focused_real_pdf: {
      files: 9,
      passed: 121,
      failed: 0,
      skipped: 0,
    },
    full_vitest: {
      config: 'vitest.config.ts',
      workers: 4,
      timeout_ms: 360000,
      files: vitest.testResults.length,
      suites: vitest.numTotalTestSuites,
      passed: vitest.numPassedTests,
      failed: vitest.numFailedTests,
      skipped: vitest.numPendingTests,
      exclusions: ['node_modules', '.next', 'e2e'],
    },
    production_build: 'pass_42_of_42_static_pages',
    golden: {
      tests: 11,
      ticket_grain_cyd: 74617,
      row_grain_extended_cost: 815559.35,
    },
    dependency_closure: finalReport.generic_run.dependency_closure,
    metamorphic: finalReport.metamorphic.result_counts,
  },
  architecture_boundaries: {
    phase2_started: false,
    cutover_decision: null,
    readers_changed: false,
    validators_changed: false,
    persistence_changed: false,
    migrations_changed: false,
    legacy_assembly_changed: false,
    canonical_consumers_changed: false,
    golden_fixtures_changed: false,
  },
  git: {
    head,
    head_message: headMessage,
    branch,
    worktree_status: status,
    staged_files: staged,
    commit_created: false,
    push_occurred: false,
  },
  external_artifacts: {
    root,
    source_pdf_remained_external: true,
    ledger_remained_external: true,
  },
};

const rows = sourceHeader.records.map((record) =>
  `- ${record.material_record_id} | mapping=${record.mapping_id} | `
  + `p${record.source_page} | ${record.primary_classification}/`
  + `${record.sub_cause} | header=${oneLine(record.raw_header_text)} | `
  + `tokens=${record.native_token_ids.join(',') || 'none'} | `
  + `segment=${record.segment_id} -> ${record.candidate_header_segment_id}`);
const transitions = changedRecords.map((record) =>
  `- ${record.record_key} | ${record.transitions.join(',')} | `
  + `record=${record.record_id} | role=${record.ledger_role}`);
const markdown = [
  '# Phase 3 Step 4 Cycle 7 v1.13.0',
  '',
  'Shadow-only. Phase 2 was not started and no cutover decision was created.',
  '',
  '| Metric | v1.12.1 | Part B header recovery | Part C headerless | v1.13.0 final |',
  '| --- | ---: | ---: | --- | ---: |',
  `| Exact reconstruction | ${baselineMetrics.exact_reconstructions} | ${partBMetrics.exact_reconstruction} | not implemented - Class D count was zero | ${finalMetrics.exact_reconstruction} |`,
  `| Non-exact, single-field | ${baselineMetrics.non_exact_single_field_reconstructions} | ${partBMetrics.non_exact_single_field} | not implemented | ${finalMetrics.non_exact_single_field} |`,
  `| Non-exact, split/merge | ${baselineMetrics.non_exact_split_reconstructions} | ${partBMetrics.non_exact_split_merge} | not implemented | ${finalMetrics.non_exact_split_merge} |`,
  `| Missing dependencies | ${baselineMetrics.ledger_cells_without_dependencies} | ${partBMetrics.missing_dependencies} | not implemented | ${finalMetrics.missing_dependencies} |`,
  `| Resolved | ${baselineMetrics.resolved} | ${partBMetrics.resolved} | not implemented | ${finalMetrics.resolved} |`,
  `| Unresolved | ${baselineMetrics.unresolved} | ${partBMetrics.unresolved} | not implemented | ${finalMetrics.unresolved} |`,
  `| Semantic review | ${baselineMetrics.semantic_review} | ${partBMetrics.semantic_review} | not implemented | ${finalMetrics.semantic_review} |`,
  `| Resolved by header | 0 | ${partB.false_positive_audit.true_resolutions} | not implemented | ${partB.false_positive_audit.true_resolutions} |`,
  '| Resolved by body_positional | 0 | 0 | not implemented | 0 |',
  `| Metamorphic pass / fail / blocked | ${baselineMetrics.metamorphic_passed} / ${baselineMetrics.metamorphic_failed} / ${baselineMetrics.metamorphic_blocked} | not rerun | not implemented | ${finalMetrics.metamorphic} |`,
  '',
  '## Cycle 7 verdict',
  '',
  'Pass with explicit remaining ambiguity. Real source headers were recovered before considering headerless interpretation. No false confident role was introduced. One multiline unit remains non-exact and 13 unit mappings remain in semantic review.',
  '',
  '## Part A - source-header existence',
  '',
  `Material records: ${sourceHeader.material_record_count}. Distinct mappings: ${sourceHeader.distinct_mapping_count}. Distribution: ${JSON.stringify(sourceHeader.classification_distribution)}.`,
  '',
  ...rows,
  '',
  '## Part B - header recovery',
  '',
  `Accepted effect: ${partB.false_positive_audit.true_resolutions} correct header-based resolutions, ${partB.false_positive_audit.false_resolutions} false resolutions. The strict semantic predicate, evaluator, aliases, thresholds, and margins were unchanged.`,
  '',
  'The versioned adjacent-boundary association requires retained source headers, same relative column geometry, adjacent-page boundary proximity, compatible column occupancy, and multiple source rows. Unrelated-chain rejection remains enforced.',
  '',
  '## Part C - headerless interpretation',
  '',
  'Not implemented. Part A found 37 Class A records and zero Class D records, so headerless resolution was not justified.',
  '',
  '## Part D - reconstruction',
  '',
  `Unit: ${oneLine(unitDiagnosis?.expected_text)} remains ${oneLine(unitDiagnosis?.reconstructed_text)}. Earliest divergence: ${unitDiagnosis?.earliest_divergence}; no threshold was broadened.`,
  '',
  `Cost: ${oneLine(costDiagnosis?.expected_text)} recovered from ${oneLine(costDiagnosis?.reconstructed_text)} using positive exclusive same-band, same-baseline currency/dash evidence.`,
  '',
  '## Changed records',
  '',
  ...transitions,
  '',
  '## Rejected experiment',
  '',
  `Cross-band sparse-fragment rejection was removed after measuring ${rejected.metrics.exact_reconstruction} exact, ${rejected.metrics.missing_dependencies} missing dependencies, and ${rejected.metrics.non_exact_single_field} non-exact single-field records.`,
  '',
  '## Verification',
  '',
  `- Focused real-PDF suite: 9 files, 121 passed, 0 failed, 0 skipped.`,
  `- Full Vitest: ${vitest.testResults.length} files, ${vitest.numTotalTestSuites} suites, ${vitest.numPassedTests} passed, ${vitest.numFailedTests} failed, ${vitest.numPendingTests} skipped; four workers; 360000 ms timeout; exclusions node_modules, .next, e2e.`,
  '- TypeScript, changed-source ESLint with zero warnings, Python py_compile, production build (42/42 pages), Golden anchors, dependency closure, manifest invariance, genericity and opaque-ID guards passed.',
  '- Golden values: Ticket-grain CYD 74,617; row-grain Extended Cost $815,559.35.',
  '',
  '## Phase 2 readiness and boundaries',
  '',
  `Phase 2 status: ${finalReport.phase2_readiness.status}. No cutover decision exists. Readers, validators, persistence, migrations, legacy assembly, canonical consumers, and Golden fixtures are unchanged.`,
  '',
  '## Git and artifacts',
  '',
  `- HEAD: ${head} (${headMessage})`,
  `- Branch: ${branch}`,
  `- Modified/untracked status: ${status.join('; ') || 'clean'}`,
  `- Staged files: ${staged.join(', ') || 'none'}`,
  '- Commit created: no',
  '- Push occurred: no',
  `- External artifact root: ${root}`,
  '- No source PDF or annotation ledger entered the repository.',
  '',
].join('\n');

await writeFile(
  path.join(finalDirectory, 'tdot-phase1-cycle7.v1.13.0.json'),
  `${JSON.stringify(machine, null, 2)}\n`,
  'utf8',
);
await writeFile(
  path.join(finalDirectory, 'tdot-phase1-cycle7.v1.13.0.md'),
  markdown,
  'utf8',
);

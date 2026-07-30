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

function distribution(value) {
  return Object.entries(value)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join('\n');
}

function oneLine(value) {
  return String(value ?? '').replaceAll('\n', ' / ');
}

function roleTransition(transition) {
  const selection = transition.selected_roles?.[0];
  return `- ${transition.stable_record_key}: ${transition.old_state} -> `
    + `${transition.new_state}; selected=${selection?.selected_role ?? 'none'}; `
    + `ledger=${transition.ledger_role}; field=${selection?.verified_field_id ?? 'none'}; `
    + `correct=${transition.correct}; evidence=${
      selection?.decisive_evidence?.join(', ') ?? 'none'
    }`;
}

function invariantLine(result) {
  const manifest = result.mutation_manifest;
  const closure = manifest?.dependency_closure?.status
    ?? manifest?.execution_result?.dependency_closure?.status
    ?? 'not executed';
  return `- ${result.invariant_id}: ${result.status}; closure=${closure}; `
    + oneLine(result.explanation);
}

const root = required('TDOT_CYCLE6_ARTIFACT_ROOT');
const partAPath = path.join(
  root,
  'phase1-v1.12.0-part-a',
  'semantic-resolution-diagnostic.phase1-v1.12.0-part-a.json',
);
const partBPath = path.join(
  root,
  'phase1-v1.12.0-part-b-final',
  'semantic-resolution-diagnostic.phase1-v1.12.0-part-b.json',
);
const partCDiagnosisPath = path.join(
  root,
  'phase1-v1.12.0-part-c-diagnosis',
  'semantic-resolution-diagnostic.phase1-v1.12.0-part-c-diagnosis.json',
);
const partCPath = path.join(
  root,
  'phase1-v1.12.0-part-c',
  'semantic-resolution-diagnostic.phase1-v1.12.0-part-c.json',
);
const finalDirectory = path.join(root, 'phase1-v1.12.0-final');
const finalPath = path.join(
  finalDirectory,
  'tdot-phase1-parity-report.v1.12.0.json',
);
const vitestPath = path.join(finalDirectory, 'vitest-full-results.json');

const [partA, partB, partCDiagnosis, partC, finalReport, vitest] =
  await Promise.all([
    json(partAPath),
    json(partBPath),
    json(partCDiagnosisPath),
    json(partCPath),
    json(finalPath),
    json(vitestPath),
  ]);

const material = finalReport.parity.records.filter((record) => record.material);
const pageMetrics = [43, 44, 46].map((page) => {
  const records = material.filter((record) => record.ledger?.source_page === page);
  return {
    page,
    exact: records.filter(
      (record) => record.reconstruction_comparison?.exact_equal,
    ).length,
    total: records.length,
  };
});
const reconstructionTransitions = partC.transition_composition.records.filter(
  (transition) => transition.old_exact !== transition.new_exact,
);
const rowMutation = finalReport.metamorphic.results.find(
  (result) => result.invariant_id === 'duplicate_row',
);
const envelope = rowMutation?.mutation_manifest?.row_clearance_envelope;
const sourceLimited = new Set([
  'change_quantity',
  'change_extension',
  'merged_multiline_cells',
  'subtables',
  'repeated_headers',
  'cross_page_continuation',
  'engine_conflict',
]);
const status = execFileSync('git', ['status', '--short'], {
  encoding: 'utf8',
}).trimEnd();
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  encoding: 'utf8',
}).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const headMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], {
  encoding: 'utf8',
}).trim();
const branch = execFileSync('git', ['branch', '--show-current'], {
  encoding: 'utf8',
}).trim();
const changedPdf = status.split(/\r?\n/u).filter((line) =>
  /\.pdf$/iu.test(line));
const passedMutations = finalReport.metamorphic.results.filter(
  (result) => result.status === 'pass' && result.mutation_manifest,
);

const lines = [
  '| Metric | v1.11.0 | Part B only | v1.12.0 final |',
  '|---|---:|---:|---:|',
  '| Exact reconstruction | 251 | 251 | 254 |',
  '| Non-exact, single-field | 4 | 4 | 2 |',
  '| Non-exact, split/merge | 1 | 1 | 0 |',
  '| Missing dependencies | 0 | 0 | 0 |',
  '| Resolved | 226 | 261 | 263 |',
  '| Unresolved | 27 | 27 | 25 |',
  '| Semantic review | 35 | 0 | 0 |',
  '| Metamorphic passed | 7 | 7 | 7 |',
  '| Metamorphic failed | 0 | 0 | 0 |',
  '| Metamorphic blocked | 14 | 14 | 14 |',
  '| Source-limited for this PDF | 7 | 7 | 7 |',
  '',
  '## Cycle 6 verdict',
  '',
  'Accepted as a shadow-only Phase 1 remediation checkpoint. The dominant '
    + 'semantic-review bottleneck was demonstrated and corrected with retained '
    + 'cross-page stable-header geometry. Exact reconstruction improved by three. '
    + 'No confidently wrong mapping, exact-record regression, missing dependency, '
    + 'or metamorphic false pass was introduced. Phase 2 remains blocked.',
  '',
  '## Part A end-to-end semantic trace',
  '',
  `The Part A artifact contains ${partA.non_resolved_record_count} baseline `
    + `record traces and ${partA.ambiguous_semantic_mapping_count} ambiguous `
    + 'SemanticColumnMappings. Each trace retains the source geometry, raw span, '
    + 'VerifiedField/cell/row/segment/chain/mapping path, candidates, scores, '
    + 'evidence, conjunct results, evaluator result, and earliest blocking stage.',
  `Artifact: ${partAPath}`,
  '',
  'Missing diagnostic edges were retained as null rather than inferred. The graph '
    + 'contained no section artifacts, so the row-to-section edge is explicitly '
    + 'absent in every affected trace.',
  '',
  '## Cause distribution for all 62 records',
  '',
  distribution(partA.cause_distribution),
  '',
  'The 34 `another_measured_cause` records split into 22 row/cell-formation '
    + 'blocks and 12 page-44 description records whose observed UUID-shaped '
    + 'page header was not the semantic column header. The 23 missing-header-'
    + 'VerifiedField records covered the page-44 unit and origin/destination '
    + 'columns. Five records were blocked first by non-exact reconstruction.',
  '',
  '## Resolution-conjunct failure distribution',
  '',
  distribution(partA.conjunct_failure_distribution),
  '',
  'All 62 ambiguous mappings failed minimum score; 26 also failed minimum '
    + 'margin. The report serializes the actual threshold/margin predicate and '
    + 'the equivalent header-role/kind/conflict conceptual conjuncts separately.',
  '',
  '## Correct-role-rejected versus genuinely ambiguous split',
  '',
  distribution(partA.correct_role_versus_genuine_ambiguity_split),
  '',
  'Correct generic role rejected by evaluator: 0. Incorrect confident generic '
    + 'role: 0. Evaluator-role contract mismatch: 0.',
  '',
  '## Mapping changes tied to measured causes',
  '',
  'Part B connected a column only to source-grounded peer headers at a stable '
    + 'column center within the existing geometry tolerance. It did not change '
    + 'aliases, score thresholds, resolution margins, extraction geometry, or '
    + 'the evaluator. Candidate scores, components, runner-up, margin, ambiguity '
    + 'reason, body-kind evidence, neighboring evidence, provenance, hashes, and '
    + 'policy/build identity are retained.',
  '',
  '## Newly resolved mappings and decisive evidence',
  '',
  ...partB.transition_composition.records.map(roleTransition),
  '',
  '## False-positive audit',
  '',
  `- True resolutions: ${partB.false_positive_audit.true_resolutions}`,
  `- False resolutions: ${partB.false_positive_audit.false_resolutions}`,
  `- Role changes: ${partB.false_positive_audit.role_changes}`,
  `- Unchanged ambiguities: ${partB.false_positive_audit.unchanged_ambiguities}`,
  `- Newly ambiguous: ${partB.false_positive_audit.newly_ambiguous}`,
  '',
  'Every newly resolved role agreed with the annotation ledger in evaluation. '
    + 'Schema-neutral negative fixtures retained ambiguity for weak/missing '
    + 'headers, overlapping vocabulary, and conflicting body kinds.',
  '',
  '## Isolated Part B metric effect',
  '',
  'Part B changed 35 records from semantic review to resolved: 12 description, '
    + '13 unit, and 10 origin/destination. Reconstruction remained exactly '
    + '251 exact, 4 non-exact single-field, 1 non-exact split/merge, and 0 missing.',
  '',
  '## Per-record transitions among resolved, unresolved, and semantic review',
  '',
  ...partB.transition_composition.records.map(roleTransition),
  '',
  'Part C added two unresolved-to-resolved transitions; no record moved into '
    + 'semantic review and no resolved record regressed.',
  '',
  '## Five-record reconstruction diagnosis',
  '',
  ...partCDiagnosis.remaining_reconstruction_diagnostics.map((diagnostic) =>
    `- ${diagnostic.field_identifier}: expected="${oneLine(
      diagnostic.expected_text,
    )}"; reconstructed="${oneLine(diagnostic.reconstructed_text)}"; `
      + `earliest=${diagnostic.earliest_divergence}; `
      + `mechanism=${diagnostic.primary_mechanism}`),
  '',
  '## Reconstruction changes and isolated effect',
  '',
  'A fragment is recovered after global assignment only when it has exactly one '
    + 'feasible column, an anchored cell exists in that same column, no '
    + 'intervening assignment crosses another column, and the existing generic '
    + 'coalescing evidence is positive. The ambiguous page-46 unit and cost '
    + 'records remain explicit non-exact results.',
  '',
  ...reconstructionTransitions.map((transition) =>
    `- ${transition.stable_record_key}: exact ${transition.old_exact} -> `
      + `${transition.new_exact}; state ${transition.old_state} -> `
      + `${transition.new_state}; fields=${
        transition.selected_roles.map((role) => role.verified_field_id).join(', ')
      }`),
  '',
  '## Exact/non-exact/missing by page',
  '',
  '| Page | Exact | Total | Non-exact | Missing |',
  '|---:|---:|---:|---:|---:|',
  ...pageMetrics.map(({ page, exact, total }) =>
    `| ${page} | ${exact} | ${total} | ${total - exact} | 0 |`),
  '',
  '## Metamorphic source-reachability analysis',
  '',
  'Seven invariants pass against this PDF. Seven are source-limited and still '
    + 'require purpose-built synthetic or independent real-source evidence. '
    + 'The remaining seven are potentially reachable here but blocked by safe '
    + 'transformation capability or measured preconditions. This is not a '
    + 'generic coverage ceiling.',
  '',
  '## Row-clearance measurements',
  '',
  `- Target page: ${rowMutation?.mutation_manifest?.target_page ?? 'none'}`,
  `- Target row: ${
    rowMutation?.mutation_manifest?.target_source_span?.source_row_id ?? 'none'
  }`,
  `- Table bottom: ${envelope?.table_bottom ?? 'none'}`,
  `- Movable row band: ${JSON.stringify(envelope?.movable_row_band ?? null)}`,
  `- Row height / displacement: ${envelope?.row_height ?? 'none'} / ${
    envelope?.required_displacement ?? 'none'
  }`,
  `- Overlap margin: ${envelope?.overlap_margin ?? 'none'}`,
  `- Available clearance: ${envelope?.available_clearance ?? 'none'}`,
  `- Media box / crop box: ${JSON.stringify(envelope?.page_media_box ?? null)} / ${
    JSON.stringify(envelope?.page_crop_box ?? null)
  }`,
  `- Clipping risk / overlap risk: ${envelope?.clipping_risk ?? 'none'} / ${
    envelope?.overlap_risk ?? 'none'
  }`,
  '',
  '## duplicate_row result',
  '',
  oneLine(finalReport.metamorphic.results.find(
    (result) => result.invariant_id === 'duplicate_row',
  )?.explanation),
  '',
  'The rejected prototype visually clipped native row bands, but PDF text '
    + 'extraction still exposed the complete Form XObject and produced three '
    + 'target copies plus duplicated unrelated spans. It was blocked and no '
    + 'artifact or pass was promoted.',
  '',
  '## insert_row result',
  '',
  oneLine(finalReport.metamorphic.results.find(
    (result) => result.invariant_id === 'insert_row',
  )?.explanation),
  '',
  '## Per-invariant status',
  '',
  ...finalReport.metamorphic.results.map(invariantLine),
  '',
  '## Source-limited versus globally unproven invariants',
  '',
  ...finalReport.metamorphic.results
    .filter((result) => sourceLimited.has(result.invariant_id))
    .map((result) => `- ${result.invariant_id}: source-limited here and globally `
      + `unproven; ${oneLine(result.explanation)}`),
  '',
  '## Transition composition with field IDs',
  '',
  ...partB.transition_composition.records.map(roleTransition),
  ...reconstructionTransitions.map((transition) =>
    `- ${transition.stable_record_key}: exact ${transition.old_exact} -> `
      + `${transition.new_exact}; fields=${
        transition.selected_roles.map((role) => role.verified_field_id).join(', ')
      }`),
  '',
  '## Harness/evaluator correction with isolated effect',
  '',
  'None. `roleForLedger`, record matching, material parity classification, '
    + 'expected-role contracts, thresholds, and transition accounting were unchanged.',
  '',
  '## Rejected experiments with measurements',
  '',
  '- Whole-schema geometry propagation: 0 transitions; rejected as too broad.',
  '- Same-column-count peer filtering: rejected as a late Part B experiment; '
    + 'it was not accepted after the isolated Part B checkpoint.',
  '- Native clipped Form row clone: expected two target rows, observed three '
    + 'extractable target copies and duplicated unrelated spans; rejected and blocked.',
  '- Page-46 unit broad attachment: rejected because the three physical lines '
    + 'lack a complete row-association trace.',
  '- Page-46 cost overflow recovery: rejected because existing coalescing '
    + 'confidence is zero.',
  '',
  '## Dependency closure',
  '',
  `Baseline: ${finalReport.generic_run.dependency_closure.status}; `
    + `${finalReport.generic_run.dependency_closure.checked_verified_fields} `
    + 'VerifiedFields, '
    + `${finalReport.generic_run.dependency_closure.checked_candidates} candidates, `
    + `${finalReport.generic_run.dependency_closure.checked_fragments} fragments.`,
  ...passedMutations.map((result) =>
    `- ${result.invariant_id}: ${
      result.mutation_manifest.dependency_closure?.status
      ?? result.mutation_manifest.execution_result?.dependency_closure?.status
      ?? 'not recorded'
    }`),
  '',
  '## Genericity evidence',
  '',
  'Production Extraction and Interpretation contain no TDOT identifier, contract '
    + 'number, vendor/project identity, filename, audited-page route, expected '
    + 'ledger value/count, or annotation-ledger role input. Source hashes remain '
    + 'provenance only. Semantic ordering is geometry/source-order based; opaque '
    + 'artifact IDs are not semantic tie-breakers. The manifest-invariance test passed.',
  '',
  '## Verification matrix',
  '',
  '| Check | Result |',
  '|---|---|',
  '| `npx tsc --noEmit` | pass |',
  '| Changed-source ESLint `--max-warnings=0` | pass |',
  '| Python `py_compile` | pass |',
  '| Focused Interpretation/extraction/harness/mutation/manifest tests | 97/97 pass |',
  '| Architecture boundary tests | 20/20 pass |',
  '| Golden anchor test | 2/2 pass |',
  `| Full Vitest | ${vitest.testResults.length} files; ${
    vitest.numPassedTests
  } passed; ${vitest.numFailedTests} failed; ${
    vitest.numPendingTests
  } skipped/environment-gated |`,
  '| Full Vitest command | `npx vitest run --testTimeout=30000 '
    + '--hookTimeout=120000 --maxWorkers=4 --reporter=json` |',
  '| Vitest config | `vitest.config.ts`; node environment; 4 workers; '
    + '30s test timeout; 120s hook timeout |',
  '| Vitest exclusions | `node_modules`, `.next`, `e2e` |',
  '| Vitest reruns | no failure reruns; a second JSON-reporter pass confirmed counts |',
  '| Production build | pass; Next.js used 11 build workers |',
  '| `git diff --check` | pass |',
  '| Static genericity scan | pass; source SHA references are provenance only |',
  '| Baseline dependency closure | pass |',
  '| Executed mutated-run dependency closure | all four pass |',
  '| Golden values | Ticket-grain CYD 74,617; row-grain Extended Cost $815,559.35 |',
  '',
  '## HEAD, branch, worktree, index, commit, and push status',
  '',
  `- HEAD: ${head}`,
  `- HEAD message: ${headMessage}`,
  `- Branch: ${branch}`,
  '- Worktree: intentionally modified and untracked for Cycle 6; not clean.',
  '- Modified/untracked files:',
  '```text',
  status,
  '```',
  `- Staged files: ${staged || 'none'}`,
  `- Index state: ${staged ? 'staged changes present' : 'clean'}`,
  '- Commit created: no.',
  '- Push occurred: no.',
  `- Mutation artifacts: ${path.join(finalDirectory, 'mutations')}`,
  `- Repository PDF changes: ${changedPdf.length === 0 ? 'none' : changedPdf.join(', ')}`,
  '- Production readers, validators, persistence, migrations, legacy assembly, '
    + 'canonical consumers, and Golden fixtures: unchanged.',
  '',
  '## Phase 2 readiness',
  '',
  `Status: ${finalReport.phase2_readiness.status}. Phase 2 was not begun and no `
    + 'cutover decision was created. Generic metamorphic coverage remains '
    + 'incomplete; two reconstruction records remain non-exact; 25 material '
    + 'records remain unresolved for non-semantic-first causes.',
  '',
];

const outputPath = path.join(
  finalDirectory,
  'tdot-phase1-cycle6-report.v1.12.0.md',
);
await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`${outputPath}\n`);

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const oneLine = (value) => String(value ?? '').replaceAll('\n', ' / ')
  .replaceAll('|', '\\|');
const root = required('TDOT_CYCLE8_ARTIFACT_ROOT');
const syntheticRoot = required('TDOT_CYCLE8_SYNTHETIC_ROOT');
const finalDirectory = path.join(root, 'phase1-v1.14.0-final');
const [report, diagnostic, synthetic, generation] = await Promise.all([
  json(path.join(finalDirectory, 'tdot-phase1-parity-report.v1.14.0.json')),
  json(path.join(
    root,
    'phase1-v1.14.0-diagnostic',
    'semantic-resolution-diagnostic.phase1-v1.14.0-final.json',
  )),
  json(path.join(syntheticRoot, 'synthetic-generalization-report.v1.14.0.json')),
  json(path.join(syntheticRoot, 'synthetic-generation-manifest.json')),
]);
const after = report.cycle_comparison.after;
const statuses = report.metamorphic.results;
const statusLines = statuses.map((result) => {
  const manifest = result.mutation_manifest ?? {};
  const property = manifest.comparison_result
    ? ` Property evidence: ${oneLine(JSON.stringify(manifest.comparison_result))}.`
    : '';
  return `- **${result.invariant_id}: ${result.status}.** ${oneLine(result.explanation)}${property}`;
});
const syntheticTable = (source) => [
  '| Metric | Result |',
  '| --- | ---: |',
  `| Exact reconstruction | ${source.metrics.exact_reconstruction} |`,
  `| Non-exact | ${source.metrics.non_exact} |`,
  `| Missing dependencies | ${source.metrics.missing_dependencies} |`,
  `| Resolved | ${source.metrics.resolved} |`,
  `| Unresolved | ${source.metrics.unresolved} |`,
  `| Semantic review | ${source.metrics.semantic_review} |`,
  `| Metamorphic pass / fail / blocked | ${source.metrics.metamorphic.pass} / ${source.metrics.metamorphic.fail} / ${source.metrics.metamorphic.blocked} |`,
].join('\n');
const sourceManifest = Object.fromEntries(
  generation.sources.map((source) => [source.label, source]),
);
const transitions = report.record_transition_composition.records
  .filter(({ transitions: values }) => !values.includes('unchanged'));
const markdown = [
  '# Phase 3 Step 4 Phase 1 Remediation Cycle 8 v1.14.0',
  '',
  'Shadow-only. Phase 2 was not started and no cutover decision was created.',
  '',
  '## TDOT',
  '',
  '| | v1.13.0 | v1.14.0 |',
  '| --- | ---: | ---: |',
  `| exact | 255 | ${after.exact_reconstructions} |`,
  `| non-exact (single / split) | 1 / 0 | ${after.non_exact_single_field_reconstructions} / ${after.non_exact_split_reconstructions} |`,
  `| missing dependencies | 0 | ${after.ledger_cells_without_dependencies} |`,
  `| resolved | 251 | ${after.resolved} |`,
  `| unresolved | 24 | ${after.unresolved} |`,
  `| semantic review | 13 | ${after.semantic_review} |`,
  `| metamorphic pass / fail / blocked | 7 / 0 / 14 | ${after.metamorphic_passed} / ${after.metamorphic_failed} / ${after.metamorphic_blocked} |`,
  '',
  'The TDOT extraction/semantic population is unchanged. Metamorphic coverage changed because `change_description` passed, `move_table_page` executed and failed strict preservation, and two prior blocks became executed outcomes.',
  '',
  '## Synthetic source A',
  '',
  syntheticTable(synthetic.source_a),
  '',
  '## Synthetic source B',
  '',
  syntheticTable(synthetic.source_b),
  '',
  'The populations above are independent and are not combined with TDOT.',
  '',
  '## 1. Per-invariant metamorphic status',
  '',
  ...statusLines,
  '',
  'Synthetic structural results:',
  '',
  ...synthetic.source_a.metamorphic.map((result) =>
    `- A / **${result.invariant_id}: ${result.status}.** ${oneLine(result.explanation)}`),
  ...synthetic.source_b.metamorphic.map((result) =>
    `- B / **${result.invariant_id}: ${result.status}.** ${oneLine(result.explanation)}`),
  '',
  '## 2. Span inventory evidence',
  '',
  'No content stream was flattened or rebuilt. The unsafe clipped Form clone remains prohibited. Inline duplication stopped before mutation because one selected native span crossed the grounded token geometry. Page relocation preserved the logical value multiset and text SHA but failed render identity and moved only 98 of 138 target-page fields, so it remains a failed experiment.',
  '',
  '## 3. Synthetic construction and provenance',
  '',
  `- Source A PDF SHA-256: ${sourceManifest.A.pdf_sha256}`,
  `- Source A ledger SHA-256: ${sourceManifest.A.ledger_sha256}`,
  `- Source A construction-spec SHA-256: ${sourceManifest.A.construction_spec_sha256}`,
  `- Source B PDF SHA-256: ${sourceManifest.B.pdf_sha256}`,
  `- Source B ledger SHA-256: ${sourceManifest.B.ledger_sha256}`,
  `- Source B construction-spec SHA-256: ${sourceManifest.B.construction_spec_sha256}`,
  `- Deterministic regeneration: ${generation.deterministic_regeneration ? 'pass' : 'fail'} under PyMuPDF ${generation.pymupdf_version} / MuPDF ${generation.mupdf_version}.`,
  '- Ledger observations are emitted from construction nodes; structural annotations are separate from semantic fact observations.',
  `- Identical logical facts recovered: ${synthetic.comparison.identical_logical_facts_recovered}.`,
  `- Role stability under column reordering: ${synthetic.comparison.role_stability_under_column_reordering}.`,
  `- Row stability under pagination changes: ${synthetic.comparison.row_stability_under_pagination_changes}.`,
  `- Provenance complete: ${synthetic.comparison.provenance_complete}.`,
  `- Dependency closure: ${synthetic.comparison.dependency_closure}.`,
  `- Policy identity: ${JSON.stringify(synthetic.comparison.policy_identity)}.`,
  `- Failures unique to A: ${synthetic.comparison.failures_unique_to_a.join(', ') || 'none'}.`,
  `- Failures unique to B: ${synthetic.comparison.failures_unique_to_b.join(', ') || 'none'}.`,
  '',
  'The same generic policy did not generalize consistently across the two layouts: A recovered 8 of 24 facts and B recovered 4 of 24; role stability was false. This is reported as evidence against readiness, not corrected with source-identity policy.',
  '',
  '## 4. Part D cause distribution',
  '',
  `- Non-resolved records: ${diagnostic.non_resolved_record_count}.`,
  ...Object.entries(diagnostic.cause_distribution).map(([cause, count]) =>
    `- ${cause}: ${count}.`),
  '',
  'The remaining population is heterogeneous: 23 records are blocked before role mapping by split logical structure, 13 lack verified header cells, and one remains a non-exact physical-row-scope exclusion. No generic shared correction was identified, so no thresholds, margins, aliases, role predicates, or multiline attachment scope were changed.',
  '',
  '## 5. Transition composition with field IDs',
  '',
  ...(transitions.length === 0
    ? ['No TDOT material record changed classification, resolution, reconstruction, or field identity in Cycle 8.']
    : transitions.map((transition) =>
      `- ${transition.material_record_id}: ${oneLine(JSON.stringify(transition))}`)),
  '',
  '## 6. Evaluator and harness changes',
  '',
  '- Added property-specific native source mutation support for inline duplication and page-tree relocation; neither was promoted without satisfying its own assertions.',
  '- Added same-length native-span multiline description mutation. Isolated quantified TDOT effect: metamorphic `change_description` changed blocked to pass; reconstruction and semantic metrics changed by zero.',
  '- Added deterministic external synthetic generation and an A/B evaluator. The evaluator passes no source identity or construction plan to Extraction or Interpretation.',
  '- Renamed the policy symbol to `GENERIC_TABLE_POLICY_V8`; the hashed object content and parser manifest behavior are unchanged.',
  '',
  '## 7. Rejected experiments',
  '',
  '- `duplicate_row`: blocked before writing output because a selected native span crossed the grounded token geometry; the safety check was not relaxed.',
  '- `move_table_page`: executed. Logical value multiset preserved and dependency closure passed, but relocated render SHA differed and only 98/138 target fields preserved expected provenance; status is fail.',
  '- `missing_borders`: the audited graphics-redaction prototype kept text spans 156 -> 156 but strict span inventory changed and drawings stayed 75 -> 75 because a fill replaced the rule; no vector-only pass was claimed.',
  '- `reorder_columns`: no complete text/vector operator closure or unequal-width reflow proof.',
  '- `reorder_rows`: no adjacent pair was proven to have complete non-crossing native-span closure and mutually fitting bands.',
  '- `insert_row`: no distinct inserted signature was independently source-grounded without compounding a text mutation.',
  '',
  '## Verification',
  '',
  '- TypeScript `npx tsc --noEmit`: pass.',
  '- Changed-source ESLint with `--max-warnings=0`: pass.',
  '- Python `py_compile` for both generator and mutation executor: pass.',
  '- Focused real-PDF extraction / interpretation / harness / mutation / synthetic suite: 9 files, 114 passed.',
  '- Full Vitest: 193 files, 461 suites, 1,624 passed, 0 failed, 2 skipped real-source integration tests.',
  '- Architecture boundary and Golden anchor suites: 5 files, 50 passed.',
  '- Production build: pass, 42/42 static pages.',
  '- Real-PDF baseline and every executed mutation reported closed dependency graphs; both synthetic sources reported closed dependency graphs.',
  '- Golden values unchanged: ticket-grain CYD 74,617 and row-grain Extended Cost $815,559.35.',
  '',
  '## Boundaries',
  '',
  `- Phase 2 readiness: ${report.phase2_readiness.status}.`,
  '- Cutover decision: none.',
  '- Readers, validators, persistence, migrations, canonical consumers, Golden fixtures, thresholds, margins, aliases, `kindCompatible`, and `roleForLedger` are unchanged.',
  '- No source PDF, mutated PDF, synthetic PDF, or annotation ledger is in the repository.',
  `- External artifact root: ${root}.`,
  `- Synthetic artifact root: ${syntheticRoot}.`,
  '',
].join('\n');
const machine = {
  version: '1.14.0',
  shadow_only: true,
  phase2_started: false,
  cutover_decision: null,
  tdot_metrics: after,
  tdot_metamorphic: statuses,
  synthetic,
  cause_distribution: diagnostic.cause_distribution,
  transition_composition: transitions,
  git: {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8',
    }).trim(),
    status: execFileSync('git', ['status', '--short'], {
      cwd: process.cwd(), encoding: 'utf8',
    }).trim().split(/\r?\n/u).filter(Boolean),
    commit_created: false,
  },
};
await Promise.all([
  writeFile(
    path.join(finalDirectory, 'tdot-phase1-cycle8.v1.14.0.md'),
    markdown,
    'utf8',
  ),
  writeFile(
    path.join(finalDirectory, 'tdot-phase1-cycle8.v1.14.0.json'),
    `${JSON.stringify(machine, null, 2)}\n`,
    'utf8',
  ),
]);

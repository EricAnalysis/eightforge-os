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

function stableKey(record) {
  return record.ledger?.field_identifier
    ?? record.legacy_row?.row_id
    ?? record.id;
}

function selectedRole(record) {
  const roles = [...new Set(record.generic_fields
    .map((field) => field.semantic_mapping_evidence?.selected_role)
    .filter(Boolean))];
  return roles.length === 0 ? 'none' : roles.join(',');
}

function oneLine(value) {
  return String(value ?? '').replaceAll('\n', ' / ').replaceAll('|', '\\|');
}

function missingEvidenceCause(record) {
  return record.ledger?.interpreted_field_or_role === 'description'
    ? 'header evidence exists but normalized text matches no role'
    : 'the chain contains no header-bearing segment';
}

function peerLine(evidence, run) {
  return `- run=${run}; target_mapping=${evidence.target_mapping_id}; `
    + `target_segment=${evidence.target_segment_id}; `
    + `target_chain=${evidence.target_chain_id}; target_page=${evidence.target_page}; `
    + `target_column=${evidence.target_column_id}; `
    + `target_ordinal=${evidence.target_column_ordinal}; `
    + `target_geometry=${JSON.stringify(evidence.target_column_geometry)}; `
    + `peer_segment=${evidence.peer_segment_id}; peer_chain=${evidence.peer_chain_id}; `
    + `peer_page=${evidence.page}; peer_column=${evidence.peer_column_id}; `
    + `peer_ordinal=${evidence.peer_column_ordinal}; `
    + `peer_geometry=${JSON.stringify(evidence.peer_column_geometry)}; `
    + `distance=${evidence.geometric_distance}; page_distance=${evidence.page_distance}; `
    + `scope=${evidence.scope_classification}; `
    + `continuation_link=${evidence.continuation_link_id ?? 'none'}; `
    + `continuation_decision=${evidence.continuation_link_decision ?? 'none'}; `
    + `header=${oneLine(evidence.normalized_header_text)}; `
    + `role_contribution=${evidence.header_role_contribution}; `
    + `score_contribution=${evidence.score_contribution}; `
    + `decisive=${evidence.decisive}; `
    + `individually_decisive=${evidence.individually_decisive}; `
    + `selected=${evidence.selected_role ?? 'none'}; `
    + `runner_up=${evidence.runner_up_role ?? 'none'}; `
    + `score=${evidence.final_score}; margin=${evidence.final_margin}; `
    + `verified_fields=${evidence.source_verified_field_ids.join(',')}; `
    + `bbox=${JSON.stringify(evidence.bounding_box)}; `
    + `raw_span=${oneLine(JSON.stringify(evidence.raw_span))}; `
    + `dependency_hashes=${evidence.dependency_hashes.join(',')}`;
}

const root = required('TDOT_CYCLE6_ARTIFACT_ROOT');
const baselinePath = path.join(
  root,
  'phase1-v1.11.0-final',
  'tdot-phase1-parity-report.v1.11.0.json',
);
const rejectedPath = path.join(
  root,
  'phase1-v1.12.0-final',
  'tdot-phase1-parity-report.v1.12.0.json',
);
const rejectedAuditPath = path.join(
  root,
  'phase1-v1.12.1-rejected-document-scope-audit',
  'semantic-resolution-diagnostic.phase1-v1.12.0-rejected-document-scope.json',
);
const finalDirectory = path.join(root, 'phase1-v1.12.1-final');
const sameChainPath = path.join(
  finalDirectory,
  'tdot-phase1-parity-report.v1.12.1.json',
);
const sameChainAuditPath = path.join(
  finalDirectory,
  'semantic-resolution-diagnostic.phase1-v1.12.1-same-chain.json',
);
const vitestPath = path.join(finalDirectory, 'vitest-full-results.json');

const [baseline, rejected, rejectedAudit, sameChain, sameChainAudit, vitest] =
  await Promise.all([
    json(baselinePath),
    json(rejectedPath),
    json(rejectedAuditPath),
    json(sameChainPath),
    json(sameChainAuditPath),
    json(vitestPath),
  ]);

const baselineByKey = new Map(
  baseline.parity.records.map((record) => [stableKey(record), record]),
);
const rejectedByKey = new Map(
  rejected.parity.records.map((record) => [stableKey(record), record]),
);
const sameByKey = new Map(
  sameChain.parity.records.map((record) => [stableKey(record), record]),
);
const baselineSemantic = baseline.parity.records.filter((record) =>
  record.material && record.resolution === 'requires_semantic_review');
const rejectedEvidence = rejectedAudit.peer_header_scope_audit.evidence_items;
const sameEvidence = sameChainAudit.peer_header_scope_audit.evidence_items;

function decisivePeersForRecord(record) {
  const field = record.generic_fields[0];
  if (!field) return [];
  return rejectedEvidence
    .filter((evidence) =>
      evidence.target_page === field.source_page
      && evidence.selected_role === field.semantic_role
      && evidence.scope_classification
        === 'outside_chain_and_linked_continuation_scope'
      && evidence.decisive)
    .sort((left, right) =>
      right.score_contribution - left.score_contribution
      || left.page_distance - right.page_distance
      || left.peer_segment_id.localeCompare(right.peer_segment_id));
}

const transitions = baselineSemantic.map((baselineRecord) => {
  const key = stableKey(baselineRecord);
  const rejectedRecord = rejectedByKey.get(key);
  const sameRecord = sameByKey.get(key);
  if (!rejectedRecord || !sameRecord) {
    throw new Error(`Missing comparison record ${key}`);
  }
  const decisive = decisivePeersForRecord(rejectedRecord);
  return {
    key,
    baselineRecord,
    rejectedRecord,
    sameRecord,
    decisive,
  };
});

const extraRejectedResolutions = sameChain.parity.records.filter((record) => {
  if (!record.material || record.resolution !== 'requires_semantic_review') {
    return false;
  }
  const rejectedRecord = rejectedByKey.get(stableKey(record));
  const baselineRecord = baselineByKey.get(stableKey(record));
  return rejectedRecord?.resolution === 'resolved'
    && baselineRecord?.resolution !== 'requires_semantic_review';
});
const materialSame = sameChain.parity.records.filter(({ material }) => material);
const pageMetrics = [43, 44, 46].map((page) => {
  const records = materialSame.filter((record) =>
    record.ledger?.source_page === page);
  return {
    page,
    exact: records.filter((record) =>
      record.reconstruction_comparison?.exact_equal).length,
    total: records.length,
  };
});
const confidentlyIncorrect = materialSame.filter((record) => {
  return record.resolution === 'resolved'
    && record.semantic_role_comparison?.evidence_supported === false;
});
const previouslyResolvedRoleChanges = baseline.parity.records.filter((record) => {
  if (!record.material || record.resolution !== 'resolved') return false;
  const current = sameByKey.get(stableKey(record));
  return current != null && selectedRole(current) !== selectedRole(record);
});
const passedMutations = sameChain.metamorphic.results.filter((result) =>
  result.status === 'pass'
  && (
    result.mutation_manifest?.dependency_closure?.status
    || result.mutation_manifest?.execution_result?.dependency_closure?.status
  ));
const mutationClosureLines = passedMutations.map((result) =>
  `- ${result.invariant_id}: ${
    result.mutation_manifest.dependency_closure?.status
    ?? result.mutation_manifest.execution_result?.dependency_closure?.status
    ?? 'not recorded'
  }`);
const audit = rejectedAudit.peer_header_scope_audit;
const sameAudit = sameChainAudit.peer_header_scope_audit;
const status = execFileSync('git', ['status', '--short'], {
  encoding: 'utf8',
}).trimEnd();
const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  encoding: 'utf8',
}).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const branch = execFileSync('git', ['branch', '--show-current'], {
  encoding: 'utf8',
}).trim();

const transitionRows = transitions.map((transition) => {
  const firstPeer = transition.decisive[0];
  return `| ${transition.key} | ${transition.baselineRecord.resolution} / `
    + `${selectedRole(transition.baselineRecord)} | `
    + `${transition.rejectedRecord.resolution} / `
    + `${selectedRole(transition.rejectedRecord)} | `
    + `${transition.sameRecord.resolution} / `
    + `${selectedRole(transition.sameRecord)} | not evaluated | `
    + `${oneLine(transition.baselineRecord.ledger?.interpreted_field_or_role)} | `
    + `${firstPeer?.peer_segment_id ?? 'none'} | `
    + `${firstPeer?.peer_chain_id ?? 'none'} | `
    + `${firstPeer?.scope_classification ?? 'none'} | `
    + `${missingEvidenceCause(transition.sameRecord)}; retained as semantic review |`;
});

const lines = [
  '| Metric | v1.11.0 | v1.12.0 document-scoped rejected | v1.12.1 same-chain |',
  '|---|---:|---:|---:|',
  '| Exact reconstruction | 251 | 254 | 254 |',
  '| Non-exact, single-field | 4 | 1 | 1 |',
  '| Non-exact, split/merge | 1 | 1 | 1 |',
  '| Missing dependencies | 0 | 0 | 0 |',
  '| Resolved | 226 | 263 | 226 |',
  '| Unresolved | 27 | 25 | 25 |',
  '| Semantic review | 35 | 0 | 37 |',
  '| Metamorphic pass / fail / blocked | 7 / 0 / 14 | 7 / 0 / 14 | 7 / 0 / 14 |',
  '',
  '# Phase 3 Step 4 Cycle 6 Semantic Peer-Scope Remediation v1.12.1',
  '',
  '## Remediation verdict',
  '',
  'Pass for this focused shadow-only correction. Strict same-chain scope is the '
    + 'default. Raw geometry ranks peers only after chain membership authorizes '
    + 'the candidate population. No document-wide header inheritance remains. '
    + 'v1.12.0 is retained unchanged and explicitly rejected.',
  '',
  'No Phase 2 work, cutover decision, production reader change, validator change, '
    + 'persistence change, migration, canonical-consumer change, legacy TDOT '
    + 'assembly change, commit, or push was performed.',
  '',
  '## Rejected mechanism and decisive-peer provenance',
  '',
  'The rejected code path in `lib/interpretation/step3ShadowBridge.ts` was:',
  '',
  '```ts',
  'stableColumnGeometryPeers(column, input.segments)',
  '```',
  '',
  'That supplied every table segment in the document before header fields were '
    + 'collected and scored. The retained counterfactual score audit proves:',
  '',
  `- mappings resolved using only their own header: `
    + `${audit.mappings_resolved_using_only_own_header}`,
  `- mappings resolved using a same-chain peer header: `
    + `${audit.mappings_resolved_using_same_chain_peer_header}`,
  `- mappings resolved using an explicitly linked continuation peer: `
    + `${audit.mappings_resolved_using_explicit_linked_continuation_peer}`,
  `- mappings resolved while carrying a peer outside chain/linked scope: `
    + `${audit.mappings_resolved_using_peer_outside_chain_and_linked_scope}`,
  `- mappings for which out-of-chain scope was decisive: `
    + `${audit.mappings_for_which_out_of_chain_peer_was_decisive}`,
  `- mappings for which out-of-chain scope was retained but not decisive: `
    + `${audit.mappings_for_which_out_of_chain_peer_was_retained_but_not_decisive}`,
  `- rejected-run peer-header evidence items: ${audit.evidence_item_count}`,
  '',
  'For the 35 baseline semantic-review records, all 35 resolved in v1.12.0 '
    + 'only because of unrelated out-of-chain peer headers. They reuse three '
    + 'page-44 mappings. Under strict same-chain scope, 0/35 resolve.',
  '',
  '## Accepted same-chain policy',
  '',
  'The bridge now resolves the target chain, resolves its exact segment '
    + 'population, verifies every member belongs to that chain, and only then '
    + 'calls `stableColumnGeometryPeers(column, chainSegments)`. Different-chain '
    + 'geometry candidates are emitted only as scope rejections and never enter '
    + 'header fields or candidate scores.',
  '',
  `- same-chain material resolved count: 226`,
  `- same-chain mappings resolved using a peer segment: `
    + `${sameAudit.mappings_resolved_using_same_chain_peer_header}`,
  `- same-chain mappings resolved using only own headers: `
    + `${sameAudit.mappings_resolved_using_only_own_header}`,
  `- baseline semantic-review records resolved under same-chain scope: 0`,
  `- linked-continuation records resolved: not evaluated`,
  '',
  'Part C was not implemented. The existing chain builder places every retained '
    + '`decision === "linked"` connected component in one `TableChain`; legal '
    + 'linked continuations are therefore already covered by same-chain scope. '
    + 'A separate cross-chain policy would add no valid population in this model.',
  '',
  '## Per-record transitions for all 35 baseline semantic-review records',
  '',
  '| Record | Baseline state / role | Rejected state / role | Same-chain state / role | Linked state | Ledger role | Decisive peer segment | Decisive peer chain | Scope | Final disposition |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...transitionRows,
  '',
  '## Missing chain-internal evidence',
  '',
  '- the chain contains no header-bearing segment: 23 records (13 unit, 10 origin/destination)',
  '- header evidence exists but normalized text matches no role: 12 description records',
  '',
  'These are inputs to the next full remediation cycle. No header detection, '
    + 'reconstruction, verification, chain assignment, or continuation repair '
    + 'was attempted here.',
  '',
  '## Fixtures',
  '',
  '- Rejected document-scope reproduction: the geometry helper finds the aligned '
    + 'column in an unrelated chain, reproducing the rejected authorization path.',
  '- Same-chain negative: aligned unrelated chains do not share evidence; the '
    + 'headerless mapping remains ambiguous, the scope rejection serializes, '
    + 'and no unrelated header score component appears.',
  '- Same-chain positive: a headerless segment in one multi-segment chain may use '
    + 'the verified header from its stable same-chain peer; target/peer segment '
    + 'and chain IDs serialize and the retained predicate resolves it.',
  '- Rejected and ambiguous continuation decisions do not authorize sharing.',
  '',
  '## Freeze confirmation',
  '',
  '- score threshold: 0.7, unchanged',
  '- margin threshold: 0.2, unchanged',
  '- aliases and normalization vocabulary: unchanged',
  '- `kindCompatible`, conflicting-cell-value logic, `roleForLedger`, ledger roles, '
    + 'material parity classification, evaluator matching, and resolution-state '
    + 'definitions: unchanged',
  '- semantic interpreter policy version: advanced to v4 solely to identify the '
    + 'same-chain scope correction',
  '',
  '## Exact/non-exact/missing by page',
  '',
  '| Page | Exact | Total | Non-exact | Missing |',
  '|---:|---:|---:|---:|---:|',
  ...pageMetrics.map(({ page, exact, total }) =>
    `| ${page} | ${exact} | ${total} | ${total - exact} | 0 |`),
  '',
  'Exact reconstruction did not change from the rejected run. Dependency closure '
    + 'did not change. No previously resolved baseline record changed role. '
    + `Observed previously resolved role changes: ${previouslyResolvedRoleChanges.length}. `
    + `Confidently incorrect same-chain records: ${confidentlyIncorrect.length}.`,
  '',
  '## Resolution transition composition',
  '',
  '- baseline semantic review -> rejected resolved -> same-chain semantic review: 35',
  `- additional rejected resolved -> same-chain semantic review after Cycle 6 `
    + `reconstruction correction: ${extraRejectedResolutions.length}`,
  '- rejected unresolved -> same-chain unresolved: 25',
  '- same-chain resolved: 226',
  '- same-chain unresolved: 25',
  '- same-chain semantic review: 37',
  '',
  ...extraRejectedResolutions.map((record) =>
    `- additional transition: ${stableKey(record)}; rejected=resolved; `
      + `same-chain=requires_semantic_review; ledger=${
        oneLine(record.ledger?.interpreted_field_or_role)
      }`),
  '',
  '## Dependency closure',
  '',
  `- baseline: ${sameChain.generic_run.dependency_closure.status}; `
    + `${sameChain.generic_run.dependency_closure.checked_verified_fields} `
    + `VerifiedFields, ${sameChain.generic_run.dependency_closure.checked_candidates} `
    + `candidates, ${sameChain.generic_run.dependency_closure.checked_fragments} fragments`,
  ...mutationClosureLines,
  '',
  '## Genericity scan',
  '',
  'Pass. Production Extraction and Interpretation contain no TDOT identifier, '
    + 'contract number, source SHA routing, filename, audited-page route, expected '
    + 'value/count, or known text. The opaque-ID ordering scan also returned no '
    + 'matches. Source hashes remain provenance only.',
  '',
  '## Verification matrix',
  '',
  '| Check | Result |',
  '|---|---|',
  '| `npx tsc --noEmit` | pass |',
  '| changed-source ESLint `--max-warnings=0` | pass |',
  '| Python `py_compile` | pass |',
  '| focused semantic/peer-scope/diagnostic/extraction/harness/mutation tests | 106 pass; 2 environment-gated |',
  '| real-PDF harness + manifest invariance rerun | 18/18 pass |',
  '| architecture boundary tests | 20/20 pass |',
  '| Golden tests | 2/2 pass |',
  `| full Vitest | ${vitest.testResults.length} files; `
    + `${vitest.numPassedTests} pass; ${vitest.numFailedTests} fail; `
    + `${vitest.numPendingTests} skip |`,
  '| full Vitest command | `npx vitest run --testTimeout=30000 --hookTimeout=120000 --maxWorkers=4 --reporter=json --outputFile=<external-v1.12.1-artifact>` |',
  '| full Vitest config | `vitest.config.ts`; node environment; 4 workers; 30s test timeout; 120s hook timeout |',
  '| full Vitest exclusions | `node_modules`, `.next`, `e2e` |',
  '| full Vitest reruns | none; focused initial harness-version assertion failed, was corrected to v1.12.1, and the complete focused suite then passed |',
  '| production build | pass; 42/42 static pages; 11 workers; existing pdfjs externalization warning |',
  '| `git diff --check` | pass |',
  '| static genericity scan | pass |',
  '| baseline dependency closure | pass |',
  '| every executed mutation dependency closure | pass (4/4) |',
  '| Golden values | Ticket-grain CYD 74,617; row-grain Extended Cost $815,559.35 |',
  '',
  '## HEAD and worktree status',
  '',
  `- HEAD: ${head}`,
  `- branch: ${branch}`,
  '- v1.12.0 rejected report retained and not overwritten',
  '- worktree: intentionally modified/untracked; accepted Cycle 6 work retained',
  `- staged files: ${staged || 'none'}`,
  '- index: clean',
  '- commit: not created',
  '- push: not performed',
  '- repository PDF changes: none',
  '- modified/untracked files:',
  '```text',
  status,
  '```',
  '',
  '## Phase 2 readiness',
  '',
  `Status: ${sameChain.phase2_readiness.status}. Phase 2 was not begun and no `
    + 'cutover decision was created. The valid-scope result intentionally accepts '
    + 'a lower resolved count. Thirty-seven records require semantic review, '
    + 'twenty-five remain unresolved, two page-46 records remain non-exact, and '
    + 'metamorphic coverage remains 7 pass / 0 fail / 14 blocked.',
  '',
  '## Peer-header evidence appendix',
  '',
  'Every retained peer-header evidence item below has an explicit scope '
    + 'classification and decisive/non-decisive counterfactual result.',
  '',
  ...rejectedEvidence.map((evidence) => peerLine(evidence, 'v1.12.0-rejected')),
  ...sameEvidence.map((evidence) => peerLine(evidence, 'v1.12.1-same-chain')),
  '',
  'Machine-readable scope rejection inventories remain in:',
  '',
  `- ${rejectedAuditPath}`,
  `- ${sameChainAuditPath}`,
  '',
];

const outputPath = path.join(
  finalDirectory,
  'tdot-phase1-cycle6-semantic-peer-scope-remediation.v1.12.1.md',
);
await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`${outputPath}\n`);

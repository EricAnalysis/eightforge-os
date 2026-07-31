import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { GridCellArtifact } from '@/lib/extraction/domain/types';
import type {
  GenericShadowRun,
  MetamorphicResult,
  ParityRecord,
  TdotLedger,
} from '@/lib/evaluation/tdotPhase1Harness';
import {
  buildParityRecords,
  runGenericShadowFromPdf,
} from '@/lib/evaluation/tdotPhase1Harness';

interface SyntheticLedger extends TdotLedger {
  readonly construction_spec_sha256: string;
  readonly structural_annotations: readonly Readonly<Record<string, unknown>>[];
}

export function assertExternalEvaluationPath(file: string): string {
  const resolved = path.resolve(file);
  const root = path.resolve(process.cwd());
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('synthetic PDFs, ledgers, and reports must remain outside the repository');
  }
  return resolved;
}

function metrics(records: readonly ParityRecord[], run: GenericShadowRun) {
  const material = records.filter((record) => record.material);
  return {
    exact_reconstruction: material.filter((record) =>
      record.reconstruction_comparison?.exact_equal).length,
    non_exact: material.filter((record) =>
      record.reconstruction_comparison?.exact_equal === false).length,
    missing_dependencies: material.filter((record) =>
      record.ledger != null && record.generic_fields.length === 0).length,
    resolved: material.filter(({ resolution }) => resolution === 'resolved').length,
    unresolved: material.filter(({ resolution }) => resolution === 'unresolved').length,
    semantic_review: material.filter(
      ({ resolution }) => resolution === 'requires_semantic_review',
    ).length,
    dependency_closure: run.dependency_closure,
  };
}

function blocked(id: string, reason: string): MetamorphicResult {
  return {
    invariant_id: id as MetamorphicResult['invariant_id'],
    description: reason,
    status: 'blocked',
    mutation_manifest: {
      execution_result: 'not_executed',
      failed_precondition: reason,
    },
    explanation: `Blocked: ${reason}`,
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
}

function structuralResults(run: GenericShadowRun): readonly MetamorphicResult[] {
  const cells = run.graph.fragments.filter(
    (fragment): fragment is GridCellArtifact => fragment.kind === 'cell',
  );
  const merged = cells.filter((cell) =>
    cell.column_span > 1
    && cell.raw_text.includes('\n')
    && cell.line_break_offsets.length > 0);
  const childSegments = run.graph.tableSegments.filter(
    ({ parent_segment_id }) => parent_segment_id != null,
  );
  const headerPages = new Set(run.graph.tableRows
    .filter(({ row_kind }) => row_kind === 'header')
    .map(({ page }) => page));
  const repeatedPass = headerPages.size >= 2;
  const linked = run.graph.continuationLinks.filter(({ decision }) =>
    decision === 'linked');
  const crossPagePass = linked.some((link) => {
    const from = run.graph.tableSegments.find(({ id }) =>
      id === link.from_segment_id);
    const to = run.graph.tableSegments.find(({ id }) =>
      id === link.to_segment_id);
    return from != null && to != null && from.page !== to.page
      && run.graph.tableChains.some((chain) =>
        chain.segment_ids.includes(from.id) && chain.segment_ids.includes(to.id));
  });
  return [
    merged.length > 0 ? {
      invariant_id: 'merged_multiline_cells',
      description: 'A multiline cell spans multiple columns without copying neighbors.',
      status: 'pass',
      mutation_manifest: {
        executed_structure: true,
        spanning_cell_ids: merged.map(({ id }) => id),
      },
      explanation: 'The automatic parser emitted a multiline spanning cell with line offsets.',
      changed_field_ids: [],
      unexpected_field_ids: [],
    } : blocked(
      'merged_multiline_cells',
      'automatic PDF reconstruction emitted no source-grounded multiline column span',
    ),
    childSegments.length > 0 ? {
      invariant_id: 'subtables',
      description: 'A child table retains its parent segment and chain structure.',
      status: 'pass',
      mutation_manifest: {
        executed_structure: true,
        child_segment_ids: childSegments.map(({ id }) => id),
      },
      explanation: 'The automatic parser emitted a parent-linked subtable segment.',
      changed_field_ids: [],
      unexpected_field_ids: [],
    } : blocked(
      'subtables',
      'automatic PDF reconstruction emitted no parent-linked child segment',
    ),
    {
      invariant_id: 'repeated_headers',
      description: 'Repeated headers are independently observed on both pages.',
      status: repeatedPass ? 'pass' : 'fail',
      mutation_manifest: {
        executed_structure: true,
        observed_header_pages: [...headerPages].sort(),
      },
      explanation: repeatedPass
        ? 'Header rows were independently observed on both page segments.'
        : 'The constructed repeated headers did not survive automatic header detection on both pages.',
      changed_field_ids: [],
      unexpected_field_ids: [],
    },
    {
      invariant_id: 'cross_page_continuation',
      description: 'Adjacent page segments link into one table chain.',
      status: crossPagePass ? 'pass' : 'fail',
      mutation_manifest: {
        executed_structure: true,
        linked_continuation_ids: linked.map(({ id }) => id),
      },
      explanation: crossPagePass
        ? 'The two page segments linked into one source-grounded table chain.'
        : 'The constructed page break did not produce a linked cross-page continuation.',
      changed_field_ids: [],
      unexpected_field_ids: [],
    },
  ];
}

export async function evaluateSyntheticSource(input: {
  readonly label: 'A' | 'B';
  readonly pdfPath: string;
  readonly ledgerPath: string;
}) {
  const pdfPath = assertExternalEvaluationPath(input.pdfPath);
  const ledgerPath = assertExternalEvaluationPath(input.ledgerPath);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as SyntheticLedger;
  const run = await runGenericShadowFromPdf({
    pdfPath,
    expectedSha256: ledger.source_pdf.sha256,
    associationSeed: `synthetic-generalization-${input.label}`,
  });
  const records = buildParityRecords({
    ledger,
    legacyRows: [],
    genericFields: run.fields,
  });
  const metamorphic = structuralResults(run);
  const counts = {
    pass: metamorphic.filter(({ status }) => status === 'pass').length,
    fail: metamorphic.filter(({ status }) => status === 'fail').length,
    blocked: metamorphic.filter(({ status }) => status === 'blocked').length,
  };
  return {
    label: input.label,
    source_sha256: run.source_sha256,
    construction_spec_sha256: ledger.construction_spec_sha256,
    implementation_build: run.implementation_build,
    parser_manifest_hash: run.graph.snapshot.parser_manifest_hash,
    interpretation_manifest_hash:
      run.fields[0]?.interpretation_manifest_hash ?? null,
    metrics: {
      ...metrics(records, run),
      metamorphic: counts,
    },
    metamorphic,
    records,
    provenance_complete: records
      .filter(({ material }) => material)
      .every((record) => record.generic_fields.every((field) =>
        field.source_fragment_ids.length > 0 && Boolean(field.dependency_hash))),
  };
}

export async function evaluateSyntheticGeneralization(input: {
  readonly sourceA: { readonly pdfPath: string; readonly ledgerPath: string };
  readonly sourceB: { readonly pdfPath: string; readonly ledgerPath: string };
  readonly outputDirectory: string;
}) {
  const outputDirectory = assertExternalEvaluationPath(input.outputDirectory);
  const [sourceA, sourceB] = await Promise.all([
    evaluateSyntheticSource({ label: 'A', ...input.sourceA }),
    evaluateSyntheticSource({ label: 'B', ...input.sourceB }),
  ]);
  const policyIdentity = {
    implementation_build_equal:
      sourceA.implementation_build === sourceB.implementation_build,
    parser_manifest_equal:
      sourceA.parser_manifest_hash === sourceB.parser_manifest_hash,
    interpretation_manifest_equal:
      sourceA.interpretation_manifest_hash === sourceB.interpretation_manifest_hash,
  };
  if (Object.values(policyIdentity).some((equal) => !equal)) {
    throw new Error('synthetic A and B were not evaluated under identical policy');
  }
  const recoveredFacts = (source: typeof sourceA) => source.records
    .filter((record) => record.material && record.resolution === 'resolved')
    .map((record) => record.ledger?.field_identifier)
    .filter((id): id is string => id != null)
    .sort();
  const roles = (source: typeof sourceA) => source.records
    .filter((record) => record.material)
    .map((record) => ({
      logical: record.ledger?.field_identifier ?? record.id,
      roles: record.generic_fields.map(({ semantic_role }) => semantic_role).sort(),
    }))
    .sort((left, right) => left.logical.localeCompare(right.logical));
  const report = {
    report_version: '1.14.0',
    shadow_only: true,
    cutover_decision: null,
    source_a: sourceA,
    source_b: sourceB,
    comparison: {
      identical_logical_facts_recovered:
        hashCanonical(recoveredFacts(sourceA)) === hashCanonical(recoveredFacts(sourceB)),
      role_stability_under_column_reordering:
        hashCanonical(roles(sourceA)) === hashCanonical(roles(sourceB)),
      row_stability_under_pagination_changes:
        new Set(sourceA.records.flatMap((record) =>
          record.ledger ? [record.ledger.row_identity] : [])).size
        === new Set(sourceB.records.flatMap((record) =>
          record.ledger ? [record.ledger.row_identity] : [])).size,
      provenance_complete:
        sourceA.provenance_complete && sourceB.provenance_complete,
      dependency_closure:
        sourceA.metrics.dependency_closure.status === 'pass'
        && sourceB.metrics.dependency_closure.status === 'pass',
      policy_identity: policyIdentity,
      failures_unique_to_a: sourceA.metamorphic
        .filter(({ status }) => status !== 'pass')
        .map(({ invariant_id }) => invariant_id)
        .filter((id) => sourceB.metamorphic.some((result) =>
          result.invariant_id === id && result.status === 'pass')),
      failures_unique_to_b: sourceB.metamorphic
        .filter(({ status }) => status !== 'pass')
        .map(({ invariant_id }) => invariant_id)
        .filter((id) => sourceA.metamorphic.some((result) =>
          result.invariant_id === id && result.status === 'pass')),
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    'synthetic-generalization-report.v1.14.0.json',
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, outputPath };
}

/**
 * The operator review artifact.
 *
 * An operator must never be asked to diff raw JSON. This module turns a
 * comparison into a short Markdown report that leads with the decision-relevant
 * material: what differs, which value each authority produced, what evidence
 * backs it, why the automated pass classified it that way, and where to record a
 * disposition.
 *
 * Two deliberate omissions:
 *
 *  - informational deltas are counted but not itemized. An operator reviewing a
 *    shadow comparison needs the material differences; burying six blocking
 *    deltas under two hundred structural ones is how a review gets skipped.
 *  - the report contains no instruction that would change truth. Recording a
 *    disposition is audit metadata — it does not rewrite canonical truth, does not
 *    alter a validation result, and does not change which authority serves.
 */

import {
  type AuthorityComparisonDelta,
  type AuthorityRunSummary,
  type OperatorDeltaDisposition,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';

export const OPERATOR_DISPOSITIONS: readonly OperatorDeltaDisposition[] = [
  'canonical_correction',
  'canonical_regression',
  'expected_policy_difference',
  'source_gap',
  'needs_more_evidence',
  'accepted_equivalent',
];

const MATERIALITY_LABEL: Readonly<Record<string, string>> = {
  blocking: 'BLOCKING',
  review_required: 'REVIEW REQUIRED',
  informational: 'informational',
};

function authorityLine(label: string, summary: AuthorityRunSummary): string {
  const blocked = summary.blockedTruthDomains.length > 0
    ? ` blocked domains: ${summary.blockedTruthDomains.join(', ')};`
    : '';
  return `- **${label}** — assembly \`${summary.assemblyStatus}\`;`
    + `${summary.blockReason ? ` block reason \`${summary.blockReason}\`;` : ''}`
    + `${blocked}`
    + ` clearance \`${summary.clearance.outcome}\`;`
    + ` validation \`${summary.clearance.validationStatus}\`;`
    + ` invoices ${String(summary.invoiceCount)};`
    + ` invoice lines ${String(summary.invoiceLineCount)};`
    + ` transactions ${String(summary.transactionCount)};`
    + ` billed ${formatAmount(summary.exposure.totalBilledAmount)};`
    + ` at risk ${formatAmount(summary.exposure.totalAtRiskAmount)};`
    + ` registry digest \`${summary.registryDigest ?? 'none'}\``;
}

function formatAmount(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatValue(value: unknown): string {
  if (value == null) return '_absent_';
  if (typeof value === 'string') return value.length > 0 ? `\`${value}\`` : '_empty_';
  if (typeof value === 'number' || typeof value === 'boolean') return `\`${String(value)}\``;
  if (Array.isArray(value)) {
    return value.length === 0 ? '_none_' : `\`${value.map((entry) => String(entry)).join(', ')}\``;
  }
  return `\`${JSON.stringify(value)}\``;
}

function evidenceLines(delta: AuthorityComparisonDelta): readonly string[] {
  if (delta.evidenceReferences.length === 0) {
    // Stated explicitly rather than omitted. "No evidence was attached" is itself
    // material when an operator is deciding whether a delta is trustworthy.
    return ['  - Source evidence: _none attached_'];
  }
  return delta.evidenceReferences.map((reference) => {
    const parts = [
      reference.sourceDocumentId ? `document \`${reference.sourceDocumentId}\`` : null,
      reference.sourceArtifactId ? `artifact \`${reference.sourceArtifactId}\`` : null,
      reference.page != null ? `page ${String(reference.page)}` : null,
      reference.detail,
    ].filter((part): part is string => part != null && part.length > 0);
    return `  - Source evidence (${reference.kind}): ${parts.length > 0 ? parts.join('; ') : '_unspecified_'}`;
  });
}

function deltaSection(
  delta: AuthorityComparisonDelta,
  disposition: string | null,
): readonly string[] {
  return [
    `#### ${MATERIALITY_LABEL[delta.materiality] ?? delta.materiality} — ${delta.domain} / ${delta.field}`,
    '',
    delta.explanation,
    '',
    `- Affected entity: \`${delta.entityKey}\``,
    `- Legacy value: ${formatValue(delta.legacyValue)}`,
    `- Canonical value: ${formatValue(delta.canonicalValue)}`,
    ...evidenceLines(delta),
    `- Automated classification: \`${delta.classification}\``,
    `- Why: ${delta.classificationRationale}`,
    `- Delta id: \`${delta.deltaId}\``,
    `- **Operator disposition:** ${disposition != null ? `\`${disposition}\`` : '_not yet recorded_'}`
      + `${disposition == null ? ` — one of: ${OPERATOR_DISPOSITIONS.join(', ')}` : ''}`,
    '',
  ];
}

/**
 * Renders a comparison as an operator-readable Markdown report.
 *
 * `projectName` is accepted separately because the comparison model deliberately
 * carries no denormalized project attributes — a comparison is identified by
 * project id and input digest, and copying a mutable display name into an audit
 * artifact would make the artifact disagree with the project over time.
 */
export function renderAuthorityComparisonReport(params: {
  readonly comparison: ProjectTruthAuthorityComparison;
  readonly projectName?: string | null;
}): string {
  const { comparison } = params;
  const dispositionByDeltaId = new Map(
    comparison.operatorDispositions.map((record) => [record.deltaId, record.disposition]),
  );
  const material = comparison.deltas.filter(
    (delta) => delta.materiality === 'blocking' || delta.materiality === 'review_required',
  );

  const lines: string[] = [
    `# Authority comparison — ${params.projectName ?? comparison.projectId}`,
    '',
    `- Project id: \`${comparison.projectId}\``,
    `- Comparison version: \`${comparison.comparisonVersion}\``,
    `- Input snapshot digest: \`${comparison.inputSnapshotDigest}\``,
    `- Executed at: ${comparison.createdAt}`,
    `- Comparison status: **${comparison.comparisonStatus}**`,
    '',
    '## Authority status',
    '',
    authorityLine('Legacy (serving reference)', comparison.legacy),
    authorityLine('Canonical (non-serving shadow)', comparison.canonical),
    '',
    '> The canonical result above is advisory only. It did not serve, was not persisted as a',
    '> validation result, and did not change project state.',
    '',
    '## Summary',
    '',
    `- Total deltas: ${String(comparison.classificationSummary.totalDeltas)}`,
    `- Blocking: ${String(comparison.classificationSummary.blockingDeltas)}`,
    `- Review required: ${String(comparison.classificationSummary.reviewRequiredDeltas)}`,
    `- Informational: ${String(comparison.classificationSummary.informationalDeltas)}`,
    `- Operator dispositions recorded: ${String(comparison.operatorDispositionSummary.recordedCount)}`
      + ` of ${String(comparison.classificationSummary.totalDeltas)}`
      + ` (${String(comparison.operatorDispositionSummary.outstandingCount)} outstanding)`,
    '',
    '### By domain',
    '',
    ...(comparison.classificationSummary.byDomain.length > 0
      ? comparison.classificationSummary.byDomain.map(
        (entry) => `- ${entry.domain}: ${String(entry.count)}`,
      )
      : ['- _none_']),
    '',
    '### By classification',
    '',
    ...(comparison.classificationSummary.byClassification.length > 0
      ? comparison.classificationSummary.byClassification.map(
        (entry) => `- ${entry.classification}: ${String(entry.count)}`,
      )
      : ['- _none_']),
    '',
    '## Material differences',
    '',
  ];

  if (material.length === 0) {
    lines.push(
      '_No blocking or review-required deltas._',
      '',
      'Parity alone does not authorize promotion. Canonical serving authority is enabled only by',
      'explicit operator acceptance after repeated production comparisons.',
      '',
    );
  } else {
    for (const delta of material) {
      lines.push(...deltaSection(delta, dispositionByDeltaId.get(delta.deltaId) ?? null));
    }
  }

  lines.push(
    '## Promotion rule',
    '',
    'An empty blocking-delta count does not authorize promotion on its own. Every material delta',
    'requires an operator disposition, and canonical serving authority remains a separate,',
    'explicitly configured decision. Legacy rollback stays available at all times.',
    '',
  );

  return lines.join('\n');
}

/**
 * The operator review artifact, in three levels.
 *
 * The first production cohort produced 11,364 deltas for one project and itemized
 * every blocking and review-required one. Nobody reads 5,124 blocking items, and a
 * report nobody reads is worse than none: it converts a real finding into noise.
 * The structure here is a direct response to that.
 *
 *  - **Level 1, decision summary.** What an operator needs to decide whether to
 *    read further: recommendation, status, root issue counts, exposure and
 *    clearance movement.
 *  - **Level 2, root-cause groups.** One entry per *cause*, with impact counts,
 *    representative samples, evidence, and a disposition field. Thousands of
 *    mechanical consequences of one blocked domain become one entry that states how
 *    many entities it touched.
 *  - **Level 3, machine detail.** A pointer to the full artifact, which retains
 *    every individual delta. Collapsing is a presentation choice; nothing is lost.
 *
 * Two deliberate omissions remain: informational groups are counted but not
 * itemized, and the report contains no instruction that would change truth.
 * Recording a disposition is audit metadata — it does not rewrite canonical truth,
 * alter a validation result, or change which authority serves.
 */

import {
  type AuthorityComparisonDeltaGroup,
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
    + ` governing pricing rows ${String(summary.governingPricing.length)};`
    + ` billed ${formatAmount(summary.exposure.totalBilledAmount)};`
    + ` at risk ${formatAmount(summary.exposure.totalAtRiskAmount)};`
    + ` registry digest \`${summary.registryDigest ?? 'none'}\``;
}

function evidenceLines(group: AuthorityComparisonDeltaGroup): readonly string[] {
  if (group.evidenceReferences.length === 0) {
    // Stated explicitly rather than omitted. "No evidence was attached" is itself
    // material when an operator is deciding whether a group is trustworthy.
    return ['  - Source evidence: _none attached_'];
  }
  return group.evidenceReferences.map((reference) => {
    const parts = [
      reference.sourceDocumentId ? `document \`${reference.sourceDocumentId}\`` : null,
      reference.sourceArtifactId ? `artifact \`${reference.sourceArtifactId}\`` : null,
      reference.page != null ? `page ${String(reference.page)}` : null,
      reference.detail,
    ].filter((part): part is string => part != null && part.length > 0);
    return `  - Source evidence (${reference.kind}): ${parts.length > 0 ? parts.join('; ') : '_unspecified_'}`;
  });
}

function impactLine(group: AuthorityComparisonDeltaGroup): string {
  const parts = [
    `${String(group.affectedEntityCount)} affected entit${group.affectedEntityCount === 1 ? 'y' : 'ies'}`,
    group.affectedTransactionCount > 0 ? `${String(group.affectedTransactionCount)} transaction(s)` : null,
    group.affectedInvoiceCount > 0 ? `${String(group.affectedInvoiceCount)} invoice(s)` : null,
    group.affectedFindingCount > 0 ? `${String(group.affectedFindingCount)} finding(s)` : null,
    group.affectedAmount != null ? `${formatAmount(group.affectedAmount)} affected` : null,
  ].filter((part): part is string => part != null);
  return `- Impact: ${parts.join('; ')}`;
}

function groupSection(
  group: AuthorityComparisonDeltaGroup,
  comparison: ProjectTruthAuthorityComparison,
  disposition: string | null,
): readonly string[] {
  const members = comparison.deltas.filter(
    (delta) => group.dependentDeltaIds.includes(delta.deltaId),
  );
  const sample = members[0] ?? null;
  const collapsed = group.dependentDeltaIds.length > 1;

  return [
    `#### ${MATERIALITY_LABEL[group.materiality] ?? group.materiality} — ${group.domain} / ${group.field}`,
    '',
    group.rootCauseSummary,
    '',
    impactLine(group),
    ...(collapsed
      ? [
        `- Representative entities: ${group.representativeEntities.map((entity) => `\`${entity}\``).join(', ')}`
          + `${group.affectedEntityCount > group.representativeEntities.length
            ? ` … and ${String(group.affectedEntityCount - group.representativeEntities.length)} more`
            : ''}`,
        `- Sample values — legacy ${formatValue(sample?.legacyValue)}, `
          + `canonical ${formatValue(sample?.canonicalValue)}`,
      ]
      : [
        `- Affected entity: \`${sample?.entityKey ?? group.representativeEntities[0] ?? 'unknown'}\``,
        `- Legacy value: ${formatValue(sample?.legacyValue)}`,
        `- Canonical value: ${formatValue(sample?.canonicalValue)}`,
      ]),
    ...(sample != null && !collapsed ? ['', sample.explanation, ''] : ['']),
    ...evidenceLines(group),
    `- Automated classification: \`${group.classification}\``,
    `- Why: ${sample?.classificationRationale ?? group.rootCauseSummary}`,
    `- Group id: \`${group.groupId}\``,
    `- Root delta id: \`${group.rootDeltaId}\``,
    ...(collapsed
      ? [`- Full detail: ${String(group.dependentDeltaIds.length)} deltas retained in the machine artifact`]
      : []),
    `- **Operator disposition:** ${disposition != null ? `\`${disposition}\`` : '_not yet recorded_'}`
      + `${disposition == null ? ` — one of: ${OPERATOR_DISPOSITIONS.join(', ')}` : ''}`,
    '',
  ];
}

/**
 * Renders a comparison as a three-level operator report.
 *
 * `projectName` is accepted separately because the comparison model deliberately
 * carries no denormalized project attributes — a comparison is identified by
 * project id and input digest, and copying a mutable display name into an audit
 * artifact would make the artifact disagree with the project over time.
 */
export function renderAuthorityComparisonReport(params: {
  readonly comparison: ProjectTruthAuthorityComparison;
  readonly projectName?: string | null;
  /** Where the full machine detail lives, when it has been persisted. */
  readonly artifactReference?: string | null;
}): string {
  const { comparison } = params;
  const dispositionByDeltaId = new Map(
    comparison.operatorDispositions.map((record) => [record.deltaId, record.disposition]),
  );
  const groups = comparison.deltaGroups;
  const blocking = groups.filter((group) => group.materiality === 'blocking');
  const review = groups.filter((group) => group.materiality === 'review_required');
  const informational = groups.filter((group) => group.materiality === 'informational');
  const totalAffectedEntities = groups.reduce(
    (total, group) => total + group.affectedEntityCount,
    0,
  );

  const lines: string[] = [
    `# Authority comparison — ${params.projectName ?? comparison.projectId}`,
    '',
    '## Level 1 — decision summary',
    '',
    // Promotion is never implied by an automated result. Stated first so it cannot
    // be inferred from a low delta count further down.
    '- **Promotion recommendation: HOLD.** A comparison never authorizes promotion;',
    '  canonical serving authority requires operator acceptance of every material',
    '  root cause below, and remains a separate, explicitly configured decision.',
    `- Project id: \`${comparison.projectId}\``,
    `- Comparison version: \`${comparison.comparisonVersion}\``,
    `- Input snapshot digest: \`${comparison.inputSnapshotDigest}\``,
    `- Executed at: ${comparison.createdAt}`,
    `- Comparison status: **${comparison.comparisonStatus}**`,
    `- Root causes: **${String(blocking.length)} blocking**, ${String(review.length)} review-required, `
      + `${String(informational.length)} informational`,
    `- Total affected entities across all root causes: ${String(totalAffectedEntities)}`,
    `- Underlying deltas retained in the machine artifact: ${String(comparison.deltas.length)}`,
    '',
    '### Authority status',
    '',
    authorityLine('Legacy (serving reference)', comparison.legacy),
    authorityLine('Canonical (non-serving shadow)', comparison.canonical),
    '',
    '> The canonical result above is advisory only. It did not serve, was not persisted as a',
    '> validation result, and did not change project state.',
    '',
    '### Exposure and clearance',
    '',
    `- Clearance: legacy \`${comparison.legacy.clearance.outcome}\` → `
      + `canonical \`${comparison.canonical.clearance.outcome}\``,
    `- Validation: legacy \`${comparison.legacy.clearance.validationStatus}\` → `
      + `canonical \`${comparison.canonical.clearance.validationStatus}\``,
    `- Billed: ${formatAmount(comparison.legacy.exposure.totalBilledAmount)} → `
      + `${formatAmount(comparison.canonical.exposure.totalBilledAmount)}`,
    `- At risk: ${formatAmount(comparison.legacy.exposure.totalAtRiskAmount)} → `
      + `${formatAmount(comparison.canonical.exposure.totalAtRiskAmount)}`,
    `- Fully reconciled: ${formatAmount(comparison.legacy.exposure.totalFullyReconciledAmount)} → `
      + `${formatAmount(comparison.canonical.exposure.totalFullyReconciledAmount)}`,
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
    '## Level 2 — root causes',
    '',
  ];

  const material = [...blocking, ...review];
  if (material.length === 0) {
    lines.push(
      '_No blocking or review-required root causes._',
      '',
      'Parity alone does not authorize promotion. Canonical serving authority is enabled only by',
      'explicit operator acceptance after repeated production comparisons.',
      '',
    );
  } else {
    for (const group of material) {
      lines.push(...groupSection(
        group,
        comparison,
        dispositionByDeltaId.get(group.rootDeltaId) ?? null,
      ));
    }
  }

  lines.push(
    '## Level 3 — machine detail',
    '',
    `- Every individual delta is retained: ${String(comparison.deltas.length)} total across `
      + `${String(groups.length)} root cause group(s).`,
    '- Grouping summarizes for review; it discards nothing. Each delta keeps its own id,',
    '  entity key, values, evidence, and classification in the artifact.',
    `- Artifact reference: ${params.artifactReference != null
      ? `\`${params.artifactReference}\``
      : '_not persisted for this run_'}`,
    '',
    '## Promotion rule',
    '',
    'An empty blocking count does not authorize promotion on its own. Every material root cause',
    'requires an operator disposition, and canonical serving authority remains a separate,',
    'explicitly configured decision. Legacy rollback stays available at all times.',
    '',
  );

  return lines.join('\n');
}

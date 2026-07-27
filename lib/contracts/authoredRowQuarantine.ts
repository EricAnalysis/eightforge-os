export type AuthoredRateRowFinding = 'F-01' | 'F-02' | 'F-03' | 'F-04';

export type AuthoredRateRowQuarantine = {
  authoredUnverified: true;
  finding: AuthoredRateRowFinding;
  reason: string;
  evidence: string;
};

export type AuthoredRateRowLike = {
  source_kind?: unknown;
  sourceKind?: unknown;
  row_id?: unknown;
  id?: unknown;
  authoredValueCorrection?: unknown;
};

type AuthoredRateRowRule = {
  finding: Exclude<AuthoredRateRowFinding, 'F-04'>;
  sourceKind: string;
  rowIdPrefix: string;
  reason: string;
  evidence: string;
};

const AUTHORED_RATE_ROW_RULES: readonly AuthoredRateRowRule[] = [
  {
    finding: 'F-01',
    sourceKind: 'tdot_appendix_b_stitched_table',
    rowIdPrefix: 'tdot_appendix_b_stitched:',
    reason: 'TDOT Appendix B rate row was produced by the known authored stitching path.',
    evidence:
      'Approval was blocked because the row is authored output and has not been source-verified by the generic extraction architecture.',
  },
  {
    finding: 'F-02',
    sourceKind: 'mdot_section_905_bid_schedule',
    rowIdPrefix: 'mdot_section_905_bid_schedule:',
    reason: 'MDOT Section 905 rate row was produced by the known authored bid-schedule path.',
    evidence:
      'Approval was blocked because the row is authored output and has not been source-verified by the generic extraction architecture.',
  },
  {
    finding: 'F-03',
    sourceKind: 'exhibit_a_text_recovery',
    rowIdPrefix: 'exhibit_a_text_recovery:',
    reason: 'Exhibit A rate row was produced by the known authored text-recovery path.',
    evidence:
      'Approval was blocked because the recovered row is authored output and has not been source-verified by the generic extraction architecture.',
  },
] as const;

const F04_QUARANTINE: AuthoredRateRowQuarantine = {
  authoredUnverified: true,
  finding: 'F-04',
  reason: 'Rate-row values were changed by the known authored Williamson display correction.',
  evidence:
    'Approval was blocked because one or more displayed values were authored by a correction rule rather than source-verified by the generic extraction architecture.',
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function authoredRateRowQuarantine(
  row: AuthoredRateRowLike,
): AuthoredRateRowQuarantine | null {
  if (row.authoredValueCorrection === true) return F04_QUARANTINE;

  const sourceKind = nonEmptyString(row.source_kind) ?? nonEmptyString(row.sourceKind);
  const rowId = nonEmptyString(row.row_id) ?? nonEmptyString(row.id);
  const rule = AUTHORED_RATE_ROW_RULES.find(
    (candidate) =>
      sourceKind === candidate.sourceKind
      || rowId?.startsWith(candidate.rowIdPrefix) === true,
  );
  if (!rule) return null;

  return {
    authoredUnverified: true,
    finding: rule.finding,
    reason: rule.reason,
    evidence: rule.evidence,
  };
}

export function isAuthoredUnverifiedRateRow(row: AuthoredRateRowLike): boolean {
  return authoredRateRowQuarantine(row) != null;
}

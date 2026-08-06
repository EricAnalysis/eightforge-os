/**
 * The operator review artifact.
 *
 * The requirement these tests defend is that an operator is never asked to compare
 * raw JSON: every material delta must arrive with a plain-language explanation,
 * both values, the affected entity, its source evidence, the automated
 * classification, the reason for that classification, and a place to record a
 * disposition.
 */

import { describe, expect, it } from 'vitest';

import {
  crossDocumentProfile,
  exactParityProfile,
  ticketGrainConflictProfile,
} from './__fixtures__/authorityComparisonFixtures';
import {
  isFailedComparison,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';
import {
  OPERATOR_DISPOSITIONS,
  renderAuthorityComparisonReport,
} from './authorityComparisonReport';
import { runProjectTruthAuthorityComparison } from './runProjectTruthAuthorityComparison';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

async function compare(
  snapshot: ValidatorSourceSnapshot,
): Promise<ProjectTruthAuthorityComparison> {
  const outcome = await runProjectTruthAuthorityComparison(snapshot.project.id, {
    sourceSnapshot: snapshot,
    now: () => '2026-08-05T00:00:00.000Z',
  });
  if (isFailedComparison(outcome)) throw new Error(outcome.failureReason);
  return outcome;
}

describe('operator comparison report header and summary', () => {
  it('identifies the project, version, input digest, timestamp, and every status', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({
      comparison,
      projectName: 'Cross-document fixture',
    });

    expect(report).toContain('# Authority comparison — Cross-document fixture');
    expect(report).toContain('`fixture-cross-document`');
    expect(report).toContain(comparison.comparisonVersion);
    expect(report).toContain(comparison.inputSnapshotDigest);
    expect(report).toContain('2026-08-05T00:00:00.000Z');
    expect(report).toContain(`Comparison status: **${comparison.comparisonStatus}**`);
    expect(report).toContain('Legacy (serving reference)');
    expect(report).toContain('Canonical (non-serving shadow)');
  });

  it('leads with root-cause counts, not raw delta totals', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({ comparison });
    const blocking = comparison.deltaGroups.filter((group) => group.materiality === 'blocking');
    const review = comparison.deltaGroups.filter(
      (group) => group.materiality === 'review_required',
    );

    // Root causes are what an operator acts on. The raw delta count is reported as
    // machine-artifact volume, not as a review workload.
    expect(report).toContain(`- Root causes: **${String(blocking.length)} blocking**, `
      + `${String(review.length)} review-required`);
    expect(report).toContain(
      `- Underlying deltas retained in the machine artifact: ${String(comparison.deltas.length)}`,
    );
    for (const entry of comparison.classificationSummary.byDomain) {
      expect(report).toContain(`- ${entry.domain}: ${String(entry.count)}`);
    }
    for (const entry of comparison.classificationSummary.byClassification) {
      expect(report).toContain(`- ${entry.classification}: ${String(entry.count)}`);
    }
  });

  it('states the promotion recommendation before any delta detail', async () => {
    const report = renderAuthorityComparisonReport({
      comparison: await compare(crossDocumentProfile()),
    });

    expect(report.indexOf('Promotion recommendation: HOLD'))
      .toBeLessThan(report.indexOf('## Level 2'));
  });

  it('reports exposure and clearance movement in the decision summary', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({ comparison });

    expect(report).toContain(`- Clearance: legacy \`${comparison.legacy.clearance.outcome}\` → `
      + `canonical \`${comparison.canonical.clearance.outcome}\``);
    expect(report).toContain('- At risk: ');
  });

  it('states plainly that the canonical result did not serve', async () => {
    const report = renderAuthorityComparisonReport({
      comparison: await compare(crossDocumentProfile()),
    });

    expect(report).toContain('advisory only');
    expect(report).toContain('did not serve');
    expect(report).toContain('did not change project state');
  });
});

describe('material differences', () => {
  it('itemizes every blocking and review-required root cause with full operator context', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({ comparison });
    const material = comparison.deltaGroups.filter(
      (group) => group.materiality === 'blocking' || group.materiality === 'review_required',
    );

    expect(material.length).toBeGreaterThan(0);
    for (const group of material) {
      expect(report).toContain(`- Automated classification: \`${group.classification}\``);
      expect(report).toContain(`- Group id: \`${group.groupId}\``);
      expect(report).toContain(`- Root delta id: \`${group.rootDeltaId}\``);
      expect(report).toContain('- Impact: ');
      expect(report).toContain('Source evidence');
      expect(report).toContain('**Operator disposition:**');
    }
  });

  it('does not itemize informational root causes, so material ones stay findable', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({ comparison });
    const informational = comparison.deltaGroups.filter(
      (group) => group.materiality === 'informational',
    );

    expect(informational.length).toBeGreaterThan(0);
    for (const group of informational) {
      expect(report).not.toContain(`- Group id: \`${group.groupId}\``);
    }
    // Still counted, so nothing is silently dropped from the operator's view.
    expect(report).toContain(`${String(informational.length)} informational`);
  });

  it('collapses a repeated mechanical shape into one entry with an impact count', async () => {
    const comparison = await compare(ticketGrainConflictProfile());
    const report = renderAuthorityComparisonReport({ comparison });
    const collapsed = comparison.deltaGroups.filter(
      (group) => group.dependentDeltaIds.length > 1
        && group.materiality !== 'informational',
    );

    expect(collapsed.length).toBeGreaterThan(0);
    for (const group of collapsed) {
      // One entry stands for many deltas, and says how many and which.
      expect(report).toContain(`- Group id: \`${group.groupId}\``);
      expect(report).toContain(
        `${String(group.dependentDeltaIds.length)} deltas retained in the machine artifact`,
      );
      expect(report).toContain('- Representative entities: ');
    }
  });

  it('points at the machine detail rather than inlining it', async () => {
    const comparison = await compare(ticketGrainConflictProfile());

    expect(renderAuthorityComparisonReport({ comparison }))
      .toContain('_not persisted for this run_');
    expect(renderAuthorityComparisonReport({
      comparison,
      artifactReference: 'authority-comparison/project/p/input/d/c.json',
    })).toContain('authority-comparison/project/p/input/d/c.json');
  });

  it('offers the full disposition vocabulary on an undecided delta', async () => {
    const comparison = await compare(crossDocumentProfile());
    const report = renderAuthorityComparisonReport({ comparison });

    expect(report).toContain('_not yet recorded_');
    for (const disposition of OPERATOR_DISPOSITIONS) {
      expect(report).toContain(disposition);
    }
  });

  it('shows a recorded disposition in place of the prompt', async () => {
    const baseline = await compare(crossDocumentProfile());
    const target = baseline.deltaGroups.find((group) => group.materiality === 'blocking')!;
    const annotated = await runProjectTruthAuthorityComparison('fixture-cross-document', {
      sourceSnapshot: crossDocumentProfile(),
      now: () => '2026-08-05T00:00:00.000Z',
      operatorDispositions: [{
        deltaId: target.rootDeltaId,
        disposition: 'expected_policy_difference',
        note: null,
        recordedBy: 'operator-1',
        recordedAt: '2026-08-05T01:00:00.000Z',
      }],
    }) as ProjectTruthAuthorityComparison;

    const report = renderAuthorityComparisonReport({ comparison: annotated });
    expect(report).toContain('**Operator disposition:** `expected_policy_difference`');
  });

  it('states explicitly when a root cause carries no evidence rather than omitting the line', async () => {
    const comparison = await compare(ticketGrainConflictProfile());
    const report = renderAuthorityComparisonReport({ comparison });
    const material = comparison.deltaGroups.filter(
      (group) => group.materiality !== 'informational',
    );
    const withoutEvidence = material.filter((group) => group.evidenceReferences.length === 0);

    if (withoutEvidence.length > 0) {
      expect(report).toContain('Source evidence: _none attached_');
    }
    // Every material root cause gets an evidence line one way or the other.
    expect(report.split('Source evidence').length - 1).toBeGreaterThanOrEqual(material.length);
  });
});

describe('promotion rule', () => {
  it('states that parity alone does not authorize promotion', async () => {
    const comparison = await compare(exactParityProfile());
    const report = renderAuthorityComparisonReport({ comparison });

    expect(comparison.classificationSummary.blockingDeltas).toBe(0);
    expect(report).toContain('_No blocking or review-required root causes._');
    expect(report).toContain('Parity alone does not authorize promotion');
    expect(report).toContain('does not authorize promotion on its own');
    expect(report).toContain('Legacy rollback stays available');
  });

  it('renders deterministically for the same comparison', async () => {
    const comparison = await compare(crossDocumentProfile());

    expect(renderAuthorityComparisonReport({ comparison }))
      .toBe(renderAuthorityComparisonReport({ comparison }));
  });

  it('does not copy a mutable project name into the comparison record itself', async () => {
    const comparison = await compare(crossDocumentProfile());

    expect(Object.keys(comparison)).not.toContain('projectName');
    expect(renderAuthorityComparisonReport({ comparison })).toContain('fixture-cross-document');
  });
});

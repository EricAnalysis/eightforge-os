import { describe, expect, it } from 'vitest';

import { measureFriction, measurementProducerKey } from '@/lib/improvementMeasurement';
import {
  classifyForgewingProducers,
  extractionCorrectionUnits,
  extractionDiagnosticUnits,
  fixDimensionsFor,
  forgewingProposalUnits,
  measurementWindows,
  revisionProducerClassification,
  ruleFindingUnits,
} from '@/lib/improvementMeasurementUnits';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const DEPLOYED = '2026-10-01T00:00:00.000Z';
const fingerprint = (n: string) => `rule-catalogue-v1:sha256:${n.repeat(64)}`;

describe('measurement windows (B8.4c)', () => {
  it('measures 90 days before the proven deployment against everything after it, and nothing before it opens', () => {
    expect(measurementWindows(DEPLOYED, '2026-10-15T00:00:00.000Z')).toEqual({
      baseline: { from: '2026-07-03T00:00:00.000Z', to: DEPLOYED },
      post: { from: DEPLOYED, to: '2026-10-15T00:00:00.000Z' },
    });
    expect(measurementWindows(DEPLOYED, DEPLOYED)).toBeNull();
    expect(measurementWindows('not a time', DEPLOYED)).toBeNull();
  });
});

describe('measurement units (B8.4c)', () => {
  it('rule semantics: a finding is attributed to the run that raised it, and occurs when overridden', () => {
    const runsById = new Map([
      ['run-old', { id: 'run-old', deployment_revision: OLD, deployment_environment: 'production', rule_catalogue_fingerprint: fingerprint('1') }],
      ['run-new', { id: 'run-new', deployment_revision: NEW, deployment_environment: 'production', rule_catalogue_fingerprint: fingerprint('2') }],
    ]);
    const units = ruleFindingUnits({ runsById, overriddenFindingIds: new Set(['f1']), findings: [
      { id: 'f1', run_id: 'run-old', created_at: '2026-09-01T00:00:00+00:00' },
      { id: 'f2', run_id: 'run-new', created_at: '2026-10-02T00:00:00+00:00' },
      { id: 'f3', run_id: 'run-gone', created_at: '2026-10-02T00:00:00+00:00' },
    ] });
    expect(units[0]).toEqual({ unitRef: 'validation_finding:f1', observedAt: '2026-09-01T00:00:00.000Z',
      attribution: { status: 'attributed', producer: { kind: 'deployment_revision', revision: OLD } },
      configuration: { rule_catalogue: fingerprint('1') }, occurred: true });
    expect(units[1]).toMatchObject({ occurred: false, configuration: { rule_catalogue: fingerprint('2') } });
    expect(units[2]!.attribution).toEqual({ status: 'unattributed', reason: 'historical_source_unproven' });
    expect(fixDimensionsFor('rule_semantics_review')).toEqual(['rule_catalogue']);
    expect(fixDimensionsFor('recurring_manual_correction')).toEqual([]);
  });

  it('manual correction: pinned corrections occur on their exact extraction; an unpinned one makes its document unattributable', () => {
    const row = (id: string, document: string, revision: string | null, mapping: string[] = []) => ({
      extraction_id: id, document_id: document, created_at: '2026-09-10T00:00:00Z', deployment_revision: revision,
      deployment_environment: revision ? 'production' : null, mapping_revisions: mapping });
    const units = extractionCorrectionUnits({ correctedExtractionIds: new Set(['x1']), unprovenDocumentIds: new Set(['d2']),
      extractions: [row('x1', 'd1', OLD, ['rev-1:aa']), row('x2', 'd1', OLD), row('x3', 'd2', OLD), row('x4', 'd3', null)] });
    expect(units.map((unit) => unit.occurred)).toEqual([true, false, false, false]);
    expect(units[0]!.configuration).toEqual({ customer_mapping_revision: 'rev-1:aa' });
    expect(units[1]!.configuration).toEqual({ customer_mapping_revision: null });
    expect(units[2]!.attribution).toEqual({ status: 'unattributed', reason: 'historical_source_unproven' });
    expect(units[3]!.attribution).toEqual({ status: 'unattributed', reason: 'producer_not_recorded' });
  });

  it('deterministic failure: occurs when the shared diagnostics builder derived the code from that extraction', () => {
    const attribution = { status: 'attributed' as const, producer: { kind: 'deployment_revision' as const, revision: OLD } };
    const units = extractionDiagnosticUnits({ code: 'ocr_low_confidence', extractions: [
      { id: 'x1', createdAt: '2026-09-01T00:00:00Z', attribution, diagnosticCodes: new Set(['ocr_low_confidence']) },
      { id: 'x2', createdAt: '2026-09-01T00:00:00Z', attribution, diagnosticCodes: new Set(['other']) },
    ] });
    expect(units.map((unit) => unit.occurred)).toEqual([true, false]);
  });
});

describe('producer classification (B8.4c)', () => {
  it('uses only worker-proven revisions', () => {
    expect(revisionProducerClassification([{ producer_revision: NEW, contains_fix: true },
      { producer_revision: OLD, contains_fix: false }])).toEqual({ [`revision:${OLD}`]: 'lacks_fix', [`revision:${NEW}`]: 'contains_fix' });
  });

  it('classifies a Forgewing identity by when it appeared; one that spans the deployment stays unclassified', () => {
    const identity = (version: string) => ({ task_type: 'value_reading', schema_version: '3', provider_model: 'm',
      prompt_template_id: 'p', prompt_template_version: version });
    const proposals = [
      { rowId: 'r1', proposalId: 'p1', createdAt: '2026-09-01T00:00:00Z' },
      { rowId: 'r2', proposalId: 'p2', createdAt: '2026-10-05T00:00:00Z' },
      { rowId: 'r3', proposalId: 'p3', createdAt: '2026-09-02T00:00:00Z' },
      { rowId: 'r4', proposalId: 'p4', createdAt: '2026-10-06T00:00:00Z' },
    ];
    const units = forgewingProposalUnits({ proposals, rejectedProposalIds: new Set(['p1']),
      identityByRowId: new Map([['r1', identity('1')], ['r2', identity('2')], ['r3', identity('3')], ['r4', identity('3')]]) });
    const key = (index: number) => {
      const attribution = units[index]!.attribution;
      if (attribution.status !== 'attributed') throw new Error('unattributed');
      return measurementProducerKey(attribution.producer);
    };
    expect(units[0]!.occurred).toBe(true);
    expect(classifyForgewingProducers(units, DEPLOYED)).toEqual({ [key(0)]: 'lacks_fix', [key(1)]: 'contains_fix' });
    expect(classifyForgewingProducers(units, DEPLOYED)).not.toHaveProperty(key(2));
  });
});

describe('undefined exposure (B8.4c)', () => {
  it('is unmeasurable, never "no friction"', () => {
    const result = measureFriction({ problem: { organizationId: 'b84c0000-0000-4000-8000-000000000001',
      signalKind: 'recurring_deterministic_failure', code: 'validator_rule:x' },
      windows: measurementWindows(DEPLOYED, '2026-10-15T00:00:00.000Z')!, producerClassification: {}, fixDimensions: [],
      readTruncated: false, exposureUndefined: true, units: [] });
    expect(result).toMatchObject({ ok: true, measurement: { outcome: 'unmeasurable', reasons: ['exposure_not_defined'] } });
  });
});

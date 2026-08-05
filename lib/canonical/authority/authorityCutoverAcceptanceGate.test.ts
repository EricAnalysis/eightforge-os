/**
 * Phase 3 acceptance gate for the canonical Project Truth authority cutover.
 *
 * Four required cases plus determinism, run against the strongest deterministic
 * evidence available in-repo:
 *
 *  1. Golden — the real Golden-derived authored transport pricing rows
 *     (`lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json`, pinned
 *     to sourcePdfSha256 922161a5… of the Williamson corpus PDF). No external
 *     corpus or GOLDEN_CORPUS_ROOT is required, so this gate is reproducible on
 *     any checkout.
 *  2. Cross-document pricing — governing vs non-governing document rows.
 *  3. Missing / malformed governing pricing.
 *  4. Simulated publication failure.
 *  5. Repeated-run determinism.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { adaptProjectTruthPublicationSource } from '@/lib/canonical/publication/projectTruthShadowAdapter';
import type { ProjectTruthPublicationSource } from '@/lib/canonical/publication/projectTruthPublicationSource';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ValidatorResult } from '@/types/validator';

import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from './projectTruthAuthorityMode';
import { buildProjectTruthAuthorityMetadata } from './canonicalExecutionContext';
import { resolveProjectTruthAuthority } from './resolveProjectTruthAuthority';

const CANONICAL = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' } as const;
const LEGACY = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'legacy' } as const;

const GOLDEN_FIXTURE_PATH = join(
  process.cwd(),
  'lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json',
);

type GoldenFixture = {
  readonly schemaVersion: string;
  readonly sourcePdfSha256: string;
  readonly rows: readonly ContractPricingAssemblyRow[];
};

function loadGoldenFixture(): GoldenFixture {
  return JSON.parse(readFileSync(GOLDEN_FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

function goldenInput(env: Readonly<Record<string, string | undefined>> = CANONICAL) {
  const fixture = loadGoldenFixture();
  return {
    projectId: 'golden-williamson',
    assembledContractPricingRows: fixture.rows,
    pricingContext: { documentId: 'williamson-contract', scheduleId: 'exhibit-a', scheduleName: 'Exhibit A' },
    legacyRateScheduleItems: [],
    sourceArtifactSnapshotDigest: fixture.sourcePdfSha256,
    env,
  } as Parameters<typeof resolveProjectTruthAuthority>[0];
}

// ── Case 1: Golden ──────────────────────────────────────────────────────────

describe('acceptance gate 1 — Golden Project', () => {
  it('uses the real Golden fixture pinned to the Williamson corpus PDF', () => {
    const fixture = loadGoldenFixture();

    expect(fixture.schemaVersion).toBe('canonical_pricing_dimension_artifact:v1');
    expect(fixture.sourcePdfSha256)
      .toBe('922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f');
    expect(fixture.rows.length).toBeGreaterThan(0);
  });

  it('preserves every Golden governing pricing row under canonical authority', () => {
    const fixture = loadGoldenFixture();
    const context = resolveProjectTruthAuthority(goldenInput());

    expect(context.assemblyStatus).toBe('assembled');
    const items = context.validatorProjection!.rateScheduleItems;
    // No Golden row is silently dropped by the canonical projection.
    expect(items).toHaveLength(fixture.rows.length);
  });

  it('preserves Golden rate, unit, and description values exactly', () => {
    const fixture = loadGoldenFixture();
    const context = resolveProjectTruthAuthority(goldenInput());
    const items = context.validatorProjection!.rateScheduleItems;

    for (const row of fixture.rows) {
      const projected = items.find((item) => item.description === row.description);
      expect(projected, `Golden row missing: ${row.description}`).toBeDefined();
      // Canonical authority must not alter approved authoritative values.
      expect(projected!.rate_amount).toBe(row.rate);
      expect(projected!.unit_type).toBe(row.unit);
    }
  });

  it('carries the authored-correction quarantine through to validator inputs', () => {
    const fixture = loadGoldenFixture();
    // Every row in this Golden slice is an authored display correction.
    expect(fixture.rows.every((row) => row.authoredValueCorrection === true)).toBe(true);

    const context = resolveProjectTruthAuthority(goldenInput());
    const items = context.validatorProjection!.rateScheduleItems;

    // The A12/F-04 authored-row boundary must survive the canonical projection,
    // otherwise canonical mode would approve rows legacy mode quarantined.
    expect(items.every((item) => item.authoredValueCorrection === true)).toBe(true);
    expect(items.every((item) => item.authored_unverified === true)).toBe(true);
    expect(items.every((item) => item.authored_quarantine?.finding === 'F-04')).toBe(true);
  });

  it('produces the same Golden row count in legacy and canonical mode', () => {
    const fixture = loadGoldenFixture();
    const canonical = resolveProjectTruthAuthority(goldenInput(CANONICAL));
    // Legacy mode passes its supplied items through; supply the same count so a
    // divergence in canonical projection would show up as a count mismatch.
    const legacy = resolveProjectTruthAuthority({
      ...goldenInput(LEGACY),
      legacyRateScheduleItems: fixture.rows.map((row) => ({
        source_document_id: 'williamson-contract',
        record_id: row.id,
        rate_code: null,
        unit_type: row.unit,
        rate_amount: row.rate,
        material_type: null,
        description: row.description,
        raw_value: null,
      })) as never,
    });

    expect(canonical.validatorProjection!.rateScheduleItems)
      .toHaveLength(legacy.validatorProjection?.rateScheduleItems.length ?? fixture.rows.length);
  });
});

// ── Case 2: cross-document pricing ──────────────────────────────────────────

function crossDocumentRows(): readonly ContractPricingAssemblyRow[] {
  const golden = loadGoldenFixture().rows;
  return golden.map((row, index) => ({
    ...row,
    id: `${row.id}:cross-${String(index)}`,
  }));
}

describe('acceptance gate 2 — cross-document pricing', () => {
  it('attributes every canonical rate row to the governing document', () => {
    const context = resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: crossDocumentRows(),
      pricingContext: { documentId: 'governing-exhibit-a', scheduleId: 'sched', scheduleName: 'Exhibit A' },
    });

    expect(context.assemblyStatus).toBe('assembled');
    const items = context.validatorProjection!.rateScheduleItems;
    expect(items.length).toBeGreaterThan(0);
    // Provenance is mandatory and resolves to the governing source, never an
    // arbitrary attached document.
    expect(items.every((item) => item.source_document_id === 'governing-exhibit-a')).toBe(true);
  });

  it('performs no validator-local rate rediscovery that could compete', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      resolveProjectTruthAuthority({
        ...goldenInput(),
        assembledContractPricingRows: crossDocumentRows(),
      });
      // Exactly one selection pass. A second would be a competing authority.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a distinct registry digest per governing document', () => {
    const first = resolveProjectTruthAuthority({
      ...goldenInput(),
      pricingContext: { documentId: 'doc-a', scheduleId: 's', scheduleName: 'A' },
    });
    const second = resolveProjectTruthAuthority({
      ...goldenInput(),
      pricingContext: { documentId: 'doc-b', scheduleId: 's', scheduleName: 'A' },
    });

    expect(first.registryDigest).not.toBe(second.registryDigest);
  });
});

// ── Case 3: missing or malformed governing pricing ──────────────────────────

describe('acceptance gate 3 — missing or malformed governing pricing', () => {
  it('returns an honest blocked result when no governing pricing exists', () => {
    const context = resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: [],
    });

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.blockReason).toBe('missing_governing_pricing');
    expect(context.validatorProjection).toBeNull();
  });

  it('does not use a legacy compatibility fallback when pricing is missing', () => {
    const context = resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: [],
      // A full legacy set is available and must be refused.
      legacyRateScheduleItems: [{
        source_document_id: 'legacy-doc',
        record_id: 'legacy-rescue',
        rate_code: null,
        unit_type: 'CYD',
        rate_amount: 1.23,
        material_type: null,
        description: 'LEGACY RESCUE ROW',
        raw_value: null,
      }] as never,
    });

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.validatorProjection).toBeNull();
    expect(JSON.stringify(context)).not.toContain('LEGACY RESCUE ROW');
  });

  it('preserves the source gap so an operator can triage the cause', () => {
    const context = resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: [],
      pricingContext: { documentId: 'missing-exhibit', scheduleId: null, scheduleName: null },
    });

    expect(context.block?.sourceGaps).toEqual(['missing-exhibit']);
    expect(context.block?.detail.length).toBeGreaterThan(0);
  });

  it('blocks on malformed rows rather than inventing governing pricing', () => {
    const malformed = [{
      id: 'malformed-1',
      category: null,
      description: '',
      route: null,
      distanceBand: null,
      unit: null,
      rate: null,
      page: null,
      sourceAnchor: null,
      confidence: 'low',
      authoredValueCorrection: false,
    }] as unknown as readonly ContractPricingAssemblyRow[];

    const context = resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: malformed,
    });

    if (context.assemblyStatus === 'assembled') {
      // If anything projected, it must carry no fabricated rate value.
      for (const item of context.validatorProjection!.rateScheduleItems) {
        expect(item.rate_amount).toBeNull();
      }
    } else {
      expect(context.assemblyStatus).toBe('blocked');
      expect(context.blockReason).toBe('missing_governing_pricing');
    }
  });

  it('records the block reason in persisted authority metadata', () => {
    const metadata = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority({
      ...goldenInput(),
      assembledContractPricingRows: [],
    }));

    expect(metadata.projectTruthAuthorityMode).toBe('canonical');
    expect(metadata.canonicalAssemblyStatus).toBe('blocked');
    expect(metadata.canonicalAssemblyBlockReason).toBe('missing_governing_pricing');
  });
});

// ── Case 4: simulated publication failure ───────────────────────────────────

const RESULT: ValidatorResult = {
  status: 'FINDINGS_OPEN',
  blocked_reasons: [],
  findings: [],
  rulesApplied: ['financial_integrity'],
  summary: {},
  validator_status: 'findings_open',
  validator_open_items: 2,
  validator_blockers: 0,
  exposure: {
    total_billed_amount: 1000,
    total_contract_supported_amount: 900,
    total_transaction_supported_amount: 850,
    total_at_risk_amount: 100,
  },
} as unknown as ValidatorResult;

function publicationSource(
  registry: unknown,
): ProjectTruthPublicationSource {
  return {
    project: { id: 'golden-williamson', organization_id: 'org-1' },
    documents: [{ id: 'williamson-contract' }],
    governingDocumentIds: { contract: ['williamson-contract'] },
    assembledContractPricingRows: loadGoldenFixture().rows,
    pricingContext: { documentId: 'williamson-contract' },
    invoices: [],
    invoiceLines: [],
    invoiceLineToRateMap: new Map(),
    persistedFindings: [],
    sourceArtifactSnapshot: [],
    effectiveResult: RESULT,
    authoritativeRegistry: registry,
  } as unknown as ProjectTruthPublicationSource;
}

describe('acceptance gate 4 — simulated publication failure', () => {
  it('classifies a forced publication failure instead of throwing', async () => {
    const { publishProjectTruthShadow } = await import(
      '@/lib/canonical/publication/publishProjectTruthShadow'
    );
    const context = resolveProjectTruthAuthority(goldenInput());

    // Drive the real publisher and force its adaptation stage to fail.
    const result = await publishProjectTruthShadow(
      {
        projectId: 'golden-williamson',
        runId: 'run-1',
        triggerSource: 'manual',
        inputsSnapshotHash: 'snapshot-hash',
        validatorInput: {
          project: { id: 'golden-williamson', organization_id: 'org-1' },
          documents: [],
          governingDocumentIds: {},
          assembledContractPricingRows: loadGoldenFixture().rows,
          contractValidationContext: null,
          invoices: [],
          invoiceLines: [],
          invoiceLineToRateMap: new Map(),
          sourceArtifactSnapshot: [],
          projectTruthAuthority: context,
        },
        effectiveResult: RESULT,
        persistedFindings: [],
      } as never,
      {
        loadValidationRun: async () => ({
          id: 'run-1',
          status: 'complete',
          run_at: '2026-08-04T00:00:00.000Z',
          completed_at: '2026-08-04T00:00:01.000Z',
          triggered_by: 'manual',
          triggered_by_user_id: null,
          rule_version: '1.0.0',
          inputs_snapshot_hash: 'snapshot-hash',
        }) as never,
        adaptSource: () => {
          throw new Error('simulated publication adaptation failure');
        },
      },
    );

    // The publisher normalizes its own failures. It never propagates them into
    // the caller, which is what keeps validation outcomes independent.
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('simulated publication adaptation failure');
    }
  });

  it('leaves findings, exposure, and clearance untouched across a publication failure', async () => {
    const { publishProjectTruthShadow } = await import(
      '@/lib/canonical/publication/publishProjectTruthShadow'
    );
    const context = resolveProjectTruthAuthority(goldenInput());
    const findingsBefore = JSON.stringify(RESULT.findings);
    const exposureBefore = JSON.stringify(RESULT.exposure);
    const statusBefore = RESULT.validator_status;
    const blockersBefore = RESULT.validator_blockers;

    await publishProjectTruthShadow(
      {
        projectId: 'golden-williamson',
        runId: 'run-2',
        triggerSource: 'manual',
        inputsSnapshotHash: 'snapshot-hash',
        validatorInput: {
          project: { id: 'golden-williamson', organization_id: 'org-1' },
          documents: [],
          governingDocumentIds: {},
          assembledContractPricingRows: loadGoldenFixture().rows,
          contractValidationContext: null,
          invoices: [],
          invoiceLines: [],
          invoiceLineToRateMap: new Map(),
          sourceArtifactSnapshot: [],
          projectTruthAuthority: context,
        },
        effectiveResult: RESULT,
        persistedFindings: [],
      } as never,
      {
        loadValidationRun: async () => { throw new Error('simulated source_run failure'); },
      },
    );

    expect(JSON.stringify(RESULT.findings)).toBe(findingsBefore);
    expect(JSON.stringify(RESULT.exposure)).toBe(exposureBefore);
    expect(RESULT.validator_status).toBe(statusBefore);
    expect(RESULT.validator_blockers).toBe(blockersBefore);
    // Authority is unaffected by the publication outcome.
    expect(context.assemblyStatus).toBe('assembled');
    expect(context.authorityMode).toBe('canonical');
  });

  it('keeps the persisted authority mode canonical after a publication failure', () => {
    const context = resolveProjectTruthAuthority(goldenInput());
    const metadata = buildProjectTruthAuthorityMetadata(context);

    // Publication status is operational metadata only and lives outside the
    // authority fields, so it cannot downgrade the recorded authority.
    expect(metadata.projectTruthAuthorityMode).toBe('canonical');
    expect(metadata.canonicalAssemblyStatus).toBe('assembled');
    expect(metadata.canonicalRegistryDigest).toBe(context.registryDigest);
    expect(Object.keys(metadata)).not.toContain('publicationStatus');
  });

  it('does not let a failing publication adapter corrupt the frozen registry', () => {
    const context = resolveProjectTruthAuthority(goldenInput());
    const digestBefore = context.registryDigest;

    try {
      adaptProjectTruthPublicationSource(publicationSource(context.registry));
    } catch {
      // Even on failure the authority object must be unchanged.
    }

    expect(context.registryDigest).toBe(digestBefore);
    expect(Object.isFrozen(context.registry)).toBe(true);
  });

  it('still yields a usable validation result when publication is disabled', () => {
    const context = resolveProjectTruthAuthority(goldenInput({
      ...CANONICAL,
      EIGHTFORGE_CANONICAL_SHADOW_PUBLISH: 'off',
    }));

    expect(context.assemblyStatus).toBe('assembled');
    expect(context.validatorProjection!.rateScheduleItems.length).toBeGreaterThan(0);
  });
});

// ── Case 5: determinism ─────────────────────────────────────────────────────

describe('acceptance gate 5 — determinism', () => {
  it('produces identical canonical and source-snapshot digests across runs', () => {
    const first = resolveProjectTruthAuthority(goldenInput());
    const second = resolveProjectTruthAuthority(goldenInput());

    expect(first.registryDigest).toBe(second.registryDigest);
    expect(first.sourceArtifactSnapshotDigest).toBe(second.sourceArtifactSnapshotDigest);
  });

  it('produces identical normalized facts across runs', () => {
    const first = resolveProjectTruthAuthority(goldenInput());
    const second = resolveProjectTruthAuthority(goldenInput());

    expect(JSON.stringify(first.validatorProjection))
      .toBe(JSON.stringify(second.validatorProjection));
  });

  it('produces identical persisted authority metadata across runs', () => {
    const first = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(goldenInput()));
    const second = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(goldenInput()));

    expect(first).toEqual(second);
  });

  it('never mixes legacy and canonical authority within one resolution', () => {
    const canonical = resolveProjectTruthAuthority({
      ...goldenInput(CANONICAL),
      legacyRateScheduleItems: [{
        source_document_id: 'legacy-doc',
        record_id: 'legacy-mixed',
        rate_code: null,
        unit_type: 'CYD',
        rate_amount: 7.77,
        material_type: null,
        description: 'LEGACY MIXED ROW',
        raw_value: null,
      }] as never,
    });

    expect(canonical.authorityMode).toBe('canonical');
    const items = canonical.validatorProjection!.rateScheduleItems;
    expect(items.some((item) => item.record_id === 'legacy-mixed')).toBe(false);
    expect(items.every((item) => item.source_document_id === 'williamson-contract')).toBe(true);
  });
});

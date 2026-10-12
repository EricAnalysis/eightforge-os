import { describe, expect, it } from 'vitest';

import {
  attributeExtraction,
  attributeForgewingProposal,
  attributeHumanFactAssertion,
  attributeValidatorFindingCorrection,
  attributeValidatorRun,
  customerMappingConfiguration,
  ruleCatalogueConfiguration,
} from '@/lib/improvementAttribution';
import { MeasurementUnitSchema } from '@/lib/improvementMeasurement';

const PRODUCED = 'a'.repeat(40);
const CURRENT = 'f'.repeat(40);
const DOC = 'b84b0000-0000-4000-8000-000000000501';
const EXTRACTION = 'b84b0000-0000-4000-8000-000000000502';
const RUN = 'b84b0000-0000-4000-8000-000000000503';
const ORG = 'b84b0000-0000-4000-8000-000000000504';
const extractionData = (revision: string | null, environment = 'production') => ({ extraction: { runtime_identity_v1: {
  identity: { schema: 'extraction_runtime_identity_v1', deployment_revision: revision, deployment_environment: environment },
} } });
const produced = { status: 'attributed', producer: { kind: 'deployment_revision', revision: PRODUCED } };

describe('producer attribution from recorded history (B8.4b)', () => {
  it('reads a Validator run and an extraction by what they recorded, production only', () => {
    expect(attributeValidatorRun({ id: RUN, deployment_revision: PRODUCED, deployment_environment: 'production' })).toEqual(produced);
    expect(attributeValidatorRun({ id: RUN, deployment_revision: null, deployment_environment: null }))
      .toEqual({ status: 'unattributed', reason: 'producer_not_recorded' });
    expect(attributeValidatorRun({ id: RUN, deployment_revision: PRODUCED, deployment_environment: 'preview' }))
      .toEqual({ status: 'unattributed', reason: 'non_production_producer' });
    expect(attributeExtraction(extractionData(PRODUCED))).toEqual(produced);
    // 64 of 68 historical extractions predate runtime identity: not recorded, never guessed.
    expect(attributeExtraction({ extraction: {} })).toEqual({ status: 'unattributed', reason: 'producer_not_recorded' });
  });

  it('gives a finding override the revision of the run that raised the finding, not the current deployment', () => {
    const run = { id: RUN, deployment_revision: PRODUCED, deployment_environment: 'production' };
    expect(attributeValidatorFindingCorrection({ finding: { id: 'f1', run_id: RUN }, run })).toEqual(produced);
    expect(attributeValidatorFindingCorrection({ finding: { id: 'f1', run_id: RUN },
      run: { ...run, id: 'b84b0000-0000-4000-8000-000000000599', deployment_revision: CURRENT } }))
      .toEqual({ status: 'unattributed', reason: 'historical_source_unproven' });
    expect(attributeValidatorFindingCorrection({ finding: { id: 'f1', run_id: RUN }, run: null }))
      .toEqual({ status: 'unattributed', reason: 'historical_source_unproven' });
  });

  it('gives a reviewed value the extraction its proposal pinned, and nothing when that link is absent', () => {
    const assertion = { source_document_id: DOC, forgewing_proposal_id: 'proposal-1' };
    const proposal = { proposal_id: 'proposal-1', source_document_id: DOC, extraction_snapshot_id: EXTRACTION };
    const extraction = { id: EXTRACTION, document_id: DOC, data: extractionData(PRODUCED) };
    expect(attributeHumanFactAssertion({ assertion, proposal, extraction })).toEqual(produced);
    const unproven = { status: 'unattributed', reason: 'historical_source_unproven' };
    // A manual correction with no recorded source extraction.
    expect(attributeHumanFactAssertion({ assertion: { ...assertion, forgewing_proposal_id: null }, proposal: null,
      extraction: null })).toEqual(unproven);
    // A newer extraction of the same document is not the evidence that was corrected.
    expect(attributeHumanFactAssertion({ assertion, proposal,
      extraction: { ...extraction, id: 'b84b0000-0000-4000-8000-000000000598', data: extractionData(CURRENT) } }))
      .toEqual(unproven);
    expect(attributeHumanFactAssertion({ assertion, proposal: { ...proposal, source_document_id: ORG }, extraction }))
      .toEqual(unproven);
  });

  it('identifies a Forgewing outcome by provider, model and prompt, not the app commit', () => {
    const proposal = { task_type: 'value_reading', schema_version: '3', provider_model: 'provider-model-a',
      prompt_template_id: 'value-reading', prompt_template_version: '2' };
    const a = attributeForgewingProposal(proposal);
    expect(a).toMatchObject({ status: 'attributed', producer: { kind: 'forgewing_request' } });
    expect(attributeForgewingProposal({ ...proposal })).toEqual(a);
    expect(attributeForgewingProposal({ ...proposal, prompt_template_version: '3' })).not.toEqual(a);
    expect(attributeForgewingProposal({ ...proposal, provider_model: 'provider-model-b' })).not.toEqual(a);
    expect(attributeForgewingProposal({ ...proposal, prompt_template_id: '' }))
      .toEqual({ status: 'unattributed', reason: 'producer_not_recorded' });
  });

  it('every attribution is a valid B8.4a measurement unit attribution', () => {
    for (const attribution of [produced, attributeExtraction({}), attributeForgewingProposal({})]) {
      expect(MeasurementUnitSchema.safeParse({ unitRef: 'u:1', observedAt: '2026-10-01T00:00:00Z', attribution,
        configuration: {}, occurred: false }).success).toBe(true);
    }
  });
});

describe('configuration identity (B8.4b)', () => {
  const pin = (revisionId: string, digest: string) => ({ version: 'customer_header_mapping_pin_v1', organizationId: ORG,
    documentType: 'invoice', revisionId, digest, sourceSchemaIdentity: `customer-header-schema-v1:${'1'.repeat(64)}`,
    physicalPageNumber: 1, columnIndex: 0, sourceLabel: 'Rate',
    orderedObservationIds: [`pdf:layout-token:v1:${'2'.repeat(64)}`], pageRepresentationDigest: '3'.repeat(64) });

  it('keeps the exact historical B8.2 mapping revision and digest', () => {
    const revision = 'b84b0000-0000-4000-8000-000000000601';
    expect(customerMappingConfiguration({ extractionSnapshotId: EXTRACTION,
      mappingPins: [pin(revision, '4'.repeat(64)), { ...pin(revision, '4'.repeat(64)), columnIndex: 1 }] }))
      .toBe(`${revision}:${'4'.repeat(64)}`);
    const mixed = customerMappingConfiguration({ extractionSnapshotId: EXTRACTION,
      mappingPins: [pin(revision, '4'.repeat(64)), pin('b84b0000-0000-4000-8000-000000000602', '5'.repeat(64))] });
    expect(mixed).toMatch(/^mapping_set:sha256:[a-f0-9]{64}$/);
    expect(customerMappingConfiguration(undefined)).toBeNull();
  });

  it('reads the stamped catalogue fingerprint and nothing else', () => {
    const fingerprint = `rule-catalogue-v1:sha256:${'6'.repeat(64)}`;
    expect(ruleCatalogueConfiguration({ rule_catalogue_fingerprint: fingerprint })).toBe(fingerprint);
    expect(ruleCatalogueConfiguration({ rule_catalogue_fingerprint: null })).toBeNull();
    expect(ruleCatalogueConfiguration({ rule_catalogue_fingerprint: 'rule-explanation-v1:sha256:00' })).toBeNull();
  });
});

import { CustomerMappingEvidenceSchema } from '@/lib/customerAdaptation/headerMappingEvidence';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { MeasurementUnit } from '@/lib/improvementMeasurement';

/**
 * B8.4b: who actually produced a measured unit, from the records that were
 * written when it was produced. Pure: no IO, no clock, and never the identity
 * of the deployment, configuration or mapping current at read time.
 *
 * - Validator outcomes: the run's stamped deployment revision.
 * - Extraction outcomes: the extraction's recorded runtime identity.
 * - Human corrections inherit the producer of the evidence they corrected,
 *   never the deployment running when the person clicked Correct:
 *   - a Validator finding override -> the finding's own run;
 *   - a reviewed value -> the source extraction pinned on the assertion at
 *     correction time (server-derived; a cited proposal's pinned extraction
 *     when there is one), with the revision that extraction recorded;
 *   - an older assertion without that pin -> its cited proposal's pinned
 *     extraction, if any.
 *   A correction whose source cannot be proven stays unattributed
 *   (`historical_source_unproven`); it is excluded from measurement, never
 *   given a guess.
 * - Forgewing outcomes: the provider/model/prompt identity of the proposal,
 *   not merely the application commit.
 * - Customer mapping: the exact historical B8.2 revision ID and digest pinned
 *   in the evidence.
 */

export type UnitAttribution = MeasurementUnit['attribution'];

export const MEASUREMENT_CONFIGURATION_DIMENSIONS = Object.freeze({
  customerMapping: 'customer_mapping_revision',
  ruleCatalogue: 'rule_catalogue',
} as const);

const SHA1 = /^[a-f0-9]{40}$/;
const unattributed = (reason: Extract<UnitAttribution, { status: 'unattributed' }>['reason']): UnitAttribution =>
  ({ status: 'unattributed', reason });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A recorded deployment identity: production only; anything malformed or absent is "not recorded". */
export function attributeDeploymentIdentity(identity: unknown): UnitAttribution {
  const value = record(identity);
  const revision = value?.deployment_revision;
  if (typeof revision !== 'string' || !SHA1.test(revision)) return unattributed('producer_not_recorded');
  if (value?.deployment_environment !== 'production') return unattributed('non_production_producer');
  return { status: 'attributed', producer: { kind: 'deployment_revision', revision } };
}

/** A Validator run row (`project_validation_runs`), as stamped at insert. */
export function attributeValidatorRun(run: unknown): UnitAttribution {
  return attributeDeploymentIdentity(run);
}

/** A `document_extractions.data` blob: its `runtime_identity_v1` recorded at extraction time. */
export function attributeExtraction(extractionData: unknown): UnitAttribution {
  const runtime = record(record(record(extractionData)?.extraction)?.runtime_identity_v1);
  return attributeDeploymentIdentity(runtime?.identity);
}

/** An operator override of a Validator finding inherits the run that raised the finding. */
export function attributeValidatorFindingCorrection(input: Readonly<{
  finding: Readonly<{ id: string; run_id: string | null }>;
  run: Readonly<{ id: string }> & Record<string, unknown> | null;
}>): UnitAttribution {
  if (!input.finding.run_id || !input.run || input.run.id !== input.finding.run_id) {
    return unattributed('historical_source_unproven');
  }
  return attributeValidatorRun(input.run);
}

/**
 * A human fact assertion inherits the extraction that produced the evidence it
 * corrected. Preferred: the source extraction and revision pinned on the
 * assertion when it was recorded (B8.4b). An assertion pinned to an extraction
 * that recorded no revision has a proven source but no recorded producer.
 * Fallback for older rows: the cited Forgewing proposal's pinned extraction.
 */
export function attributeHumanFactAssertion(input: Readonly<{
  assertion: Readonly<{
    source_document_id: string;
    forgewing_proposal_id: string | null;
    source_extraction_id?: string | null;
    source_deployment_revision?: string | null;
    source_deployment_environment?: string | null;
  }>;
  proposal?: Readonly<{ proposal_id: string; source_document_id: string; extraction_snapshot_id: string }> | null;
  extraction?: Readonly<{ id: string; document_id: string; data: unknown }> | null;
}>): UnitAttribution {
  const { assertion, proposal, extraction } = input;
  if (assertion.source_extraction_id) {
    return attributeDeploymentIdentity({ deployment_revision: assertion.source_deployment_revision,
      deployment_environment: assertion.source_deployment_environment });
  }
  if (!assertion.forgewing_proposal_id || !proposal || proposal.proposal_id !== assertion.forgewing_proposal_id
    || proposal.source_document_id !== assertion.source_document_id || !extraction
    || extraction.id !== proposal.extraction_snapshot_id || extraction.document_id !== assertion.source_document_id) {
    return unattributed('historical_source_unproven');
  }
  return attributeExtraction(extraction.data);
}

export const FORGEWING_PRODUCER_IDENTITY_VERSION = 'forgewing_producer_v1' as const;

/** The provider/model/prompt identity a Forgewing proposal was generated under. */
export function attributeForgewingProposal(proposal: Readonly<Record<string, unknown>>): UnitAttribution {
  const fields = ['task_type', 'schema_version', 'provider_model', 'prompt_template_id', 'prompt_template_version'] as const;
  const values = fields.map((field) => proposal[field]);
  if (values.some((value) => typeof value !== 'string' || value.trim() === '')) return unattributed('producer_not_recorded');
  const [taskType, schemaVersion, providerModel, promptTemplateId, promptTemplateVersion] = values as string[];
  return { status: 'attributed', producer: { kind: 'forgewing_request', identityDigest: hashCanonical({
    domain: 'eightforge.forgewing-producer', version: FORGEWING_PRODUCER_IDENTITY_VERSION,
    taskType, schemaVersion, providerModel, promptTemplateId, promptTemplateVersion,
  }) } };
}

/**
 * The exact B8.2 mapping revision(s) pinned in customer mapping evidence, as
 * one configuration value: `<revisionId>:<digest>`, or a digest of the sorted
 * set when several revisions applied. Null when no mapping was used.
 */
export function customerMappingConfiguration(evidence: unknown): string | null {
  const parsed = CustomerMappingEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return null;
  const revisions = [...new Set(parsed.data.mappingPins.map((pin) => `${pin.revisionId}:${pin.digest}`))].sort();
  return revisions.length === 1 ? revisions[0]! : `mapping_set:sha256:${hashCanonical(revisions)}`;
}

/** The rule catalogue fingerprint a Validator run was stamped with, or null. */
export function ruleCatalogueConfiguration(run: unknown): string | null {
  const fingerprint = record(run)?.rule_catalogue_fingerprint;
  return typeof fingerprint === 'string' && /^rule-catalogue-v1:sha256:[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint : null;
}

import { describe, expect, it } from 'vitest';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { deriveSourceFieldId } from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT,
  FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION,
  FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION,
  forgewingPricingV2HumanAttestationDigest,
  forgewingPricingV2HumanLabelPackageDigest,
  type ForgewingPricingV2AcceptedPhaseBBinding,
  type ForgewingPricingV2HumanLabelPackage,
  type ForgewingPricingV2HumanLabelPackageBody,
  type ForgewingPricingV2ValidatedPhaseBScope,
  validateForgewingPricingV2AcceptedPhaseBArtifact,
  validateForgewingPricingV2HumanLabelPackage,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabels';

const PREPARATION_COMMIT = '1'.repeat(40);
const WORKFLOW_COMMIT = '2'.repeat(40);
const REVIEWED_AT = '2026-08-27T12:00:00.000Z';
const CONTEXT = { sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
  physicalPageNumber: 4, rowObservationId: 'row-1' };
const MEMBERS = ['observation-currency', 'observation-value'];
const FIELD_ID = deriveSourceFieldId({ ...CONTEXT, sourceFieldRole: 'rate',
  sourceObservationIds: MEMBERS });

function signedArtifact(orderingDeterministic = true) {
  const preparationBase = {
    reportVersion: 'forgewing-pricing-proposal-v2-preparation-v1',
    authority: 'non_authoritative_preparation', providerCalls: 0,
    promotionEvidence: false, promotionAuthorized: false,
    source: { sourceDocumentId: CONTEXT.sourceDocumentId,
      sourceArtifactId: CONTEXT.sourceArtifactId },
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2',
    v1Compatibility: { orderingDeterministic },
    fields: { count: 1, sourceFieldIds: [FIELD_ID] },
    rows: [{ rowObservationId: CONTEXT.rowObservationId, context: CONTEXT,
      exactMembershipClosure: true,
      fields: [{ field: { sourceFieldId: FIELD_ID, sourceFieldRole: 'rate',
        authoredRawText: '$ 5.00', sourceObservationIds: MEMBERS, physicalPageNumber: 4 },
      primitiveEvidence: MEMBERS.map((observationId) => ({ observationId,
        sourceDocumentId: CONTEXT.sourceDocumentId, sourceArtifactId: CONTEXT.sourceArtifactId,
        physicalPageNumber: 4, rawText: observationId })) }] }],
  };
  const preparation = { ...preparationBase,
    preparationDigestSha256: hashCanonical(preparationBase) };
  const reportBase = {
    reportVersion: 'forgewing-pricing-proposal-v2-phase-b-v1',
    authority: 'non_authoritative_preparation', providerCalls: 0,
    promotionEvidence: false, promotionAuthorized: false,
    implementation: { commit: PREPARATION_COMMIT, worktreeDirty: false },
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2',
    sources: [{ preparation }], combinedSourceFieldCount: 1,
    combinedDuplicateSourceFieldIds: [] as string[], limitations: [] as string[],
  };
  const report = { ...reportBase, reportDigestSha256: hashCanonical(reportBase) };
  const artifactBytes = Buffer.from(`${canonicalJson(report)}\n`, 'utf8');
  const expected: ForgewingPricingV2AcceptedPhaseBBinding = {
    preparationArtifactSha256: sha256Hex(artifactBytes),
    reportDigestSha256: report.reportDigestSha256,
    preparationImplementationCommit: PREPARATION_COMMIT,
    expectedPreparationDigests: [preparation.preparationDigestSha256],
    expectedRowCount: 1, expectedFieldCount: 1, expectedMemberObservationCount: 2,
    expectedSourceFieldIds: [FIELD_ID],
  };
  return { artifactBytes, expected };
}

function acceptedScope(): ForgewingPricingV2ValidatedPhaseBScope {
  const fixture = signedArtifact();
  const result = validateForgewingPricingV2AcceptedPhaseBArtifact(fixture);
  if (result.status !== 'valid') throw new Error(result.violations.join(','));
  return result.value;
}

function completedPackage(
  scope: ForgewingPricingV2ValidatedPhaseBScope,
): ForgewingPricingV2HumanLabelPackage {
  const body: ForgewingPricingV2HumanLabelPackageBody = {
    packageVersion: FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION,
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2',
    preparationArtifactSha256: scope.preparationArtifactSha256,
    preparationReportDigestSha256: scope.reportDigestSha256,
    preparationImplementationCommit: scope.preparationImplementationCommit,
    implementationCommit: WORKFLOW_COMMIT,
    scope: { rowCount: 1, fieldCount: 1, memberObservationCount: 2,
      labelledContributionCount: 2,
      sourceFieldIdsSha256: hashCanonical([FIELD_ID]) },
    fields: [{ sourceFieldId: FIELD_ID, sourceObservationIds: MEMBERS,
      ...CONTEXT, sourceFieldRole: 'rate', expectedSemanticRole: 'rate_like_amount',
      expectedInterpretationState: 'observed',
      expectedContributions: [
        { observationId: MEMBERS[0]!, contributionRole: 'type_marker' },
        { observationId: MEMBERS[1]!, contributionRole: 'value_token' },
      ], reviewStatus: 'confirmed', semanticRoleConfirmed: true, explicitlyConfirmed: true,
      reviewer: 'reviewer-1', reviewedAt: REVIEWED_AT }],
    authority: 'evaluation_ground_truth_only', promotionAuthorized: false,
    promotionEvidence: false,
  };
  const packageDigestSha256 = forgewingPricingV2HumanLabelPackageDigest(body);
  const attestationBody = {
    statementVersion: FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION,
    statement: FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT,
    reviewer: 'reviewer-1', reviewedAt: REVIEWED_AT, confirmed: true as const,
    packageDigestSha256, preparationArtifactSha256: scope.preparationArtifactSha256,
    preparationReportDigestSha256: scope.reportDigestSha256,
    implementationCommit: WORKFLOW_COMMIT,
    authority: 'evaluation_ground_truth_only' as const,
    promotionAuthorized: false as const, promotionEvidence: false as const,
  };
  return { ...body, packageDigestSha256, attestation: { ...attestationBody,
    attestationDigestSha256: forgewingPricingV2HumanAttestationDigest(attestationBody) } };
}

function resign(value: ForgewingPricingV2HumanLabelPackage): void {
  const { packageDigestSha256: _old, attestation, ...body } = value;
  value.packageDigestSha256 = forgewingPricingV2HumanLabelPackageDigest(body);
  Object.assign(attestation, {
    packageDigestSha256: value.packageDigestSha256,
    preparationArtifactSha256: value.preparationArtifactSha256,
    preparationReportDigestSha256: value.preparationReportDigestSha256,
    implementationCommit: value.implementationCommit,
  });
  const { attestationDigestSha256: _oldAttestation, ...attestationBody } = attestation;
  attestation.attestationDigestSha256 = forgewingPricingV2HumanAttestationDigest(attestationBody);
}

function violations(value: unknown, scope = acceptedScope()) {
  const result = validateForgewingPricingV2HumanLabelPackage({ package: value, phaseB: scope,
    expectedLabelWorkflowImplementationCommit: WORKFLOW_COMMIT });
  return result.status === 'rejected' ? result.violations : [];
}

describe('Forgewing pricing V2 human field labels', () => {
  it('validates the accepted preparation and a complete exact-identity package', () => {
    const scope = acceptedScope();
    expect(scope.fields).toHaveLength(1);
    expect(validateForgewingPricingV2HumanLabelPackage({
      package: completedPackage(scope), phaseB: scope,
      expectedLabelWorkflowImplementationCommit: WORKFLOW_COMMIT,
    }).status).toBe('valid');
  });

  it('fails closed on stale artifact and nondeterministic ordering', () => {
    const stale = signedArtifact();
    stale.expected = { ...stale.expected, preparationArtifactSha256: '0'.repeat(64) };
    const staleResult = validateForgewingPricingV2AcceptedPhaseBArtifact(stale);
    expect(staleResult.status === 'rejected' && staleResult.violations)
      .toContain('artifact_sha256_mismatch');
    const unstable = validateForgewingPricingV2AcceptedPhaseBArtifact(signedArtifact(false));
    expect(unstable.status === 'rejected' && unstable.violations)
      .toContain('ordering_not_deterministic');
  });

  it('kills text/unknown linkage, missing, foreign, and duplicate contribution mutations', () => {
    const scope = acceptedScope();
    const unknown = completedPackage(scope);
    unknown.fields[0]!.sourceFieldId = 'authored raw text';
    resign(unknown);
    expect(violations(unknown, scope)).toContain('scope_mismatch');

    const missing = completedPackage(scope);
    missing.fields[0]!.expectedContributions.pop();
    missing.scope.labelledContributionCount = 1;
    resign(missing);
    expect(violations(missing, scope)).toContain('missing_contribution_label');

    const foreign = completedPackage(scope);
    foreign.fields[0]!.expectedContributions[1]!.observationId = 'foreign-observation';
    resign(foreign);
    expect(violations(foreign, scope)).toContain('foreign_observation_contribution');

    const duplicate = completedPackage(scope);
    duplicate.fields[0]!.expectedContributions[1]!.observationId = MEMBERS[0]!;
    resign(duplicate);
    expect(violations(duplicate, scope)).toContain('duplicate_contribution_label');
  });

  it('enforces policy A abstention and explicit human confirmation', () => {
    const scope = acceptedScope();
    const abstained = completedPackage(scope);
    Object.assign(abstained.fields[0]!, { expectedSemanticRole: 'unknown',
      expectedInterpretationState: 'insufficient_evidence', expectedContributions: [] });
    abstained.scope.labelledContributionCount = 0;
    resign(abstained);
    expect(violations(abstained, scope)).toEqual([]);

    const fabricated = structuredClone(abstained);
    fabricated.fields[0]!.expectedContributions.push({
      observationId: MEMBERS[0]!, contributionRole: 'unknown_contribution' });
    fabricated.scope.labelledContributionCount = 1;
    resign(fabricated);
    expect(violations(fabricated, scope)).toContain('abstention_contract_mismatch');

    const leaked = completedPackage(scope) as unknown as { fields: Array<Record<string, unknown>> };
    leaked.fields[0]!.semanticRoleConfirmed = false;
    expect(violations(leaked, scope)).toContain('package_schema_rejected');
  });

  it('requires immutable package/attestation digests, attestation, commit, and false authority flags', () => {
    const scope = acceptedScope();
    const badPackageDigest = completedPackage(scope);
    badPackageDigest.packageDigestSha256 = '0'.repeat(64);
    expect(violations(badPackageDigest, scope)).toContain('package_digest_mismatch');

    const badAttestationDigest = completedPackage(scope);
    badAttestationDigest.attestation.attestationDigestSha256 = '0'.repeat(64);
    expect(violations(badAttestationDigest, scope)).toContain('attestation_digest_mismatch');

    const absent = completedPackage(scope) as unknown as Record<string, unknown>;
    delete absent.attestation;
    expect(violations(absent, scope)).toContain('package_schema_rejected');

    const wrongCommit = completedPackage(scope);
    wrongCommit.implementationCommit = '3'.repeat(40);
    resign(wrongCommit);
    expect(violations(wrongCommit, scope)).toContain('package_binding_mismatch');

    const promoted = completedPackage(scope) as unknown as Record<string, unknown>;
    promoted.promotionAuthorized = true;
    expect(violations(promoted, scope)).toContain('package_schema_rejected');
  });
});

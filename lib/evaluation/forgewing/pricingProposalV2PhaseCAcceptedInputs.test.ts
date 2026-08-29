/** REAL ARTIFACTS, no provider. Accepted-input authentication for Phase C. */
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  authenticateForgewingV2PhaseCInputs,
  authenticateForgewingV2PhaseCInputsForMutationTests,
  ForgewingV2PhaseCAuthenticationError,
  FORGEWING_V2_PHASE_C_ACCEPTED_PINS,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCAcceptedInputs';

const ROOT = 'C:/Dev/eightforge-os/scripts/evaluation/artifacts/';
const PACKAGE = `${ROOT}local-v2-bprime-review/forgewing-pricing-v2-human-labels.completed.json`;
const PHASE_B = `${ROOT}local-v2-phase-b/phase-b-f13c815.json`;
const PACKET = `${ROOT}local-v2-bprime-review-20260827T1102Z/phase-b-prime-review-packet-fc7433a.json`;
const configured = [PACKAGE, PHASE_B, PACKET].every((path) => existsSync(path));

function bytes() {
  return {
    humanLabelPackageBytes: readFileSync(PACKAGE),
    phaseBArtifactBytes: readFileSync(PHASE_B),
    reviewPacketBytes: readFileSync(PACKET),
  };
}

function failureOf(run: () => unknown): string {
  try { run(); } catch (error) {
    if (error instanceof ForgewingV2PhaseCAuthenticationError) return error.failure;
    return `unexpected:${(error as Error).message}`;
  }
  return 'no_failure';
}

describe.skipIf(!configured)('REAL: Phase C accepted-input authentication', () => {
  it('authenticates the accepted trio and reports pinned counts', () => {
    const result = authenticateForgewingV2PhaseCInputs(bytes());
    expect(result.humanLabelPackageSha256)
      .toBe(FORGEWING_V2_PHASE_C_ACCEPTED_PINS.humanLabelPackageSha256);
    expect(result.phaseBArtifactSha256)
      .toBe(FORGEWING_V2_PHASE_C_ACCEPTED_PINS.phaseBArtifactSha256);
    expect(result.reviewPacketSha256)
      .toBe(FORGEWING_V2_PHASE_C_ACCEPTED_PINS.reviewPacketSha256);
    expect(result.fieldCount).toBe(17);
    expect(result.memberObservationCount).toBe(19);
  });

  it('rejects a SELF-CONSISTENT alternate human package', () => {
    // Internally coherent: digests recomputed so the package validates against
    // itself. It must still fail, because identity is pinned independently.
    type Rec = Record<string, unknown>;
    const original = JSON.parse(readFileSync(PACKAGE, 'utf8')) as Rec;
    const attestation = { ...(original.attestation as Rec) } as Rec;
    delete attestation.attestationDigestSha256;

    const body: Rec = { ...original };
    delete body.packageDigestSha256;
    delete body.attestation;
    body.fields = (original.fields as Rec[]).map((field, index) => index === 0
      ? { ...field, expectedSemanticRole: 'quantity_like_amount' } : field);

    const rebuiltDigest = hashCanonical(body);
    attestation.packageDigestSha256 = rebuiltDigest;
    const rebuilt: Rec = { ...body, packageDigestSha256: rebuiltDigest,
      attestation: { ...attestation, attestationDigestSha256: hashCanonical(attestation) } };

    expect(failureOf(() => authenticateForgewingV2PhaseCInputs({
      ...bytes(),
      humanLabelPackageBytes: Buffer.from(`${JSON.stringify(rebuilt, null, 2)}
`, 'utf8'),
    }))).toBe('human_label_package_sha_mismatch');
  });

  it('rejects each swapped accepted input independently', () => {
    const base = bytes();
    expect(failureOf(() => authenticateForgewingV2PhaseCInputs({
      ...base, humanLabelPackageBytes: Buffer.from('{}', 'utf8') })))
      .toBe('human_label_package_sha_mismatch');
    expect(failureOf(() => authenticateForgewingV2PhaseCInputs({
      ...base, phaseBArtifactBytes: Buffer.from('{}', 'utf8') })))
      .toBe('phase_b_artifact_sha_mismatch');
    expect(failureOf(() => authenticateForgewingV2PhaseCInputs({
      ...base, reviewPacketBytes: Buffer.from('{}', 'utf8') })))
      .toBe('review_packet_sha_mismatch');
  });

  it('rejects pin drift on every pinned identity', () => {
    const base = bytes();
    // Pin injection is only reachable through the internal mutation-test seam.
    const drift = (patch: Record<string, unknown>) => failureOf(() =>
      authenticateForgewingV2PhaseCInputsForMutationTests(base,
        { ...FORGEWING_V2_PHASE_C_ACCEPTED_PINS, ...patch } as never));
    expect(drift({ phaseBReportDigestSha256: 'f'.repeat(64) }))
      .toBe('phase_b_report_digest_mismatch');
    expect(drift({ phaseBPreparationCommit: 'a'.repeat(40) }))
      .toBe('phase_b_preparation_commit_mismatch');
    expect(drift({ labelWorkflowImplementationCommit: 'b'.repeat(40) }))
      .toBe('label_workflow_commit_mismatch');
    expect(drift({ packetVersion: 'other-version' }))
      .toBe('review_packet_version_mismatch');
    // Count drift is caught earlier by the authoritative Phase B artifact
    // validator, which receives the pinned counts as its expectations.
    expect(drift({ fieldCount: 16 })).toBe('phase_b_artifact_invalid');
    expect(drift({ memberObservationCount: 18 })).toBe('phase_b_artifact_invalid');
  });

  it('does not accept a 64-character string as packet authentication', () => {
    // The packet digest is recomputed canonically; a plausible-looking SHA is
    // not sufficient. Confirm the real packet's digest actually verifies.
    const packet = JSON.parse(readFileSync(PACKET, 'utf8')) as Record<string, unknown>;
    const { packetDigestSha256, ...unsigned } = packet;
    expect(hashCanonical(unsigned)).toBe(packetDigestSha256);
    expect(String(packetDigestSha256)).toMatch(/^[a-f0-9]{64}$/);
  });
});

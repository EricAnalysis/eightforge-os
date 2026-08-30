import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  authenticateForgewingV2PhaseCInputs,
  FORGEWING_V2_PHASE_C_ACCEPTED_PINS,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCAcceptedInputs';

/**
 * The Phase C accepted pins are sha256 hashes of the authenticated artifacts as
 * stored in Git (pure LF). End-of-line translation at checkout changes those
 * bytes, so the bounded measurement aborts before its first provider call.
 *
 * That is not hypothetical: .gitattributes was previously UTF-16 encoded, Git
 * could not parse it, its rule was inert, and system-level core.autocrlf=true
 * rewrote these artifacts to CRLF on every Windows checkout.
 *
 * These tests fail loudly if that condition returns, in either of its two
 * forms: the rule going missing, or the artifacts drifting from their pins.
 */

const ROOT = process.cwd();
const ARTIFACT_TREE = 'scripts/evaluation/artifacts';

const AUTHENTICATED_ARTIFACTS = [
  ['local-v2-bprime-review/forgewing-pricing-v2-human-labels.completed.json',
    FORGEWING_V2_PHASE_C_ACCEPTED_PINS.humanLabelPackageSha256],
  ['local-v2-phase-b/phase-b-f13c815.json',
    FORGEWING_V2_PHASE_C_ACCEPTED_PINS.phaseBArtifactSha256],
  ['local-v2-bprime-review-20260827T1102Z/phase-b-prime-review-packet-fc7433a.json',
    FORGEWING_V2_PHASE_C_ACCEPTED_PINS.reviewPacketSha256],
] as const;

function artifactPath(relative: string): string {
  return join(ROOT, ARTIFACT_TREE, relative);
}

function readArtifact(relative: string): Buffer {
  return readFileSync(artifactPath(relative));
}

describe('Phase C authenticated artifact byte stability', () => {
  it('keeps .gitattributes parseable by Git', () => {
    const bytes = readFileSync(join(ROOT, '.gitattributes'));
    // A UTF-16 BOM is the exact failure that made the previous rule inert:
    // Git reads the file as bytes and silently ignores what it cannot parse.
    expect(bytes[0]).not.toBe(0xff);
    expect(bytes[1]).not.toBe(0xfe);
    expect(bytes.includes(0x00)).toBe(false);
    // Line endings are deliberately NOT asserted here. This file is not covered
    // by its own rule, so it checks out CRLF on Windows, and Git parses that
    // correctly. Encoding, not end-of-line, is what silently broke the rule.
    const text = bytes.toString('utf8');
    expect(text).toMatch(/scripts\/evaluation\/artifacts\/\*\*[ \t]+-text/);
  });

  it('has Git suppressing end-of-line conversion for every authenticated artifact', () => {
    for (const [relative] of AUTHENTICATED_ARTIFACTS) {
      const attributes = execFileSync(
        'git',
        ['check-attr', 'text', '--', `${ARTIFACT_TREE}/${relative}`],
        { cwd: ROOT, encoding: 'utf8' },
      );
      // "unset" is -text: no conversion in either direction, on any platform.
      expect(attributes.trim()).toMatch(/text: unset$/);
    }
  });

  it('reproduces every accepted pin from the bytes on disk after a normal checkout', () => {
    for (const [relative, pin] of AUTHENTICATED_ARTIFACTS) {
      const bytes = readArtifact(relative);
      expect(sha256Hex(bytes)).toBe(pin);
      // A single CR is enough to break authentication, so assert none survive.
      expect(bytes.includes(0x0d)).toBe(false);
    }
  });

  it('authenticates the frozen inputs from unmodified disk bytes', () => {
    expect(() => authenticateForgewingV2PhaseCInputs({
      humanLabelPackageBytes: readArtifact(AUTHENTICATED_ARTIFACTS[0][0]),
      phaseBArtifactBytes: readArtifact(AUTHENTICATED_ARTIFACTS[1][0]),
      reviewPacketBytes: readArtifact(AUTHENTICATED_ARTIFACTS[2][0]),
    })).not.toThrow();
  });

  it('rejects CRLF-converted artifacts instead of measuring them', () => {
    const toCrlf = (bytes: Buffer): Buffer =>
      Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');

    const clean = {
      humanLabelPackageBytes: readArtifact(AUTHENTICATED_ARTIFACTS[0][0]),
      phaseBArtifactBytes: readArtifact(AUTHENTICATED_ARTIFACTS[1][0]),
      reviewPacketBytes: readArtifact(AUTHENTICATED_ARTIFACTS[2][0]),
    };

    // Each artifact, converted on its own, must fail closed: a CRLF checkout
    // can never be silently measured as if it were the accepted package.
    for (const key of Object.keys(clean) as (keyof typeof clean)[]) {
      const mutated = { ...clean, [key]: toCrlf(clean[key]) };
      expect(sha256Hex(mutated[key])).not.toBe(sha256Hex(clean[key]));
      expect(() => authenticateForgewingV2PhaseCInputs(mutated)).toThrow();
    }

    // And all three together, which is what a real CRLF checkout produces.
    expect(() => authenticateForgewingV2PhaseCInputs({
      humanLabelPackageBytes: toCrlf(clean.humanLabelPackageBytes),
      phaseBArtifactBytes: toCrlf(clean.phaseBArtifactBytes),
      reviewPacketBytes: toCrlf(clean.reviewPacketBytes),
    })).toThrow();
  });

  it('keeps the byte-stability rule scoped to the authenticated artifact tree', () => {
    // A repository-wide text rule would renormalize ~1094 unrelated working-tree
    // files. The rule must not reach outside the evaluation artifacts.
    const outside = execFileSync(
      'git',
      ['check-attr', 'text', '--', 'lib/evaluation/forgewing/pricingProposalV2PhaseCScoring.ts'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(outside.trim()).toMatch(/text: unspecified$/);
  });
});

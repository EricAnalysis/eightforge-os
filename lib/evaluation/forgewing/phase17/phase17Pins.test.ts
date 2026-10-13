import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';
import {
  computePhase17ContractPins,
  derivePhase17RequestContract,
  exactPromptSha256,
  lfSha256,
  PHASE17_ACCEPTED_CONTRACT_PINS,
  PHASE17_CONTRACT_FILES,
  phase17ContractPinMismatches,
  phase17PromptHasCarriageReturn,
  requestBuilderSourceDigest,
} from '@/lib/evaluation/forgewing/phase17/phase17Pins';

const PROMPT_FILE = 'lib/forgewing/prompts/recoveryCandidateV2.md';

describe('Phase 17 behavioral contract pins', () => {
  it('matches the accepted prompt, request builder, schema, task, candidate, projection, planner and policy pins', () => {
    // A failure here means a measured contract changed: any prior Phase 17
    // result no longer describes this code, and the accepted pins need review.
    expect(computePhase17ContractPins(process.cwd())).toEqual(PHASE17_ACCEPTED_CONTRACT_PINS);
  });

  it('binds the qualification to the continuation ceiling Phase 16 accepted', () => {
    expect(PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy).toMatchObject({
      version: 'phase-16-v1',
      continuationQualification: 'corpus_qualified',
      continuationQualificationCeiling: 'controlled',
    });
  });

  it('reports every drifted pin by name', () => {
    const drifted = {
      ...PHASE17_ACCEPTED_CONTRACT_PINS,
      promptSha256: '0'.repeat(64),
      operationalPolicy: { ...PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy,
        continuationQualification: 'production_qualified' },
    };
    expect(phase17ContractPinMismatches(drifted)).toEqual(['promptSha256', 'operationalPolicy']);
  });

  it('normalizes CRLF only for source-drift digests', () => {
    expect(lfSha256('a\r\nb\r\n')).toBe(lfSha256('a\nb\n'));
  });

  describe('exact prompt bytes (B1)', () => {
    it('loads LF-only prompt bytes from this checkout, equal to the committed blob', () => {
      // The Windows runtime check: what the loader returns is what Git stores.
      const runtime = loadRecoveryCandidateV2Prompt();
      expect(phase17PromptHasCarriageReturn(runtime)).toBe(false);
      expect(readFileSync(PROMPT_FILE).includes(0x0d)).toBe(false);
      const blob = execFileSync('git', ['show', `HEAD:${PROMPT_FILE}`]);
      expect(createHash('sha256').update(blob).digest('hex')).toBe(exactPromptSha256(runtime));
      expect(exactPromptSha256(runtime)).toBe(PHASE17_ACCEPTED_CONTRACT_PINS.promptSha256);
    });

    it('checks prompts out with LF on every platform', () => {
      const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', PROMPT_FILE],
        { encoding: 'utf8' });
      expect(attributes).toContain('text: set');
      expect(attributes).toContain('eol: lf');
    });

    it('never treats a CRLF prompt as the pinned prompt', () => {
      const lf = loadRecoveryCandidateV2Prompt();
      const crlf = lf.replace(/\n/g, '\r\n');
      expect(phase17PromptHasCarriageReturn(crlf)).toBe(true);
      expect(exactPromptSha256(crlf)).not.toBe(PHASE17_ACCEPTED_CONTRACT_PINS.promptSha256);
      // The source-drift digest would have hidden it; the prompt pin does not use it.
      expect(lfSha256(crlf)).toBe(lfSha256(lf));
    });
  });

  describe('request builder (M1)', () => {
    it('derives temperature, retries and every bound request field from production code', () => {
      expect(derivePhase17RequestContract(loadRecoveryCandidateV2Prompt()))
        .toEqual(PHASE17_ACCEPTED_CONTRACT_PINS.requestContract);
    });

    it('invalidates the builder pin when the marked request region changes', () => {
      const source = readFileSync(PHASE17_CONTRACT_FILES.requestBuilder, 'utf8');
      const accepted = requestBuilderSourceDigest(source);
      expect(accepted).toBe(PHASE17_ACCEPTED_CONTRACT_PINS.requestBuilderSourceSha256);
      expect(requestBuilderSourceDigest(source.replace('temperature: 0,', 'temperature: 0.2,')))
        .not.toBe(accepted);
      expect(requestBuilderSourceDigest(source.replace('maxRetries: 0,', 'maxRetries: 2,')))
        .not.toBe(accepted);
      // A Windows checkout of the same region is not drift.
      expect(requestBuilderSourceDigest(source.replace(/\r?\n/g, '\r\n'))).toBe(accepted);
      // Unrelated client code outside the region does not invalidate the pin.
      expect(requestBuilderSourceDigest(`${source}\n// unrelated trailing change\n`)).toBe(accepted);
    });

    it('refuses a source without exactly one marked region', () => {
      expect(() => requestBuilderSourceDigest('no markers here')).toThrow(/MARKERS_INVALID/);
    });
  });
});

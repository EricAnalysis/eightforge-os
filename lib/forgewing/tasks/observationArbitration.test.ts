import { describe, expect, it, vi } from 'vitest';

import {
  runForgewingObservationArbitration,
  type ForgewingObservationArbitrationInput,
} from '@/lib/forgewing/tasks/observationArbitration';

const config = {
  enabled: true,
  model: 'test-model',
  timeoutMs: 50,
  maxCalls: 1,
  maxOutputTokens: 1_200,
} as const;

function candidate(
  candidateId: string,
  rawText: string,
  overrides: Partial<ForgewingObservationArbitrationInput['regionCandidates'][number]> = {},
): ForgewingObservationArbitrationInput['regionCandidates'][number] {
  return {
    candidateId,
    organizationId: 'org-1',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    page: 1,
    boundingBox: {
      coordinateSpace: 'page_normalized', origin: 'top_left',
      x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.3, rotation: 0,
    },
    rawText,
    parser: {
      stage: candidateId.includes('ocr') ? 'ocr' : 'native_text',
      name: `parser-${candidateId}`,
      version: 'v1',
      configurationHash: `configuration-${candidateId}`,
    },
    recognitionConfidence: 0.8,
    readingOrder: 1,
    regionRole: 'text_block',
    orderedTokenIds: [`token-${candidateId}`],
    engineReportedConfidence: 0.8,
    qualitySignals: {
      glyphValidity: { value: 1, basisArtifactIds: [`token-${candidateId}`] },
      geometryCoverage: { value: 1, basisArtifactIds: [`token-${candidateId}`] },
      readingOrderConsistency: { value: 1, basisArtifactIds: [`token-${candidateId}`] },
      imageTextCoverage: null,
    },
    physicalCoordinate: {
      mappingState: 'resolved_physical_page',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'artifact-1',
      physicalPageNumber: 1,
      artifactLocalIndex: 0,
      sourceLayer: candidateId.includes('ocr') ? 'ocr' : 'pdf_native_text',
    },
    ...overrides,
  };
}

function decision(
  targetId: string,
  deterministicState: 'consensus' | 'single_source' | 'conflict' | 'unresolved',
  candidateIds: string[],
): ForgewingObservationArbitrationInput['arbitrationDecisions'][number] {
  return {
    targetId,
    organizationId: 'org-1',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    candidateIds,
    deterministicState,
    agreement: deterministicState === 'conflict' ? 0.05 : null,
    diagnostics: [`deterministic ${deterministicState}`],
  };
}

function input(): ForgewingObservationArbitrationInput {
  return {
    organizationId: 'org-1',
    sourceDocumentId: 'document-1',
    extractionSnapshotId: 'snapshot-1',
    regionCandidates: [
      candidate('candidate-native', 'Item 1 | Debris Removal | CY'),
      candidate('candidate-ocr', 'Item 1 | Debris Removal'),
    ],
    arbitrationDecisions: [
      decision('decision-1', 'conflict', ['candidate-native', 'candidate-ocr']),
    ],
  };
}

function output(value: unknown): string {
  return JSON.stringify(value);
}

describe('Forgewing observation arbitration', () => {
  it('is default-off before parsing or calling the provider', async () => {
    const provider = vi.fn(async () => { throw new Error('provider must not run'); });
    await expect(runForgewingObservationArbitration({} as never, {
      config: { ...config, enabled: false }, provider,
    })).resolves.toEqual({ status: 'skipped', reason: 'forgewing_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('requires the task flag before constructing a candidate', async () => {
    const provider = vi.fn(async () => { throw new Error('provider must not run'); });
    await expect(runForgewingObservationArbitration({} as never, {
      config, taskEnabled: false, provider,
    })).resolves.toEqual({ status: 'skipped', reason: 'observation_arbitration_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('selects a conflict before unresolved and preserves neutral candidate ordering', async () => {
    const value = input();
    value.regionCandidates = [
      candidate('candidate-z-ocr', 'OCR text', {
        engineReportedConfidence: 0.99,
        recognitionConfidence: 0.99,
        parser: { stage: 'ocr', name: 'ocr', version: 'v1', configurationHash: 'ocr-hash' },
      }),
      candidate('candidate-a-native', 'Native text', {
        engineReportedConfidence: 0.1,
        recognitionConfidence: 0.1,
        parser: { stage: 'native_text', name: 'native', version: 'v1', configurationHash: 'native-hash' },
      }),
    ];
    value.arbitrationDecisions = [
      decision('unresolved-first', 'unresolved', ['candidate-z-ocr', 'candidate-a-native']),
      decision('conflict-second', 'conflict', ['candidate-z-ocr', 'candidate-a-native']),
    ];
    const provider = vi.fn(async (request) => {
      const bounded = JSON.parse(request.inputJson);
      expect(bounded.target.targetId).toBe('conflict-second');
      expect(bounded.candidates.map((item: { candidateId: string }) => item.candidateId))
        .toEqual(['candidate-a-native', 'candidate-z-ocr']);
      return output({
        state: 'inferred', relation: 'preserve_both', confidence: 0.7,
        rationaleCodes: ['complementary_fragments'],
        evidenceIds: ['candidate-a-native', 'candidate-z-ocr'],
      });
    });
    const result = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider,
    });
    expect(result.status).toBe('applied');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('skips consensus, single-source, and multi-way decisions without erasing candidates', async () => {
    const value = input();
    value.regionCandidates = [
      ...value.regionCandidates,
      candidate('candidate-vision', 'Vision text', {
        parser: { stage: 'vision', name: 'vision', version: 'v1', configurationHash: 'vision-hash' },
      }),
    ];
    value.arbitrationDecisions = [
      decision('consensus', 'consensus', ['candidate-native', 'candidate-ocr']),
      decision('single', 'single_source', ['candidate-native']),
      decision('multi', 'conflict', ['candidate-native', 'candidate-ocr', 'candidate-vision']),
    ];
    const provider = vi.fn();
    await expect(runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider,
    })).resolves.toEqual({ status: 'skipped', reason: 'no_candidate_targets' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('reconstructs both evidence references with immutable source identity and verbatim spans', async () => {
    const value = input();
    const result = await runForgewingObservationArbitration(value, {
      config,
      taskEnabled: true,
      provider: async () => output({
        state: 'inferred',
        relation: 'prefer_candidate_a',
        preferredCandidateId: 'candidate-native',
        confidence: 0.8,
        rationaleCodes: ['text_completeness_difference'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      }),
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    const proposal = result.bundle.proposals[0];
    expect(proposal?.evidence).toEqual([
      expect.objectContaining({
        artifactId: 'candidate-native', sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: 1,
        artifactLocalIndex: 0, sourceLayer: 'pdf_native_text',
        rawSpan: 'Item 1 | Debris Removal | CY',
      }),
      expect.objectContaining({
        artifactId: 'candidate-ocr', sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: 1,
        artifactLocalIndex: 0, sourceLayer: 'ocr',
        rawSpan: 'Item 1 | Debris Removal',
      }),
    ]);
  });

  it('retains unresolved, conflicting, and legacy source-layer provenance without inventing a page', async () => {
    const coordinates = [
      {
        mappingState: 'unresolved_physical_page' as const, sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: null, artifactLocalIndex: 4,
        sourceLayer: 'ocr' as const,
      },
      {
        mappingState: 'conflicting_physical_page_mapping' as const, sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: null, artifactLocalIndex: 5,
        sourceLayer: 'pdf_native_text' as const,
      },
      {
        mappingState: 'legacy_unproven' as const, sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: null, artifactLocalIndex: null,
        sourceLayer: 'legacy' as const,
      },
    ];
    for (const [index, coordinate] of coordinates.entries()) {
      const value = input();
      value.regionCandidates[0] = candidate('candidate-native', 'left', {
        physicalCoordinate: coordinate,
      });
      value.regionCandidates[1] = candidate('candidate-ocr', 'right', {
        physicalCoordinate: coordinate,
      });
      const result = await runForgewingObservationArbitration(value, {
        config, taskEnabled: true, provider: async () => output({
          state: 'inferred', relation: 'preserve_both', confidence: null,
          rationaleCodes: ['mixed_evidence'],
          evidenceIds: ['candidate-native', 'candidate-ocr'],
        }),
      });
      expect(result.status, `coordinate case ${index}`).toBe('applied');
      if (result.status !== 'applied') continue;
      for (const reference of result.bundle.proposals[0]!.evidence) {
        expect(reference.sourceLayer).toBe(coordinate.sourceLayer);
        expect(reference).not.toHaveProperty('physicalPageNumber');
        if (coordinate.artifactLocalIndex == null) {
          expect(reference).not.toHaveProperty('artifactLocalIndex');
        } else {
          expect(reference.artifactLocalIndex).toBe(coordinate.artifactLocalIndex);
        }
      }
    }
  });

  it('keeps complementary observations as a valid preserve-both proposal', async () => {
    const value = input();
    value.regionCandidates = [
      candidate('candidate-native', 'Item 1 | Debris Removal'),
      candidate('candidate-ocr', 'Item 1 | Debris Removal | CY'),
    ];
    const result = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider: async () => output({
        state: 'inferred', relation: 'preserve_both', confidence: 0.8,
        rationaleCodes: ['complementary_fragments'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      }),
    });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.bundle.proposals[0]).toMatchObject({ relation: 'preserve_both' });
    }
  });

  it('preserves incompatible values as a genuine-conflict proposal without selecting a winner', async () => {
    const value = input();
    value.regionCandidates = [
      candidate('candidate-native', '12.50'),
      candidate('candidate-ocr', '125.00'),
    ];
    const result = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider: async () => output({
        state: 'inferred', relation: 'genuinely_conflicting', confidence: 0.9,
        rationaleCodes: ['value_conflict'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      }),
    });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.bundle.proposals[0]).toMatchObject({ relation: 'genuinely_conflicting' });
      expect(result.bundle.proposals[0]).not.toHaveProperty('preferredCandidateId');
    }
  });

  it.each([
    ['source layer only', {
      parser: { stage: 'vision', name: 'vision', version: 'v1', configurationHash: 'vision-hash' },
      physicalCoordinate: {
        mappingState: 'resolved_physical_page' as const, sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1', physicalPageNumber: 1, artifactLocalIndex: 0,
        sourceLayer: 'ocr' as const,
      },
    }],
    ['confidence only', { recognitionConfidence: 0.99, engineReportedConfidence: 0.99 }],
    ['text length only', { rawText: 'same text with additional harmless context' }],
    ['slight geometry only', {
      boundingBox: {
        coordinateSpace: 'page_normalized' as const, origin: 'top_left' as const,
        x0: 0.101, y0: 0.201, x1: 0.801, y1: 0.301, rotation: 0 as const,
      },
    }],
    ['punctuation only', { rawText: 'Item 1, Debris Removal.' }],
  ])('does not preprocess a winner from %s', async (_case, override) => {
    const value = input();
    value.regionCandidates = [
      candidate('candidate-native', 'Item 1 Debris Removal'),
      candidate('candidate-ocr', 'Item 1 Debris Removal', override),
    ];
    const provider = vi.fn(async (request) => {
      const bounded = JSON.parse(request.inputJson);
      expect(bounded.candidates).toHaveLength(2);
      expect(bounded.candidates.every((item: Record<string, unknown>) => !('winner' in item))).toBe(true);
      return output({
        state: 'inferred', relation: 'preserve_both', confidence: 0.5,
        rationaleCodes: ['mixed_evidence'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      });
    });
    const result = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider,
    });
    expect(result.status).toBe('applied');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('contains unknown evidence and candidate references fail closed', async () => {
    const unknownEvidence = await runForgewingObservationArbitration(input(), {
      config, taskEnabled: true, provider: async () => output({
        state: 'inferred', relation: 'preserve_both', confidence: null,
        rationaleCodes: ['mixed_evidence'],
        evidenceIds: ['candidate-native', 'invented-candidate'],
      }),
    });
    expect(unknownEvidence.status).toBe('abstained');
    if (unknownEvidence.status === 'abstained') {
      expect(unknownEvidence.warnings).toContain('unknown_evidence_reference');
    }

    const unknownPreferred = await runForgewingObservationArbitration(input(), {
      config, taskEnabled: true, provider: async () => output({
        state: 'inferred', relation: 'prefer_candidate_a',
        preferredCandidateId: 'candidate-ocr', confidence: 0.5,
        rationaleCodes: ['mixed_evidence'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      }),
    });
    expect(unknownPreferred.status).toBe('abstained');
    if (unknownPreferred.status === 'abstained') {
      expect(unknownPreferred.warnings).toContain('unknown_candidate_reference');
    }
  });

  it('rejects foreign source identity and wrong page identity before a provider call', async () => {
    const foreign = input();
    foreign.regionCandidates[0] = candidate('candidate-native', 'text', {
      sourceDocumentId: 'foreign-document',
    });
    const wrongPage = input();
    wrongPage.regionCandidates[0] = candidate('candidate-native', 'text', {
      pageArtifactId: 'foreign-page',
    });
    const wrongPhysicalPage = input();
    wrongPhysicalPage.regionCandidates[0] = candidate('candidate-native', 'text', {
      physicalCoordinate: {
        mappingState: 'resolved_physical_page',
        sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1',
        physicalPageNumber: 2,
        artifactLocalIndex: 1,
        sourceLayer: 'pdf_native_text',
      },
    });
    const provider = vi.fn();
    for (const value of [foreign, wrongPage, wrongPhysicalPage]) {
      const result = await runForgewingObservationArbitration(value, {
        config, taskEnabled: true, provider,
      });
      expect(result.status).toBe('failed');
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('truncates deterministically, reports the warning, and hashes exact bounded input', async () => {
    const value = input();
    value.regionCandidates[0] = candidate('candidate-native', `A${'x'.repeat(5_000)}`);
    value.regionCandidates[1] = candidate('candidate-ocr', `B${'y'.repeat(5_000)}`);
    const observedInputs: string[] = [];
    const provider = vi.fn(async (request) => {
      observedInputs.push(request.inputJson);
      const bounded = JSON.parse(request.inputJson);
      expect(bounded.candidates[0].rawText).toHaveLength(4_000);
      expect(bounded.candidates[1].rawText).toHaveLength(4_000);
      expect(bounded.truncated).toBe(true);
      return output({
        state: 'inferred', relation: 'genuinely_conflicting', confidence: 0.6,
        rationaleCodes: ['value_conflict'],
        evidenceIds: ['candidate-native', 'candidate-ocr'],
      });
    });
    const first = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider,
    });
    const second = await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider,
    });
    expect(observedInputs[0]).toBe(observedInputs[1]);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    if (first.status === 'applied' && second.status === 'applied') {
      expect(first.warnings).toContain('input_truncated');
      expect(first.bundle.run.inputSnapshotHash).toBe(second.bundle.run.inputSnapshotHash);
    }
  });

  it('preserves inputs without mutation', async () => {
    const value = input();
    const before = JSON.stringify(value);
    await runForgewingObservationArbitration(value, {
      config, taskEnabled: true, provider: async () => output({
        state: 'insufficient_evidence', confidence: null,
        rationaleCodes: ['insufficient_structure'], evidenceIds: [],
        missingEvidence: ['conflicting_observations'],
      }),
    });
    expect(JSON.stringify(value)).toBe(before);
  });

  it('contains malformed output and provider timeout without changing deterministic input', async () => {
    const malformed = await runForgewingObservationArbitration(input(), {
      config, taskEnabled: true, provider: async () => '{bad json',
    });
    expect(malformed.status).toBe('abstained');
    if (malformed.status === 'abstained') expect(malformed.warnings).toContain('invalid_model_json');

    const timedOut = await runForgewingObservationArbitration(input(), {
      config: { ...config, timeoutMs: 5 },
      taskEnabled: true,
      provider: async () => new Promise<string>(() => undefined),
    });
    expect(timedOut.status).toBe('abstained');
    if (timedOut.status === 'abstained') expect(timedOut.warnings).toContain('provider_timeout');
  });
});

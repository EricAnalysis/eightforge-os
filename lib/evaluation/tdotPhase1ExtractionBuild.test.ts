import { describe, expect, it } from 'vitest';

import {
  deriveImplementationBuildFromEntries,
  deriveTdotPhase1ImplementationBuild,
} from '@/lib/evaluation/tdotPhase1ExtractionBuild';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';

const baseInput = {
  sources: [
    { path: 'lib/extraction/a.ts', content: 'export const a = 1;\n' },
    { path: 'lib/extraction/b.ts', content: 'export const b = 2;\n' },
  ],
  harnessDeclarations: [
    {
      path: 'lib/evaluation/harness.ts#run',
      content: 'export async function run() { return 1; }\n',
    },
  ],
  runtimeComponents: { engine: '1.2.3' },
} as const;

describe('Phase 1 extraction implementation build identity', () => {
  it('is deterministic across source enumeration and line endings', () => {
    const first = deriveImplementationBuildFromEntries(baseInput);
    const second = deriveImplementationBuildFromEntries({
      ...baseInput,
      sources: [...baseInput.sources].reverse().map((source) => ({
        ...source,
        content: source.content.replace(/\n/g, '\r\n'),
      })),
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^source-sha256:[0-9a-f]{64}$/);
  });

  it('changes for relevant extraction source or runtime changes', () => {
    const baseline = deriveImplementationBuildFromEntries(baseInput);
    expect(deriveImplementationBuildFromEntries({
      ...baseInput,
      sources: [
        baseInput.sources[0],
        { ...baseInput.sources[1], content: 'export const b = 3;\n' },
      ],
    })).not.toBe(baseline);
    expect(deriveImplementationBuildFromEntries({
      ...baseInput,
      runtimeComponents: { engine: '1.2.4' },
    })).not.toBe(baseline);
  });

  it('does not depend on report versions or evaluation prose', () => {
    const baseline = deriveImplementationBuildFromEntries(baseInput);
    const reportingOnly = {
      report_version: '99.0.0',
      prose: 'changed evaluation explanation',
    };
    expect(reportingOnly).toBeDefined();
    expect(deriveImplementationBuildFromEntries(baseInput)).toBe(baseline);
  });

  it('rejects duplicate and escaping source paths', () => {
    expect(() => deriveImplementationBuildFromEntries({
      ...baseInput,
      sources: [baseInput.sources[0], baseInput.sources[0]],
    })).toThrow(/duplicate paths/);
    expect(() => deriveImplementationBuildFromEntries({
      ...baseInput,
      sources: [{ path: '../outside.ts', content: 'unsafe' }],
    })).toThrow(/repository-relative/);
  });

  it('changes parser-manifest identity when implementation sources change', () => {
    const firstBuild = deriveImplementationBuildFromEntries(baseInput);
    const secondBuild = deriveImplementationBuildFromEntries({
      ...baseInput,
      sources: [
        baseInput.sources[0],
        { ...baseInput.sources[1], content: 'export const b = 3;\n' },
      ],
    });
    const manifest = (implementationBuild: string) =>
      buildLegacyShadowParserManifest({
        analysisMode: 'deterministic',
        unstructuredEnabled: false,
        visionEnabled: false,
        typedAiEnabled: false,
        implementationBuild,
        verificationPolicy: 'step1_span_verified',
      });
    expect(hashParserManifest(manifest(firstBuild))).not.toBe(
      hashParserManifest(manifest(secondBuild)),
    );
  });

  it('derives the live source closure deterministically', async () => {
    expect(await deriveTdotPhase1ImplementationBuild()).toBe(
      await deriveTdotPhase1ImplementationBuild(),
    );
  });
});

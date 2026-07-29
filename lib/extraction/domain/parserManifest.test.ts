import { describe, expect, it } from 'vitest';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';

function manifest() {
  return buildLegacyShadowParserManifest({
    analysisMode: 'heuristic',
    unstructuredEnabled: true,
    visionEnabled: true,
    typedAiEnabled: true,
    implementationBuild: 'fixture-commit',
  });
}

describe('parser manifest hashing', () => {
  it('is deterministic and changes for every output-affecting component', () => {
    const base = manifest();
    const baseHash = hashParserManifest(base);
    expect(hashParserManifest(structuredClone(base))).toBe(baseHash);

    const componentKeys = [
      'content_decoder',
      'renderer',
      'native_pdf_extractor',
      'ocr',
      'ocr_eligibility',
      'ocr_scheduler',
      'partition',
      'layout',
      'region_arbitration',
      'table_parser',
      'vision',
      'typed_ai',
      'verification_policy',
      'content_classifier',
    ] as const;
    for (const key of componentKeys) {
      const component = base[key];
      expect(component).not.toBeNull();
      if (!component) continue;
      const changed = {
        ...base,
        [key]: { ...component, version: `${component.version}-changed` },
      };
      expect(hashParserManifest(changed)).not.toBe(baseHash);
    }
    const changedNormalizer = {
      ...base,
      primitive_normalizers: [{
        ...base.primitive_normalizers[0],
        version: `${base.primitive_normalizers[0].version}-changed`,
      }],
    };
    expect(hashParserManifest(changedNormalizer)).not.toBe(baseHash);
  });

  it('rejects missing or non-hashed component configuration', () => {
    expect(() => hashParserManifest({
      ...manifest(),
      renderer: {
        ...manifest().renderer,
        configuration_hash: 'not-a-sha256',
      },
    })).toThrow(/SHA-256/);
    expect(() => hashParserManifest({
      ...manifest(),
      primitive_normalizers: [],
    })).toThrow(/primitive normalizer/);
  });

  it('changes for every live runtime configuration input', () => {
    const build = (overrides: Partial<Parameters<typeof buildLegacyShadowParserManifest>[0]> = {}) =>
      hashParserManifest(buildLegacyShadowParserManifest({
        analysisMode: 'heuristic',
        unstructuredEnabled: true,
        visionEnabled: true,
        typedAiEnabled: true,
        implementationBuild: 'commit-a',
        unstructured: {
          apiUrl: 'https://unstructured.example/v1',
          strategy: 'hi_res',
          splitConcurrency: '8',
          timeoutMs: 45_000,
        },
        visionModel: 'vision-a',
        typedAiModel: 'typed-a',
        instructorEnabled: true,
        instructorMaxRetries: 2,
        ...overrides,
      }));
    const base = build();
    expect(build({ analysisMode: 'ai_enriched' })).not.toBe(base);
    expect(build({ implementationBuild: 'commit-b' })).not.toBe(base);
    expect(build({
      unstructured: {
        apiUrl: 'https://unstructured.example/v2',
        strategy: 'fast',
        splitConcurrency: '4',
        timeoutMs: 12_000,
      },
    })).not.toBe(base);
    expect(build({ visionModel: 'vision-b' })).not.toBe(base);
    expect(build({ typedAiModel: 'typed-b' })).not.toBe(base);
    expect(build({ instructorEnabled: false })).not.toBe(base);
    expect(build({ instructorMaxRetries: 3 })).not.toBe(base);
  });

  it('gives the span-verified shadow path a distinct stable manifest identity', () => {
    const step0 = manifest();
    const step1 = buildLegacyShadowParserManifest({
      analysisMode: 'heuristic',
      unstructuredEnabled: true,
      visionEnabled: true,
      typedAiEnabled: true,
      implementationBuild: 'fixture-commit',
      verificationPolicy: 'step1_span_verified',
    });

    expect(step1.verification_policy.name).toBe('step1-span-verification-policy');
    expect(step1.verification_policy.version).toBe('v2');
    expect(step1.region_arbitration.name).toBe('region-arbitration');
    expect(step1.table_parser.name).toBe('generic-geometric-table-reconstruction');
    expect(step1.table_parser.version).toBe('v3');
    expect(hashParserManifest(step1)).not.toBe(hashParserManifest(step0));
    expect(hashParserManifest(structuredClone(step1))).toBe(hashParserManifest(step1));
  });
});

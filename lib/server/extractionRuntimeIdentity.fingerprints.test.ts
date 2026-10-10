import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  observeExtractionRuntimeIdentity,
  primeExtractionRuntimeFingerprints,
  resetExtractionRuntimeFingerprintsForTests,
} from './extractionRuntimeIdentity';

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

afterEach(() => resetExtractionRuntimeFingerprintsForTests());

describe('extraction dependency fingerprints', () => {
  it('stay not_observed until this process observes them', () => {
    expect(observeExtractionRuntimeIdentity().identity.dependency_fingerprints).toBe('not_observed');
  });

  it('record the loaded canvas addon, the selected OCR core and the language data, from the files themselves', async () => {
    await primeExtractionRuntimeFingerprints();
    const fingerprints = observeExtractionRuntimeIdentity().identity.dependency_fingerprints;
    if (fingerprints === 'not_observed') throw new Error('expected observed fingerprints');

    const canvas = Object.entries(fingerprints.loaded_native_addons)
      .find(([key]) => key.startsWith('@napi-rs/canvas-'));
    expect(canvas, 'the renderer addon is loaded and recorded').toBeDefined();
    expect(canvas![1]).toBe(sha256(`node_modules/${canvas![0]}`));

    const core = fingerprints.tesseract!;
    expect(core.selected_core_build).toBe(core.wasm_relaxed_simd ? 'tesseract-core-relaxedsimd-lstm'
      : core.wasm_simd ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm');
    const wasm = `${core.selected_core_build}.wasm`;
    expect(core.selected_core_files[wasm]).toBe(sha256(`node_modules/tesseract.js-core/${wasm}`));
    expect(fingerprints.language_data!['eng.traineddata.gz'])
      .toBe(sha256('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'));
  });

  it('are observed once per process, so every payload of the process carries the same identity', async () => {
    await primeExtractionRuntimeFingerprints();
    const first = observeExtractionRuntimeIdentity();
    await primeExtractionRuntimeFingerprints();
    expect(observeExtractionRuntimeIdentity()).toEqual(first);
  });
});

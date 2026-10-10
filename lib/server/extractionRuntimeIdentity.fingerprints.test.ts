import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
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
    // Observe the same actual adapter call used by createWorker's load packet.
    // Some adapters accept a Boolean, others interpret it as numeric OEM; the
    // fingerprint must name whichever module this installed adapter returns.
    const repoRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const tesseractRequire = createRequire(repoRequire.resolve('tesseract.js/package.json'));
    const getCore = tesseractRequire('./src/worker-script/node/getCore.js') as
      (lstmOnly: boolean, corePath: undefined, response: { progress: () => void }) => Promise<unknown>;
    const selected = await getCore(true, undefined, { progress: () => {} });
    expect(tesseractRequire.cache[tesseractRequire.resolve(`tesseract.js-core/${core.selected_core_build}`)]?.exports)
      .toBe(selected);
    expect(typeof selected).toBe('function');
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

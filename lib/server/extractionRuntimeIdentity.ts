import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hashCanonical } from '@/lib/extraction/domain/hash';

/** Runtime observation, not qualification proof or an extraction authority gate. */
export type ExtractionRuntimeIdentity = ReturnType<typeof observeExtractionRuntimeIdentity>;

export type ExtractionDependencyFingerprints =
  | 'not_observed'
  | {
      schema: 'extraction_dependency_fingerprints_v1';
      /** Native addons this process has actually loaded (from the process report), by node_modules path. */
      loaded_native_addons: Record<string, string>;
      /** The OCR core returned by the installed worker adapter for extraction's actual load options. */
      tesseract: {
        wasm_simd: boolean;
        wasm_relaxed_simd: boolean;
        selected_core_build: string;
        selected_core_files: Record<string, string>;
      } | null;
      /** The language data extraction passes as langPath. */
      language_data: Record<string, string> | null;
    };

let fingerprints: ExtractionDependencyFingerprints = 'not_observed';
let priming: Promise<void> | null = null;

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function nodeModulesKey(file: string): string | null {
  const normalized = file.split(path.sep).join('/');
  const index = normalized.lastIndexOf('/node_modules/');
  return index >= 0 ? normalized.slice(index + '/node_modules/'.length) : null;
}

async function observeFingerprints(): Promise<ExtractionDependencyFingerprints> {
  const repoRequire = createRequire(path.join(process.cwd(), 'package.json'));
  // Load the renderer's native addon now so every payload of this process records the same, actually
  // loaded binary (PDF rendering loads it anyway); then read what the process has really dlopen'ed.
  await import('@napi-rs/canvas');
  const report = process.report?.getReport() as { sharedObjects?: unknown } | undefined;
  const shared = Array.isArray(report?.sharedObjects) ? report.sharedObjects as unknown[] : [];
  const loaded_native_addons: Record<string, string> = {};
  for (const file of shared) {
    if (typeof file !== 'string' || !file.endsWith('.node')) continue;
    const key = nodeModulesKey(file);
    if (key) loaded_native_addons[key] = sha256File(file);
  }

  let tesseract: Extract<ExtractionDependencyFingerprints, object>['tesseract'] = null;
  const tesseractRequire = createRequire(repoRequire.resolve('tesseract.js/package.json'));
  const { simd, relaxedSimd } = tesseractRequire('wasm-feature-detect') as {
    simd: () => Promise<boolean>;
    relaxedSimd: () => Promise<boolean>;
  };
  const wasm_simd = await simd();
  const wasm_relaxed_simd = await relaxedSimd();
  // createWorker('eng', undefined, ...) defaults to LSTM_ONLY; its worker
  // dispatches getCore with the Boolean lstmOnly option, not a numeric OEM.
  // Observe the installed adapter's returned module rather than predicting its
  // choice from package versions or assuming that Boolean means a -lstm file.
  const getCore = tesseractRequire('./src/worker-script/node/getCore.js') as
    (lstmOnly: boolean, corePath: undefined, response: { progress: () => void }) => Promise<unknown>;
  const selectedCore = await getCore(true, undefined, { progress: () => {} });
  const builds = ['tesseract-core', 'tesseract-core-simd', 'tesseract-core-relaxedsimd',
    'tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm'];
  const selectedBuilds = builds.filter((candidate) => {
    const moduleFile = tesseractRequire.resolve(`tesseract.js-core/${candidate}`);
    return tesseractRequire.cache[moduleFile]?.exports === selectedCore;
  });
  if (selectedBuilds.length !== 1) throw new Error('Cannot bind the selected OCR core to exactly one installed module');
  const build = selectedBuilds[0]!;
  const coreDir = path.dirname(repoRequire.resolve('tesseract.js-core/package.json'));
  const coreFiles = readdirSync(coreDir).filter((name) => name.startsWith(`${build}.`)).sort();
  tesseract = {
    wasm_simd,
    wasm_relaxed_simd,
    selected_core_build: build,
    selected_core_files: Object.fromEntries(coreFiles.map((name) => [name, sha256File(path.join(coreDir, name))])),
  };

  const langDir = path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
  const language_data = Object.fromEntries(readdirSync(langDir).sort()
    .map((name) => [name, sha256File(path.join(langDir, name))]));

  return { schema: 'extraction_dependency_fingerprints_v1', loaded_native_addons, tesseract, language_data };
}

/**
 * Observe this process's native dependency fingerprints once. Never throws: if anything cannot be
 * observed, payloads keep recording 'not_observed' rather than a guess from installed pins.
 */
export function primeExtractionRuntimeFingerprints(): Promise<void> {
  priming ??= observeFingerprints()
    .then((observed) => { fingerprints = observed; })
    .catch(() => { fingerprints = 'not_observed'; });
  return priming;
}

/** Test seam: forget the process observation. */
export function resetExtractionRuntimeFingerprintsForTests(): void {
  fingerprints = 'not_observed';
  priming = null;
}

export function observeExtractionRuntimeIdentity() {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  const environment = process.env.VERCEL_ENV;
  const identity = {
    schema: 'extraction_runtime_identity_v1' as const,
    node_version: process.version,
    node_abi: process.versions.modules ?? null,
    v8_version: process.versions.v8 ?? null,
    platform: process.platform,
    architecture: process.arch,
    deployment_revision: revision && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null,
    deployment_environment: environment === 'production' || environment === 'preview' || environment === 'development'
      ? environment : null,
    // Observed from this process (loaded addons, selected OCR core, language data), never inferred
    // from installed pins; 'not_observed' until primed or when observation failed.
    dependency_fingerprints: fingerprints,
  };
  return { identity, identity_digest: hashCanonical(identity) };
}

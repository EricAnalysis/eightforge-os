/**
 * Pinned cross-machine evaluation run -- explicit, manual, offline.
 *
 * The entrypoint of Dockerfile.eval (see docs/testing/docker-evaluation-runtime.md):
 *
 *   ... runPinnedEvaluation.ts -- --corpus <dir> --pins <pins.json> --out <empty dir> [--repeat]
 *
 * For each pinned source PDF: verify its SHA-256 (refuse on mismatch), run the
 * production extraction entry point, extractDocument(), exactly as the
 * reconstruction diff does, and write a capture: the payload minus the
 * enumerated wall-clock fields (lib/evaluation/pinnedEvaluationCapture.ts).
 * Then, from those captures: the reconstruction dump (the existing diff
 * script's format, so `compare` works across machines) and the resolution
 * evidence inventory. Every output is hashed; a runtime manifest records what
 * produced it. Two machines agree when their identity and capture hashes match
 * (scripts/evaluation/compareEvaluationRuns.ts).
 *
 * No database, no provider, no network: refuses database, provider and
 * deployment credentials, and refuses to run with network access unless
 * explicitly allowed (recorded in the manifest). Outputs hold source row text:
 * keep them outside the repository.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  buildResolutionEvidenceInventory,
  offlineDocumentId,
  type InventoryDocumentInput,
} from '@/lib/evaluation/resolutionEvidenceInventory';
import {
  parseCorpusPins,
  stripVolatileExtractionFields,
  VOLATILE_EXTRACTION_PATHS,
  type CorpusPin,
} from '@/lib/evaluation/pinnedEvaluationCapture';
import { canonicalJson, sha256Hex } from '@/lib/extraction/domain/hash';
import { extractDocument } from '@/lib/server/documentExtraction';

const FORBIDDEN_ENV = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL',
  'DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'UNSTRUCTURED_API_KEY', 'LINEAR_API_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'VERCEL_TOKEN'];

const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function packageVersion(name: string): string | null {
  try {
    return (JSON.parse(readFileSync(requireFromRepo.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

/** Every regular file under a directory, sorted by POSIX path, with its SHA-256. */
function treeDigest(root: string): { digest: string; files: number } | null {
  if (!existsSync(root)) return null;
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) entries.push(`${sha256File(full)}  ${path.relative(root, full).split(path.sep).join('/')}`);
    }
  };
  walk(root);
  entries.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  return { digest: sha256Hex(`${entries.join('\n')}\n`), files: entries.length };
}

/** Succeeds only when nothing outside the container answers; any answer means the network is reachable. */
async function probeNetwork(): Promise<{ isolated: boolean; detail: string }> {
  try {
    await Promise.race([
      lookup('registry.npmjs.org'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return { isolated: false, detail: 'dns_resolved' };
  } catch {
    // DNS failing is expected; also try a raw TCP connection to a public address.
  }
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '1.1.1.1', port: 443 });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return reachable ? { isolated: false, detail: 'tcp_connected' } : { isolated: true, detail: 'dns_and_tcp_unreachable' };
}

/** The tesseract core build tesseract.js will load here, decided exactly as its node getCore does. */
async function tesseractCoreSelection(): Promise<Record<string, unknown>> {
  const tesseractRequire = createRequire(requireFromRepo.resolve('tesseract.js/package.json'));
  const { simd, relaxedSimd } = tesseractRequire('wasm-feature-detect') as { simd: () => Promise<boolean>; relaxedSimd: () => Promise<boolean> };
  const simdSupport = await simd();
  const relaxedSimdSupport = await relaxedSimd();
  // Extraction creates its worker with the default OEM, which loads an LSTM core.
  const build = relaxedSimdSupport ? 'tesseract-core-relaxedsimd-lstm' : simdSupport ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm';
  const coreDir = path.dirname(requireFromRepo.resolve('tesseract.js-core/package.json'));
  const files = readdirSync(coreDir).filter((name) => name.startsWith(`${build}.`)).sort();
  return {
    wasm_simd: simdSupport,
    wasm_relaxed_simd: relaxedSimdSupport,
    selected_core_build: build,
    selected_core_files: Object.fromEntries(files.map((name) => [name, sha256File(path.join(coreDir, name))])),
  };
}

function commandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function runtimeIdentity(pins: readonly CorpusPin[], pinsDigest: string): Promise<Record<string, unknown>> {
  const buildInfoPath = process.env.EIGHTFORGE_EVAL_BUILD_INFO ?? '/opt/eightforge-eval/build-info.json';
  const buildInfo = existsSync(buildInfoPath) ? JSON.parse(readFileSync(buildInfoPath, 'utf8')) as Record<string, unknown> : null;
  const langDir = path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
  const canvasDir = path.dirname(requireFromRepo.resolve('@napi-rs/canvas/package.json'));
  const canvasNative = readdirSync(path.join(canvasDir, '..')).filter((name) => name.startsWith('canvas-')).sort();
  const nativeBinaries: Record<string, string> = {};
  for (const name of canvasNative) {
    const dir = path.join(canvasDir, '..', name);
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.node')).sort()) {
      nativeBinaries[`@napi-rs/${name}/${file}`] = sha256File(path.join(dir, file));
    }
  }
  const python = commandOutput('python3', ['-c', 'import sys, fitz; print(sys.version.split()[0]); print(fitz.VersionBind)']);
  const [pythonVersion, pymupdfVersion] = python ? python.split('\n') : [null, null];
  const fonts = treeDigest('/usr/share/fonts');
  return {
    schema: 'eightforge_eval_runtime_identity_v1',
    source_commit: buildInfo?.source_commit ?? null,
    source_tree_digest: buildInfo?.source_tree_digest ?? null,
    source_file_count: buildInfo?.source_file_count ?? null,
    package_lock_sha256: sha256File(path.join(process.cwd(), 'package-lock.json')),
    platform: `${process.platform}/${process.arch}`,
    node_version: process.version,
    python_version: pythonVersion ?? null,
    pymupdf_version: pymupdfVersion ?? null,
    packages: Object.fromEntries(['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng', 'wasm-feature-detect',
      'pdfjs-dist', 'pdf-parse', '@napi-rs/canvas', 'xlsx'].map((name) => [name, packageVersion(name)])),
    tesseract: {
      ...(await tesseractCoreSelection()),
      language_data: Object.fromEntries(readdirSync(langDir).sort().map((name) => [name, sha256File(path.join(langDir, name))])),
    },
    canvas_native_binaries: nativeBinaries,
    fonts: fonts ? { root: '/usr/share/fonts', ...fonts } : null,
    locale: {
      LANG: process.env.LANG ?? null,
      LC_ALL: process.env.LC_ALL ?? null,
      TZ: process.env.TZ ?? null,
      intl_locale: Intl.DateTimeFormat().resolvedOptions().locale,
      intl_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    fixture_manifest_digest: pinsDigest,
    source_pdf_sha256: Object.fromEntries(pins.map((pin) => [pin.label, pin.sha256])),
    volatile_extraction_paths: VOLATILE_EXTRACTION_PATHS,
  };
}

function writeCanonical(file: string, value: unknown): string {
  const text = `${canonicalJson(value)}\n`;
  writeFileSync(file, text);
  return sha256Hex(text);
}

async function extractPinned(corpus: string, pin: CorpusPin): Promise<{ capture: Record<string, unknown>; removed: string[] }> {
  const bytes = readFileSync(path.join(corpus, pin.file));
  const sha = sha256Hex(new Uint8Array(bytes));
  // UUID-shaped like a production document id; diagnostics refuse any other shape.
  const sourceDocumentId = offlineDocumentId(sha);
  const sourceArtifactId = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
  const payload = await extractDocument({
    // The corpus-relative name, never the host path: the payload records it.
    id: sourceDocumentId, title: pin.file, name: pin.file, document_type: 'contract', storage_path: pin.file,
  }, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  'application/pdf', pin.file, { sourceDocumentId, sourceArtifactId });
  const { data, removed } = stripVolatileExtractionFields(payload);
  return {
    capture: {
      schema: 'eightforge_extraction_capture_v1',
      label: pin.label,
      source_file: pin.file,
      source_sha256: sha,
      document_id: sourceDocumentId,
      data,
    },
    removed,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const forbidden = FORBIDDEN_ENV.filter((name) => process.env[name]?.trim());
  if (forbidden.length > 0) throw new Error(`Refusing to run with ${forbidden.join(', ')} set: this evaluation is offline only`);
  const corpus = arg('--corpus');
  const pinsFile = arg('--pins');
  const out = arg('--out');
  if (!corpus || !pinsFile || !out) throw new Error('--corpus <dir> --pins <pins.json> --out <dir> are required');
  const repeat = process.argv.includes('--repeat');
  const resolvedOut = path.resolve(out);
  if (resolvedOut.startsWith(`${path.resolve(corpus)}${path.sep}`) || resolvedOut === path.resolve(corpus)) {
    throw new Error('--out must be outside the corpus');
  }
  const repoRelative = path.relative(process.cwd(), resolvedOut);
  if (!repoRelative.startsWith('..') && !path.isAbsolute(repoRelative)) {
    throw new Error('--out must be outside the repository: captures hold source row text');
  }
  if (existsSync(resolvedOut) && readdirSync(resolvedOut).length > 0) throw new Error('--out must be empty: captures are never mixed with an earlier run');
  // tesseract.js reads ./eng.traineddata before its pinned language path; a stale cache would silently replace it.
  if (existsSync(path.join(process.cwd(), 'eng.traineddata'))) {
    throw new Error('Refusing to run: ./eng.traineddata exists in the working directory and would override the pinned OCR language data');
  }

  const network = await probeNetwork();
  const allowNetwork = process.env.EIGHTFORGE_EVAL_ALLOW_NETWORK === '1';
  if (!network.isolated && !allowNetwork) {
    throw new Error(`Refusing to run with network access (${network.detail}); run with --network none, or set EIGHTFORGE_EVAL_ALLOW_NETWORK=1 to record an unisolated run`);
  }

  const pinsJson = JSON.parse(readFileSync(pinsFile, 'utf8')) as unknown;
  const pins = parseCorpusPins(pinsJson);
  for (const pin of pins.documents) {
    const file = path.join(corpus, pin.file);
    if (!existsSync(file)) throw new Error(`${pin.label}: ${pin.file} is not in the corpus`);
    const actual = sha256File(file);
    if (actual !== pin.sha256) throw new Error(`${pin.label}: source sha256 ${actual} does not match pin ${pin.sha256}; refusing`);
  }
  const pinsDigest = sha256Hex(canonicalJson(pins));
  const identity = await runtimeIdentity(pins.documents, pinsDigest);

  mkdirSync(path.join(resolvedOut, 'extraction'), { recursive: true });
  const captures: Record<string, string> = {};
  const repeatability: Record<string, boolean> = {};
  const durations: Record<string, number> = {};
  const inventoryInputs: InventoryDocumentInput[] = [];
  const captureFiles: string[] = [];
  for (const pin of pins.documents) {
    const began = Date.now();
    const { capture } = await extractPinned(corpus, pin);
    durations[pin.label] = Date.now() - began;
    const relative = `extraction/${pin.label}.json`;
    captures[relative] = writeCanonical(path.join(resolvedOut, relative), capture);
    captureFiles.push(path.join(resolvedOut, relative));
    if (repeat) {
      const again = await extractPinned(corpus, pin);
      repeatability[pin.label] = sha256Hex(`${canonicalJson(again.capture)}\n`) === captures[relative];
    }
    inventoryInputs.push({ documentId: capture.document_id as string, label: pin.label,
      extraction: { id: `pinned:${pin.sha256}`, created_at: null, data: capture.data as Record<string, unknown> } });
    process.stdout.write(`${pin.label}: captured (${durations[pin.label]} ms)\n`);
  }

  // The existing reconstruction diff, reading the captures: one extraction per document.
  const dumpFile = path.join(resolvedOut, 'reconstruction-dump.json');
  const dump = spawnSync(process.execPath, [
    path.join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'), '--config', 'vitest.config.ts',
    'scripts/evaluation/diffPricedScheduleReconstruction.ts', '--', 'dump', '--out', dumpFile, '--payload', captureFiles.join(','),
  ], { encoding: 'utf8', env: process.env });
  if (dump.status !== 0) throw new Error(`reconstruction dump failed: ${dump.stderr || dump.stdout}`);
  captures['reconstruction-dump.json'] = sha256File(dumpFile);

  captures['inventory.json'] = writeCanonical(path.join(resolvedOut, 'inventory.json'),
    buildResolutionEvidenceInventory(inventoryInputs));

  const identityDigest = sha256Hex(canonicalJson(identity));
  const captureDigest = sha256Hex(canonicalJson(captures));
  writeCanonical(path.join(resolvedOut, 'capture-hashes.json'), {
    schema: 'eightforge_eval_capture_hashes_v1',
    runtime_identity_digest: identityDigest,
    captures,
    capture_set_digest: captureDigest,
  });
  writeFileSync(path.join(resolvedOut, 'runtime-manifest.json'), `${JSON.stringify({
    schema: 'eightforge_eval_runtime_manifest_v1',
    identity,
    runtime_identity_digest: identityDigest,
    capture_set_digest: captureDigest,
    // Expected to differ between machines; never part of the parity comparison.
    observed: {
      image_id: process.env.EIGHTFORGE_EVAL_IMAGE_ID?.trim() || null,
      containerized: existsSync('/.dockerenv'),
      network: { ...network, allowed_by_operator: allowNetwork },
      repeat_checked: repeat,
      repeatability: repeat ? repeatability : null,
      host_cpu_model: os.cpus()[0]?.model ?? null,
      host_cpu_count: os.cpus().length,
      kernel_release: os.release(),
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      extraction_ms: durations,
    },
  }, null, 2)}\n`);

  const lines = [
    `runtime identity ${identityDigest}`,
    ...Object.entries(captures).map(([file, hash]) => `  ${hash}  ${file}`),
    `capture set ${captureDigest}`,
    ...(repeat ? [`repeatable: ${Object.entries(repeatability).map(([label, same]) => `${label} ${same ? 'yes' : 'NO'}`).join(', ')}`] : []),
    `-> ${resolvedOut}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (repeat && Object.values(repeatability).some((same) => !same)) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import nextConfig from '../../next.config';

/**
 * Function-size excludes (docs/decisions/VERCEL_FUNCTION_SIZE.md) must never
 * drop a file production loads. Next matches them the way this test does:
 * route keys with picomatch "contains", and the patterns of any key matching
 * "next-server" unanchored while tracing every function.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const picomatch = require('next/dist/compiled/picomatch') as (glob: string | string[],
  options?: Record<string, unknown>) => (input: string) => boolean;

const excludes = (nextConfig.outputFileTracingExcludes ?? {}) as Record<string, string[]>;
const includes = (nextConfig.outputFileTracingIncludes ?? {}) as Record<string, string[]>;

// The independent worker dependency closure plus assets its Emscripten core
// loads dynamically. Being absent from excludes does not make a file ship.
const REQUIRED_WORKER_FILES = [
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'node_modules/tesseract.js/package.json',
  'node_modules/tesseract.js/src/worker-script/node/index.js',
  'node_modules/tesseract.js/src/worker-script/node/getCore.js',
  'node_modules/tesseract.js/src/worker-script/node/gunzip.js',
  'node_modules/tesseract.js/src/worker-script/node/cache.js',
  'node_modules/tesseract.js/src/worker-script/index.js',
  'node_modules/tesseract.js/src/worker-script/constants/defaultOutput.js',
  'node_modules/tesseract.js/src/worker-script/utils/arrayBufferToBase64.js',
  'node_modules/tesseract.js/src/worker-script/utils/dump.js',
  'node_modules/tesseract.js/src/worker-script/utils/setImage.js',
  ...['OEM', 'PSM', 'imageType'].map(name => `node_modules/tesseract.js/src/constants/${name}.js`),
  ...['getEnvironment', 'log'].map(name => `node_modules/tesseract.js/src/utils/${name}.js`),
  'node_modules/tesseract.js-core/package.json',
  ...['', '-simd', '-relaxedsimd', '-lstm', '-simd-lstm', '-relaxedsimd-lstm'].flatMap(build =>
    ['js', 'wasm', 'wasm.js'].map(extension => `node_modules/tesseract.js-core/tesseract-core${build}.${extension}`)),
  'node_modules/wasm-feature-detect/package.json',
  'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  ...['package.json', 'index.js', 'lib/decoder.js', 'lib/encoder.js'].map(file => `node_modules/bmp-js/${file}`),
  ...['package.json', 'index.js'].map(file => `node_modules/is-url/${file}`),
  ...['package.json', 'runtime.js'].map(file => `node_modules/regenerator-runtime/${file}`),
  ...['package.json', 'lib/index.js'].map(file => `node_modules/node-fetch/${file}`),
  ...['package.json', 'index.js', 'lib/mappingTable.json'].map(file => `node_modules/tr46/${file}`),
  ...['package.json', 'lib/index.js'].map(file => `node_modules/webidl-conversions/${file}`),
  ...['package.json', 'lib/URL-impl.js', 'lib/URL.js', 'lib/public-api.js', 'lib/url-state-machine.js', 'lib/utils.js']
    .map(file => `node_modules/whatwg-url/${file}`),
];

/** Files the extraction, OCR and value-reading functions load at runtime. */
const REQUIRED_RUNTIME_FILES = [
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  'node_modules/tesseract.js/src/index.js',
  // A supported OCR core branch and the detector that selects the installed adapter's branch.
  'node_modules/tesseract.js/src/worker-script/node/getCore.js',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.js',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
  'node_modules/@napi-rs/canvas/index.js',
  'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node',
  'node_modules/pdf-parse/lib/pdf-parse.js',
  'node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/next/dist/server/next-server.js',
];

function appRoutes(dir = 'app', prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return appRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`);
    return /^(page|route)\.tsx?$/.test(entry.name) ? [prefix || '/'] : [];
  });
}

describe('function tracing excludes', () => {
  it('covers the worker entry dependency graph, including imports absent from the request thread', async () => {
    // Trace the worker independently: it is spawned by a path, not imported by
    // the route. Resolve through the installed package to support worktree
    // node_modules junctions without silently tracing only the junction itself.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft') as {
      nodeFileTrace: (files: string[], options: { base: string; processCwd: string }) =>
        Promise<{ fileList: Set<string> }>;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packageFile = require.resolve('tesseract.js/package.json') as string;
    const dependencyRoot = path.dirname(path.dirname(path.dirname(packageFile)));
    const workerEntry = path.join(path.dirname(packageFile), 'src/worker-script/node/index.js');
    const traced = await nodeFileTrace([workerEntry], { base: dependencyRoot, processCwd: dependencyRoot });
    const included = picomatch(Object.values(includes).flat(), { dot: true });
    const workerFiles = [...traced.fileList].map(file => file.split(path.sep).join('/'));
    expect(workerFiles).toContain('node_modules/tesseract.js/src/worker-script/index.js');
    expect(workerFiles).toContain('node_modules/wasm-feature-detect/dist/cjs/index.cjs');
    for (const file of workerFiles) {
      expect(included(file), `worker dependency ${file} must be included`).toBe(true);
    }
  });

  it('positively includes the PDF worker and OCR worker dependency closure on every extraction route', () => {
    for (const route of ['/api/documents/process', '/api/documents/upload',
      '/api/documents/[id]/evaluate', '/api/jobs/process/[jobId]']) {
      const patterns = Object.entries(includes).filter(([key]) => picomatch(key, { contains: true })(route))
        .flatMap(([, files]) => files);
      const included = picomatch(patterns, { dot: true });
      const excluded = picomatch(Object.entries(excludes)
        .filter(([key]) => picomatch(key, { contains: true })(route)).flatMap(([, files]) => files),
      { contains: true, dot: true });
      for (const file of REQUIRED_WORKER_FILES) {
        expect(included(file), `${route} must ship ${file}`).toBe(true);
        expect(excluded(file), `${route} must not discard ${file}`).toBe(false);
        expect(readFileSync(file).byteLength, `${file} must exist in the installed dependency tree`).toBeGreaterThan(0);
      }
    }
  });

  it('limits worker asset inclusion to the four extraction routes', () => {
    const matched = appRoutes().filter(route => Object.keys(includes)
      .some(key => picomatch(key, { contains: true })(route)));
    expect(matched.sort()).toEqual(['/api/documents/process', '/api/documents/upload',
      '/api/documents/[id]/evaluate', '/api/jobs/process/[jobId]'].sort());
  });

  it('never drop a file production loads, matched the way Next matches them while tracing', () => {
    const tracingWide = Object.keys(excludes).filter((key) => picomatch(key)('next-server'));
    expect(tracingWide).toEqual(['*']);
    const patterns = tracingWide.flatMap((key) => excludes[key]!);
    expect(patterns.length).toBeGreaterThan(0);
    const unanchored = picomatch(patterns, { contains: true, dot: true });
    for (const file of REQUIRED_RUNTIME_FILES) expect(unanchored(file), file).toBe(false);
  });

  it('never match the Next.js runtime, even loosely: every route needs it, if only to answer 404', () => {
    const runtime: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else runtime.push(file);
      }
    })('node_modules/next/dist/server');
    const all = Object.values(excludes).flat();
    const loose = picomatch(all, { contains: true, dot: true });
    expect(runtime.length).toBeGreaterThan(100);
    expect(runtime.filter((file) => loose(file))).toEqual([]);
    expect(REQUIRED_RUNTIME_FILES.filter((file) => loose(file))).toEqual([]);
  });

  it('apply the evaluation-only excludes to evaluation workspaces and nothing else', () => {
    const scoped = Object.keys(excludes).filter((key) => key !== '*');
    const routes = appRoutes();
    for (const route of routes) {
      const matched = scoped.some((key) => picomatch(key, { dot: true, contains: true })(route));
      expect(matched, route).toBe(route.startsWith('/evaluation/') || route.startsWith('/api/evaluation/'));
    }
    expect(routes.filter((route) => route.includes('/evaluation/')).length).toBeGreaterThan(0);
  });

  it('keeps the evaluation workspaces localhost-only outside production, so their data never needs to ship', () => {
    for (const file of ['lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server.ts',
      'lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server.ts']) {
      expect(readFileSync(file, 'utf8')).toMatch(/!== 'production'/);
    }
  });

  it('loads only the default pdf-parse build: extraction never selects another pdf.js version', () => {
    const extraction = readFileSync('lib/server/documentExtraction.ts', 'utf8');
    expect(extraction).toMatch(/require\('pdf-parse\/lib\/pdf-parse\.js'\)/);
    // pdf-parse picks its build from options.version (e.g. 'v1.10.88'); extraction never sets it.
    expect(extraction).not.toMatch(/pdfOpts\.version|pdfOpts\[['"]version|['"]v\d+\.\d+\.\d+['"]/);
  });
});

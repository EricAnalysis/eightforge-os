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

/** Files the extraction, OCR and value-reading functions load at runtime. */
const REQUIRED_RUNTIME_FILES = [
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  'node_modules/tesseract.js/src/index.js',
  // The OCR core Node 24 loads (default OEM) and the detector that selects it.
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

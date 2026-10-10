import { withBotId } from 'botid/next/config';
import type { NextConfig } from "next";

// Repository data the evaluation workspaces read through process.cwd(), which
// the tracer includes wholesale. Next matches exclude patterns loosely (a
// pattern can match inside node_modules), so each one names a path that only
// exists as repository data; nextConfigTracing.test.ts checks every pattern.
const EVALUATION_DATA = [
  'scripts/evaluation/**',
  'lib/contracts/__fixtures__/**',
  'lib/evaluation/benchmark/labels/**',
  'supabase/migrations/**',
  'docs/audits/**',
  'docs/design/**',
  'public/vendor/pdfjs/**',
];

// Worker entrypoints and their dynamic assets are not imports of the request
// thread, so Next's tracer cannot discover their complete runtime closure.
// Keep this finite dependency list on extraction functions only. Retain every
// core branch the installed worker adapter can select; packaging must not change
// its CPU/OEM selection to make initialization pass.
const EXTRACTION_WORKER_FILES = [
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'node_modules/tesseract.js/src/worker-script/**',
  'node_modules/tesseract.js/src/constants/{OEM,PSM,imageType}.js',
  'node_modules/tesseract.js/src/utils/{getEnvironment,log}.js',
  'node_modules/tesseract.js/package.json',
  'node_modules/tesseract.js-core/package.json',
  'node_modules/tesseract.js-core/tesseract-core.{js,wasm,wasm.js}',
  'node_modules/tesseract.js-core/tesseract-core-simd.{js,wasm,wasm.js}',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd.{js,wasm,wasm.js}',
  'node_modules/tesseract.js-core/tesseract-core-lstm.{js,wasm,wasm.js}',
  'node_modules/tesseract.js-core/tesseract-core-simd-lstm.{js,wasm,wasm.js}',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.{js,wasm,wasm.js}',
  'node_modules/wasm-feature-detect/package.json',
  'node_modules/wasm-feature-detect/dist/cjs/index.cjs',
  'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
  // Shared worker-script imports; node-fetch is its Node fallback adapter.
  'node_modules/bmp-js/{package.json,index.js,lib/*.js}',
  'node_modules/is-url/{package.json,index.js}',
  'node_modules/regenerator-runtime/{package.json,runtime.js}',
  'node_modules/node-fetch/{package.json,lib/index.js}',
  'node_modules/tr46/{package.json,index.js,lib/mappingTable.json}',
  'node_modules/webidl-conversions/{package.json,lib/index.js}',
  'node_modules/whatwg-url/{package.json,lib/*.js}',
];

const EXTRACTION_ROUTES = [
  '/api/documents/process',
  '/api/documents/upload',
  '/api/documents/*/evaluate',
  '/api/jobs/process/*',
];

const nextConfig: NextConfig = {
  // Prevent Next.js webpack from bundling native PDF/OCR packages.
  // These packages use Node.js-specific APIs (fs, canvas, workers) that break
  // when bundled and must be loaded directly from node_modules at runtime.
  serverExternalPackages: [
    'pdf-parse',
    'pdfjs-dist',
    'tesseract.js',
    '@napi-rs/canvas',
    '@tesseract.js-data',
  ],
  turbopack: {
    root: __dirname,
  },
  outputFileTracingIncludes: Object.fromEntries(
    EXTRACTION_ROUTES.map((route) => [route, EXTRACTION_WORKER_FILES]),
  ),
  // Every deployment stores each function's traced files, and the Hobby plan
  // counts that storage across retained deployments. Leave out what no
  // deployed function can load (docs/decisions/VERCEL_FUNCTION_SIZE.md).
  outputFileTracingExcludes: {
    '*': [
      // Vercel functions run on glibc Linux; the canvas loader picks the gnu binary.
      'node_modules/@napi-rs/canvas-linux-x64-musl/**',
      // pdf-parse loads only its default pdf.js build (v1.10.100); we never pass `version`.
      'node_modules/pdf-parse/lib/pdf.js/v1.10.88/**',
      'node_modules/pdf-parse/lib/pdf.js/v1.9.426/**',
      'node_modules/pdf-parse/lib/pdf.js/v2.0.550/**',
      // Next applies these unanchored ("contains") while tracing, so a pattern
      // must never match a file production loads: see nextConfigTracing.test.ts.
    ],
    // Evaluation workspaces serve only on localhost outside production, so on
    // Vercel they 404 before reading anything; their data never needs to ship.
    '/evaluation/**': EVALUATION_DATA,
    '/api/evaluation/**': EVALUATION_DATA,
  },
};

// withBotId adds the first-party proxy rewrites the BotID challenge is served
// through, so ad blockers and third-party script blockers cannot weaken it.
export default withBotId(nextConfig);

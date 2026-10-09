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

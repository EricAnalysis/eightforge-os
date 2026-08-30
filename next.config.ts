import { withBotId } from 'botid/next/config';
import type { NextConfig } from "next";

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
};

// withBotId adds the first-party proxy rewrites the BotID challenge is served
// through, so ad blockers and third-party script blockers cannot weaken it.
export default withBotId(nextConfig);

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
};

export default nextConfig;

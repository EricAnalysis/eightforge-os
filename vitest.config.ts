import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'tests/projectRerunAndDedupe.test.ts',
      'tests/pipelineCrossDocumentGrounding.test.ts',
      'tests/contractValidation.test.ts',
      'tests/blobExtractionSelection.test.ts',
    ],
    exclude: ['node_modules', '.next', 'e2e'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

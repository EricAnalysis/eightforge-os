import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  assertExternalEvaluationPath,
} from '@/lib/evaluation/syntheticGeneralizationHarness';

const execFileAsync = promisify(execFile);

describe('synthetic generalization evidence', () => {
  it('generates byte-identical external PDFs and ledgers from independent layouts', async () => {
    const output = await mkdtemp(
      path.join(os.tmpdir(), 'eightforge-synthetic-test-'),
    );
    try {
      await execFileAsync('python', [
        path.join(
          process.cwd(),
          'scripts',
          'phase3-step4',
          'generateSyntheticGeneralizationSources.py',
        ),
        '--output-dir',
        output,
        '--verify-determinism',
      ], {
        cwd: process.cwd(),
        timeout: 60_000,
        windowsHide: true,
      });
      const [manifest, ledgerA, ledgerB] = await Promise.all([
        readFile(
          path.join(output, 'synthetic-generation-manifest.json'),
          'utf8',
        ).then(JSON.parse),
        readFile(
          path.join(output, 'synthetic-source-a.ledger.json'),
          'utf8',
        ).then(JSON.parse),
        readFile(
          path.join(output, 'synthetic-source-b.ledger.json'),
          'utf8',
        ).then(JSON.parse),
      ]);
      expect(manifest).toMatchObject({ deterministic_regeneration: true });
      expect(manifest.sources).toHaveLength(2);
      expect(manifest.sources[0].pdf_sha256)
        .not.toBe(manifest.sources[1].pdf_sha256);
      expect(ledgerA.construction_spec_sha256)
        .not.toBe(ledgerB.construction_spec_sha256);
      expect(ledgerA.observations.map(
        (item: { field_identifier: string }) => item.field_identifier,
      ).sort()).toEqual(ledgerB.observations.map(
        (item: { field_identifier: string }) => item.field_identifier,
      ).sort());
      expect(ledgerA.structural_annotations.map(
        (item: { invariant: string }) => item.invariant,
      )).toEqual(expect.arrayContaining([
        'merged_multiline_cells',
        'subtables',
        'repeated_headers',
        'cross_page_continuation',
      ]));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('rejects repository paths for generated evidence and reports', () => {
    expect(() => assertExternalEvaluationPath(
      path.join(process.cwd(), 'tmp', 'synthetic.pdf'),
    )).toThrow(/outside the repository/);
    expect(assertExternalEvaluationPath(
      path.join(os.tmpdir(), 'synthetic.pdf'),
    )).toBe(path.resolve(os.tmpdir(), 'synthetic.pdf'));
  });

});

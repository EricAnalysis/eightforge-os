/**
 * Compare two pinned evaluation runs (scripts/evaluation/runPinnedEvaluation.ts),
 * for example Codex on Windows through Docker Desktop against Linux CI:
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/compareEvaluationRuns.ts -- <runA> <runB>
 *
 * Parity holds only when the runtime identity and every capture hash match.
 * On any difference it reports which identity fields differ, which outputs
 * differ, and, for extraction captures, the first differing paths with the
 * extraction stage they sit in (OCR, PDF text, rendering, ruling lines,
 * reconstruction/geometry, ordering). It normalizes nothing. Prints paths and
 * stages only, never row text.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { classifyDifferenceOrigin, jsonDifferences } from '@/lib/evaluation/pinnedEvaluationCapture';

type Manifest = { identity: Record<string, unknown>; runtime_identity_digest: string; observed: Record<string, unknown> };
type Hashes = { captures: Record<string, string>; capture_set_digest: string; runtime_identity_digest: string };

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as T;
}

function main(): void {
  const separator = process.argv.indexOf('--');
  const [left, right] = (separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2)).filter(Boolean);
  if (!left || !right) throw new Error('usage: compareEvaluationRuns.ts -- <runA> <runB>');
  const manifests = [readJson<Manifest>(left, 'runtime-manifest.json'), readJson<Manifest>(right, 'runtime-manifest.json')] as const;
  const hashes = [readJson<Hashes>(left, 'capture-hashes.json'), readJson<Hashes>(right, 'capture-hashes.json')] as const;
  const lines: string[] = [];

  const identityDifferences = jsonDifferences(manifests[0].identity, manifests[1].identity, 200);
  lines.push(identityDifferences.length === 0
    ? `runtime identity: identical (${manifests[0].runtime_identity_digest})`
    : `runtime identity: DIFFERS in ${identityDifferences.length} field(s)`);
  for (const difference of identityDifferences) lines.push(`  identity.${difference.path} (${difference.kind})`);

  const files = [...new Set([...Object.keys(hashes[0].captures), ...Object.keys(hashes[1].captures)])].sort();
  const differing = files.filter((file) => hashes[0].captures[file] !== hashes[1].captures[file]);
  lines.push(differing.length === 0
    ? `captures: all ${files.length} identical (${hashes[0].capture_set_digest})`
    : `captures: ${differing.length} of ${files.length} DIFFER`);
  for (const file of differing) {
    lines.push(`  ${file}: ${hashes[0].captures[file] ?? 'absent'} vs ${hashes[1].captures[file] ?? 'absent'}`);
    if (!hashes[0].captures[file] || !hashes[1].captures[file]) continue;
    const a = JSON.parse(readFileSync(path.join(left, file), 'utf8')) as unknown;
    const b = JSON.parse(readFileSync(path.join(right, file), 'utf8')) as unknown;
    const differences = jsonDifferences(a, b, 25);
    const stages = new Map<string, number>();
    for (const difference of differences) {
      const stage = classifyDifferenceOrigin(difference);
      stages.set(stage, (stages.get(stage) ?? 0) + 1);
    }
    lines.push(`    stages (first ${differences.length} differing paths): ${[...stages].map(([stage, count]) => `${stage} ${count}`).join(', ')}`);
    for (const difference of differences.slice(0, 10)) {
      lines.push(`    ${difference.kind} ${difference.path} [${classifyDifferenceOrigin(difference)}]`);
    }
  }

  const parity = identityDifferences.length === 0 && differing.length === 0;
  lines.push(parity ? 'PARITY: yes' : 'PARITY: NO -- stop and report; do not normalize differences away');
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!parity) process.exitCode = 2;
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

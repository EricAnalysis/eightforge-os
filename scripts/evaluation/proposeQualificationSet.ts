/**
 * B4.6.1 qualification-set proposal -- explicit, manual, offline.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/proposeQualificationSet.ts -- \
 *     --inventory <inventory.json> [--inventory <inventory.json>]... [--labelled <identities.json>] --out <proposal.json>
 *
 * Reads resolution evidence inventories (buildResolutionEvidenceInventory.ts or
 * runPinnedEvaluation.ts output) and writes the typed proposal from
 * lib/evaluation/benchmark/qualificationSet.ts. --labelled is a JSON array of
 * identities that already have tracked, human-approved truth; nothing here
 * creates labels. No database, provider or network. The proposal holds only
 * identities and counts, but stays with the inventories outside the repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { proposeQualificationSet } from '@/lib/evaluation/benchmark/qualificationSet';
import type { ResolutionEvidenceInventory } from '@/lib/evaluation/resolutionEvidenceInventory';

function args(name: string): string[] {
  return process.argv.flatMap((value, index) => (value === name ? [process.argv[index + 1] ?? ''] : []));
}

function main(): void {
  const out = args('--out')[0];
  const inventoryFiles = args('--inventory');
  if (!out || inventoryFiles.length === 0) throw new Error('--inventory <file> (repeatable) and --out <file> are required');
  const relative = path.relative(process.cwd(), path.resolve(out));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('--out must be outside the repository');
  const inventories = inventoryFiles.map((file) => {
    const inventory = JSON.parse(readFileSync(file, 'utf8')) as ResolutionEvidenceInventory;
    if (inventory.schema !== 'resolution_evidence_inventory_v1') throw new Error(`${file}: not a resolution evidence inventory`);
    return inventory;
  });
  const labelledFile = args('--labelled')[0];
  const labelled = labelledFile ? new Set(JSON.parse(readFileSync(labelledFile, 'utf8')) as string[]) : undefined;
  const proposal = proposeQualificationSet({ inventories, labelledIdentities: labelled });
  writeFileSync(out, `${JSON.stringify(proposal, null, 2)}\n`);
  const lines = [`${proposal.version}: minimum ${proposal.minTargetsPerClass} targets per class; proposal ${proposal.proposalDigest}`];
  for (const entry of proposal.classes) {
    lines.push(`  ${entry.task}: ${entry.status} (${entry.targets} targets, ${entry.labelled} labelled, ${entry.alsoCategory} also need category) ${JSON.stringify(entry.documents)}`);
  }
  lines.push(`  excluded overlaps: ${proposal.excludedOverlaps.length}; out of scope: ${JSON.stringify(proposal.outOfScope)}`, `-> ${out}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

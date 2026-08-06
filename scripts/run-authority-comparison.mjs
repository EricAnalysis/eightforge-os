/**
 * Run the non-serving legacy-versus-canonical authority comparison for one or more
 * projects and print the operator review report.
 *
 *   npm run compare:authority -- <projectId> [<projectId> ...]
 *   npm run compare:authority -- --no-persist <projectId>
 *
 * The npm script supplies `--experimental-transform-types`. Bare `node` is not
 * enough: repo source uses TypeScript parameter properties, which Node's default
 * strip-only mode cannot transform. `./lib/registerRepoAlias.mjs` covers the other
 * half — the `@/` alias and extensionless specifiers.
 *
 * This is READ-ONLY with respect to validation. It never persists a validation
 * result, never publishes canonical truth, never changes project state, and never
 * changes which authority serves production. The only write it performs is the
 * comparison audit artifact, and `--no-persist` suppresses even that.
 *
 * The project ids are supplied on the command line rather than read from a
 * hardcoded cohort: the initial cohort is an operator decision, and baking
 * production ids into the repository would both leak them and make the harness
 * unreproducible on a fresh checkout.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';

import { registerRepoAlias } from './lib/registerRepoAlias.mjs';

config({ path: '.env.local' });

// The comparison modules import each other through the repo's `@/` alias, which
// bare `node` does not resolve. Registered before any dynamic import below.
registerRepoAlias(path.resolve(fileURLToPath(import.meta.url), '../..'));

const args = process.argv.slice(2);
const persist = !args.includes('--no-persist');
const projectIds = args.filter((arg) => !arg.startsWith('--'));

if (projectIds.length === 0) {
  console.error('Usage: node scripts/run-authority-comparison.mjs [--no-persist] <projectId> [...]');
  process.exit(2);
}

async function main() {
  const { runProjectTruthAuthorityComparison } = await import(
    '../lib/canonical/comparison/runProjectTruthAuthorityComparison.ts'
  );
  const { renderAuthorityComparisonReport } = await import(
    '../lib/canonical/comparison/authorityComparisonReport.ts'
  );
  const { persistAuthorityComparison } = await import(
    '../lib/canonical/comparison/authorityComparisonPersistence.ts'
  );
  const { isFailedComparison } = await import(
    '../lib/canonical/comparison/authorityComparisonModel.ts'
  );

  let blockingTotal = 0;

  for (const projectId of projectIds) {
    const outcome = await runProjectTruthAuthorityComparison(projectId);

    if (isFailedComparison(outcome)) {
      // A comparator failure is reported, not thrown: the operator needs to know
      // the comparison could not complete, and one bad project must not abort the
      // rest of the cohort.
      console.error(`\n### ${projectId}: comparison_failed\n${outcome.failureReason}\n`);
      continue;
    }

    console.log(`\n${renderAuthorityComparisonReport({ comparison: outcome })}`);
    blockingTotal += outcome.classificationSummary.blockingDeltas;

    if (persist) {
      const result = await persistAuthorityComparison({ outcome });
      console.log(`> comparison artifact: ${result.status}`
        + (result.status === 'written' || result.status === 'duplicate_suppressed'
          ? ` at ${result.record.artifactReference}`
          : ` — ${result.reason}`));
    }
  }

  console.log(`\n> ${projectIds.length} project(s) compared; ${blockingTotal} blocking delta(s) total.`);
  console.log('> Promotion requires operator acceptance of every material delta, not parity alone.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

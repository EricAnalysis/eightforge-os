// Build-time identity of the evaluation image's source tree (Dockerfile.eval).
// Runs before `npm ci`, over exactly the files `git archive` sent as context:
// each file's SHA-256 and POSIX path, sorted. Raw bytes, never normalized, so a
// line-ending or content difference shows up as a different digest.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [commit, root] = process.argv.slice(2);
if (!commit || !root) throw new Error('usage: source-tree-digest.mjs <commit> <root>');

const entries = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (stat.isFile()) {
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
      entries.push([path.relative(root, full).split(path.sep).join('/'), hash]);
    }
  }
};
walk(root);
entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const listing = entries.map(([file, hash]) => `${hash}  ${file}`).join('\n');
process.stdout.write(`${JSON.stringify({
  schema: 'eightforge_eval_build_info_v1',
  source_commit: commit,
  source_tree_digest: createHash('sha256').update(`${listing}\n`).digest('hex'),
  source_file_count: entries.length,
  source_context: 'git_archive',
}, null, 2)}\n`);

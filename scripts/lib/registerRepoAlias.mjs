/**
 * Makes the repository's TypeScript modules importable from plain `node`.
 *
 * Two things stand between an operator script and `lib/`, and both are invisible
 * until someone actually runs the script:
 *
 *  1. **The `@/` alias.** `tsconfig.json` maps `@/*` to the repo root and
 *     `vitest.config.ts` mirrors it, so application code and tests resolve
 *     `@/lib/...` normally. Bare `node` honors neither and treats it as a bare
 *     package specifier: `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`.
 *  2. **Extensionless specifiers.** Repo modules import each other as
 *     `'./authorityComparisonDelta'` and `'@/lib/validator/shared'`. TypeScript and
 *     Vite resolve the extension; Node ESM requires it explicitly.
 *
 * Both are handled here so any script that reaches into `lib/` works, including
 * for modules the script never names directly — the failure surfaces several
 * imports deep, which is exactly where it is most confusing.
 *
 * Implemented with `module.registerHooks`, which is built into Node. Adding a
 * loader dependency for this would be a poor trade: a runtime dependency in an
 * operator harness is one more thing that can be missing at the moment someone
 * needs the harness to work.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ALIAS = '@/';
/** Probed in order. `.ts` first because repo source is TypeScript. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx'];

function existingFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}

/**
 * Resolves an extensionless path the way TypeScript and Vite would.
 *
 * Returns null when the path already points at a real file, so an explicit
 * specifier is never rewritten.
 */
function withResolvedExtension(filePath) {
  if (existingFile(filePath)) return null;
  for (const extension of EXTENSIONS) {
    const candidate = `${filePath}${extension}`;
    if (existingFile(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(filePath, `index${extension}`);
    if (existingFile(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {string} repoRoot Absolute path the `@/` alias resolves against.
 */
export function registerRepoAlias(repoRoot) {
  const root = path.resolve(repoRoot);
  const rootUrl = pathToFileURL(`${root}${path.sep}`).href;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const aliased = specifier.startsWith(ALIAS);
      // A bare package specifier that is not the alias belongs to node_modules and
      // must keep Node's own resolution, including its package.json exports.
      if (!aliased && !specifier.startsWith('.') && !specifier.startsWith('file:')) {
        return nextResolve(specifier, context);
      }

      const base = aliased ? rootUrl : context.parentURL;
      if (!base) return nextResolve(specifier, context);

      let targetUrl;
      try {
        targetUrl = new URL(aliased ? specifier.slice(ALIAS.length) : specifier, base);
      } catch {
        return nextResolve(specifier, context);
      }
      if (targetUrl.protocol !== 'file:') return nextResolve(specifier, context);

      const filePath = fileURLToPath(targetUrl);
      // node_modules keeps Node's resolution; rewriting inside a dependency would
      // bypass its package.json exports and could load internals it does not expose.
      if (filePath.includes(`${path.sep}node_modules${path.sep}`)) {
        return nextResolve(specifier, context);
      }

      const resolved = withResolvedExtension(filePath);
      return nextResolve(
        resolved != null ? pathToFileURL(resolved).href : targetUrl.href,
        context,
      );
    },
  });
}

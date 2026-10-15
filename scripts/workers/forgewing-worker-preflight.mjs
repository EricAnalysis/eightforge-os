#!/usr/bin/env node
// Forgewing Engineering Worker host preflight (S8).
//
// Run on the worker host BEFORE starting the worker, with the same environment
// the container will get. Read-only: it never calls Supabase or Anthropic,
// never prints a secret, and never changes the checkout. Exit 0 only when every
// required check passes; any failure exits 1 (fail closed).
//
//   node scripts/workers/forgewing-worker-preflight.mjs --checkout /srv/eightforge-checkout --image-commit <sha>
//
// It reports, but does not require, the provider gates: the worker is useful
// with them OFF (ADVISORY jobs complete with zero provider calls).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const QUALIFIED_MODELS = ['claude-sonnet-4-6']; // mirrors FORGEWING_QUALIFIED_MODELS (modelConfig.ts)
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const checkout = option('--checkout') ?? process.env.FORGEWING_WORKER_HOST_CHECKOUT;
const imageCommit = option('--image-commit');
const env = process.env;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const info = (name, detail) => results.push({ name, ok: null, detail });

function jwtRole(token) {
  try {
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { role: claims.role ?? null, exp: typeof claims.exp === 'number' ? claims.exp : null };
  } catch {
    return { role: null, exp: null };
  }
}
const git = (...gitArgs) => execFileSync('git', ['-C', checkout, ...gitArgs], {
  encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// Supabase target and dedicated role.
check('SUPABASE_URL set', env.SUPABASE_URL?.trim());
check('SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) set',
  (env.SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim());
check('SUPABASE_SERVICE_ROLE_KEY absent from the worker environment', !env.SUPABASE_SERVICE_ROLE_KEY);
const token = env.FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN?.trim();
const claims = token ? jwtRole(token) : { role: null, exp: null };
check('worker token role is exactly forgewing_engineering_worker', claims.role === 'forgewing_engineering_worker',
  token ? `role=${claims.role ?? 'unreadable'}` : 'token missing');
if (claims.exp != null) {
  const days = Math.floor((claims.exp * 1000 - Date.now()) / 86_400_000);
  check('worker token not expired, and expires within 90 days', days >= 0 && days <= 90, `expires in ${days} days`);
}

// Checkout: real, clean, at the image's commit.
if (!checkout) {
  check('checkout path given (--checkout)', false);
} else {
  check('checkout is a Git repository', existsSync(path.join(checkout, '.git')), checkout);
  if (existsSync(path.join(checkout, '.git'))) {
    let head = '';
    try { head = git('rev-parse', 'HEAD'); } catch { /* reported below */ }
    check('checkout HEAD readable', head, head);
    let dirty = 'unknown';
    try { dirty = git('status', '--porcelain', '--untracked-files=all'); } catch { /* reported */ }
    check('checkout is clean', dirty === '', dirty === '' ? '' : 'uncommitted or untracked files present');
    if (imageCommit) check('checkout HEAD equals the image commit', head.startsWith(imageCommit) || imageCommit.startsWith(head),
      `head=${head.slice(0, 12)} image=${imageCommit.slice(0, 12)}`);
    else info('image commit', 'not given (--image-commit); build the image from this same commit');
  }
}

// Provider gates: reported, never required.
const on = (name) => env[name] === '1';
const model = env.FORGEWING_MODEL?.trim() || env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-6';
info('provider reasoning', on('FORGEWING_SHADOW_ENABLED') && on('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED')
  ? 'ENABLED (both gates = 1)' : 'off: ADVISORY / insufficient-evidence jobs only (zero provider calls)');
info('model', `${model} (${QUALIFIED_MODELS.includes(model) ? 'qualified' : 'NOT qualified: provider reasoning stays disabled'})`);
if (on('FORGEWING_SHADOW_ENABLED') && on('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED')) {
  check('ANTHROPIC_API_KEY set when provider reasoning is enabled', env.ANTHROPIC_API_KEY?.trim());
}

let failed = 0;
for (const result of results) {
  const mark = result.ok === null ? 'INFO' : result.ok ? 'PASS' : 'FAIL';
  if (result.ok === false) failed += 1;
  console.log(`${mark.padEnd(4)}  ${result.name}${result.detail ? `  (${result.detail})` : ''}`);
}
console.log(failed === 0 ? 'PREFLIGHT: PASS' : `PREFLIGHT: FAIL (${failed})`);
process.exitCode = failed === 0 ? 0 : 1;

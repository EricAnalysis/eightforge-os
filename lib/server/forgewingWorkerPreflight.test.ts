import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FORGEWING_QUALIFIED_MODELS } from '@/lib/forgewing/runtime/modelConfig';

const SCRIPT = 'scripts/workers/forgewing-worker-preflight.mjs';

function run(env: Record<string, string>): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--checkout', process.cwd()], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? -1, output: failure.stdout ?? '' };
  }
}

const token = (role: string) => {
  const b = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ role, exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })}.signature-secret-part`;
};

describe('Forgewing worker host preflight (S8)', () => {
  it('mirrors the code qualified-model list', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const listed = /const QUALIFIED_MODELS = (\[[^\]]*\])/.exec(script)?.[1];
    expect(JSON.parse((listed ?? '[]').replace(/'/g, '"'))).toEqual([...FORGEWING_QUALIFIED_MODELS]);
  });

  it('fails closed without a worker token, or with a service-role token or key', () => {
    expect(run({ SUPABASE_URL: 'x', SUPABASE_PUBLISHABLE_KEY: 'y' }).code).toBe(1);
    const serviceRole = run({ SUPABASE_URL: 'x', SUPABASE_PUBLISHABLE_KEY: 'y',
      FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN: token('service_role') });
    expect(serviceRole.code).toBe(1);
    expect(serviceRole.output).toContain('FAIL  worker token role is exactly forgewing_engineering_worker');
    const withKey = run({ SUPABASE_URL: 'x', SUPABASE_PUBLISHABLE_KEY: 'y', SUPABASE_SERVICE_ROLE_KEY: 'k',
      FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN: token('forgewing_engineering_worker') });
    expect(withKey.output).toContain('FAIL  SUPABASE_SERVICE_ROLE_KEY absent from the worker environment');
  }, 60_000);

  it('never prints the token', () => {
    const secret = token('forgewing_engineering_worker');
    const result = run({ SUPABASE_URL: 'x', SUPABASE_PUBLISHABLE_KEY: 'y', FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN: secret });
    expect(result.output).not.toContain('signature-secret-part');
    expect(result.output).not.toContain(secret.split('.')[1]!);
  }, 60_000);
});

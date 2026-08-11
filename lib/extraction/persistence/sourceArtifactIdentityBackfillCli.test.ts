import { describe, expect, it } from 'vitest';

import {
  parseSourceIdentityBackfillOptions,
  validateSourceIdentityBackfillInvocation,
} from './sourceArtifactIdentityBackfillCli';

const REQUIRED = ['--target=project-ref', '--organization-id=org-1'] as const;

describe('source identity backfill CLI safety', () => {
  it.each([
    '--page-size=abc',
    '--page-size',
    '--page-size=1.5',
    '--page-size=0',
    '--page-size=-1',
    '--page-size=Infinity',
    '--max-documents=abc',
    '--max-documents',
    '--max-documents=1.5',
    '--max-documents=0',
    '--max-documents=-1',
    '--max-documents=Infinity',
  ])('rejects invalid numeric argument %s', (argument) => {
    expect(() => parseSourceIdentityBackfillOptions([...REQUIRED, argument]))
      .toThrow(/must be a positive integer/);
  });

  it('accepts finite positive integer page limits', () => {
    const options = parseSourceIdentityBackfillOptions([
      ...REQUIRED,
      '--page-size=25',
      '--max-documents=50',
    ]);
    expect(options).toMatchObject({ pageSize: 25, maxDocuments: 50 });
  });

  it('rejects a target mismatch before returning a runnable invocation', () => {
    expect(() => validateSourceIdentityBackfillInvocation(
      ['--target=staging', '--organization-id=org-1'],
      'https://project-ref.supabase.co',
    )).toThrow(/does not match SUPABASE_URL/);
  });

  it.each(['project-ref', 'project-ref.supabase.co'])(
    'accepts target %s for the matching hosted project',
    (target) => {
      const invocation = validateSourceIdentityBackfillInvocation(
        [`--target=${target}`, '--organization-id=org-1'],
        'https://project-ref.supabase.co',
      );
      expect(invocation.environment).toEqual({
        actualHost: 'project-ref.supabase.co',
        identity: 'project-ref',
      });
    },
  );

  it('requires the actual project identity in the write confirmation', () => {
    const args = ['--target=project-ref', '--organization-id=org-1', '--write'];
    expect(() => validateSourceIdentityBackfillInvocation(
      [...args, '--confirm=BACKFILL_SOURCE_IDENTITY'],
      'https://project-ref.supabase.co',
    )).toThrow(/BACKFILL_SOURCE_IDENTITY:project-ref/);

    expect(validateSourceIdentityBackfillInvocation(
      [...args, '--confirm=BACKFILL_SOURCE_IDENTITY:project-ref'],
      'https://project-ref.supabase.co',
    ).options.write).toBe(true);
  });

  it('accepts local only for loopback URLs', () => {
    expect(validateSourceIdentityBackfillInvocation(
      ['--target=local', '--organization-id=org-1'],
      'http://127.0.0.1:54321',
    ).environment.identity).toBe('127.0.0.1:54321');
    expect(() => validateSourceIdentityBackfillInvocation(
      ['--target=local', '--organization-id=org-1'],
      'https://project-ref.supabase.co',
    )).toThrow(/does not match SUPABASE_URL/);
  });
});

import { z } from 'zod';

/** Transport shape only: schema validation does not establish local Git trust. */
export const RepositorySnapshotSchema = z.object({
  repositoryUrl: z.string().max(2048).regex(/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/)
    .refine((value) => !value.endsWith('.git') && !value.split('/').some((part) => part === '.' || part === '..')),
  objectFormat: z.literal('sha1'),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  branchName: z.string().min(1).max(1024).refine((value) => !/[\x00-\x20\x7f]/.test(value)).nullable(),
  worktreeDirty: z.literal(false),
  untrackedPolicy: z.literal('excluded_from_trusted_manifest'),
  submoduleStatus: z.object({ state: z.literal('none') }).strict().readonly(),
}).strict().readonly();

export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

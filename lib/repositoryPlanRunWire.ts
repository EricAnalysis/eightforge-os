import { z } from 'zod';

import { ImplementationPlanPinSchema } from '@/lib/workflowImplementationPlanWire';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryPlanRunClassificationSchema = z.enum([
  'RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY',
]);

export const RepositoryPlanRunRequestSchema = ImplementationPlanPinSchema.extend({
  classification: RepositoryPlanRunClassificationSchema,
}).strict();
export type RepositoryPlanRunRequest = z.infer<typeof RepositoryPlanRunRequestSchema>;

export const RepositoryPlanRunPublicFailureCodeSchema = z.enum([
  'provider_disabled',
  'provider_timeout',
  'provider_failed',
  'invalid_provider_output',
  'trusted_source_invalid',
  'repository_mismatch',
  'persistence_failed',
  'worker_failed',
]);

const identity = z.object({
  jobId: z.string().uuid(),
  classification: RepositoryPlanRunClassificationSchema,
}).strict();

export const RepositoryPlanRunCreatedResponseSchema = z.object({
  ok: z.literal(true),
  job: identity.extend({ status: z.literal('pending') }).strict(),
}).strict();

export const RepositoryPlanRunFailureResponseSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    'unauthorized',
    'reviewer_not_eligible',
    'invalid_request',
    'invalid_job_id',
    'invalid_pin',
    'classification_not_present',
    'not_found',
    'not_configured',
    'read_failed',
    'create_failed',
  ]),
}).strict();

const result = z.object({
  planV2RunId: z.string().uuid(),
  planV2DigestSha256: digest,
  repositoryCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  providerCallCount: z.union([z.literal(0), z.literal(1)]),
}).strict();

export const RepositoryPlanRunReadResponseSchema = z.union([
  RepositoryPlanRunFailureResponseSchema,
  z.object({ ok: z.literal(true), job: identity.extend({ status: z.literal('pending') }).strict() }).strict(),
  z.object({ ok: z.literal(true), job: identity.extend({ status: z.literal('claimed') }).strict() }).strict(),
  z.object({
    ok: z.literal(true),
    job: identity.extend({
      status: z.literal('failed'),
      failureCode: RepositoryPlanRunPublicFailureCodeSchema,
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    job: identity.extend({ status: z.literal('succeeded'), result }).strict(),
  }).strict(),
]);

export type RepositoryPlanRunReadResponse = z.infer<typeof RepositoryPlanRunReadResponseSchema>;

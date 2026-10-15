import { z } from 'zod';

export interface InstructorLikeClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

export interface StructuredOutputResult<T> {
  status: 'applied' | 'skipped' | 'failed';
  data: T | null;
  attempts: number;
  model: string | null;
  warnings: string[];
}

/**
 * Explicit opt-in only. An OPENAI_API_KEY on its own never enables the assist:
 * it is a provider path outside the Forgewing gates, so it stays off unless
 * EIGHTFORGE_INSTRUCTOR_ENABLED is exactly '1'.
 */
export function isInstructorEnabled(): boolean {
  return process.env.EIGHTFORGE_INSTRUCTOR_ENABLED === '1'
    && typeof process.env.OPENAI_API_KEY === 'string'
    && process.env.OPENAI_API_KEY.trim().length > 0;
}

/**
 * No governed provider path exists (census D4, 2026-10-15). The assist sends
 * customer document text to OpenAI, which is not an approvable data-policy
 * provider (the ledger approves 'anthropic' only), and it has no entitlement,
 * durable budget or qualified model. So even when opted in, no provider client
 * is built and the assist is skipped, auditable in its warnings. The opt-in is
 * kept; re-enabling is a governed project (data-policy provider, entitlement,
 * text_excerpts, durable budget). Output was evidence only (S1).
 */
export const INSTRUCTOR_PROVIDER_GOVERNED = false;

function createDefaultClient(): InstructorLikeClient | null {
  return null;
}

/** Retries are bounded in code: an env value can lower them, never raise them past the cap. */
export const MAX_INSTRUCTOR_RETRIES = 3;

export function parseRetryCount(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.floor(parsed), MAX_INSTRUCTOR_RETRIES) : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runStructuredOutput<T>(params: {
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  user: string;
  maxRetries?: number;
  client?: InstructorLikeClient | null;
  createClient?: () => InstructorLikeClient | null;
}): Promise<StructuredOutputResult<T>> {
  const maxRetries = Math.min(params.maxRetries
    ?? parseRetryCount(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES, 2), MAX_INSTRUCTOR_RETRIES);
  const warnings: string[] = [];
  const client =
    params.client
    ?? params.createClient?.()
    ?? createDefaultClient();

  if (!client) {
    return {
      status: 'skipped',
      data: null,
      attempts: 0,
      model: null,
      warnings: [isInstructorEnabled()
        ? 'Instructor assist skipped: no governed provider path (not an approved data-policy provider).'
        : 'Instructor assist skipped: OPENAI_API_KEY is not configured or instructor is disabled.'],
    };
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: params.model,
        temperature: 0,
        max_retries: 0,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        response_model: {
          schema: params.schema,
          name: params.schemaName,
        },
      });

      const parsed = params.schema.safeParse(response);
      if (parsed.success) {
        return {
          status: 'applied',
          data: parsed.data,
          attempts: attempt,
          model: params.model,
          warnings,
        };
      }

      warnings.push(
        `Attempt ${attempt} returned invalid structured output: ${parsed.error.issues
          .slice(0, 2)
          .map((issue) => issue.message)
          .join('; ')}`,
      );
    } catch (error) {
      warnings.push(`Attempt ${attempt} failed: ${errorMessage(error)}`);
    }
  }

  return {
    status: 'failed',
    data: null,
    attempts: maxRetries + 1,
    model: params.model,
    warnings,
  };
}

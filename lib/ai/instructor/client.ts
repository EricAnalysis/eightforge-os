import createInstructor from '@instructor-ai/instructor';
import OpenAI from 'openai';
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

function isInstructorEnabled(): boolean {
  return process.env.EIGHTFORGE_INSTRUCTOR_ENABLED !== '0'
    && typeof process.env.OPENAI_API_KEY === 'string'
    && process.env.OPENAI_API_KEY.trim().length > 0;
}

function createDefaultClient(): InstructorLikeClient | null {
  if (!isInstructorEnabled()) return null;

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  return createInstructor({
    client,
    mode: 'TOOLS',
  }) as unknown as InstructorLikeClient;
}

function parseRetryCount(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
  const maxRetries = params.maxRetries
    ?? parseRetryCount(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES, 2);
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
      warnings: ['Instructor assist skipped: OPENAI_API_KEY is not configured or instructor is disabled.'],
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

// Server-only Anthropic Claude client. Never import from client components.

import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Transport ceiling for Claude requests, above every per-call timeout.
 *
 * Node's fetch (undici) stops waiting for response headers, and between body
 * chunks, after 300 s by default. A non-streaming Messages response sends its
 * headers only when generation finishes, so that hidden limit would end a
 * long Workflow Assessment (600 s timeout) at 300 s with a connection error
 * instead of its own explicit timeout. Every call passes an explicit
 * `timeout`, so the per-call deadline still fires first. This only removes the
 * shorter transport default; it never extends a call beyond its own timeout.
 */
export const CLAUDE_TRANSPORT_TIMEOUT_MS = 720_000;

const claudeTransport = new Agent({
  headersTimeout: CLAUDE_TRANSPORT_TIMEOUT_MS,
  bodyTimeout: CLAUDE_TRANSPORT_TIMEOUT_MS,
});

let cachedClient: Anthropic | null = null;

export function getClaudeModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
}

export function getClaudeExtractorModel(): string {
  return process.env.ANTHROPIC_EXTRACTOR_MODEL?.trim() || getClaudeModel();
}

export function getClaudeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.');
  }

  if (!cachedClient) {
    // Backstop only: every call passes its own bounds (Forgewing request
    // contracts or CLAUDE_REQUEST_OPTIONS). Never the SDK's 10-minute default.
    cachedClient = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 0,
      fetchOptions: { dispatcher: claudeTransport } });
  }

  return cachedClient;
}

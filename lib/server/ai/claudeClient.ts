// Server-only Anthropic Claude client. Never import from client components.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

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
    cachedClient = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 0 });
  }

  return cachedClient;
}

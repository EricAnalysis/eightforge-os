// Server-only Anthropic Claude client. Never import from client components.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

let cachedClient: Anthropic | null = null;

export function getClaudeModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
}

export function getClaudeClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.');
  }

  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey });
  }

  return cachedClient;
}

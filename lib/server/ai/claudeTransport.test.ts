// D2: the shared Claude client must not inherit Node fetch's 300 s transport
// defaults, which would end a 600 s Workflow Assessment before its own timeout.
// Provider-free: the network is a local HTTP server.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS } from '@/lib/forgewing/runtime/modelConfig';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

/** Answers /v1/messages only after `delayMs`, as a non-streaming response does. */
async function delayedServer(delayMs: number) {
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_local' });
      response.end(JSON.stringify({ id: 'msg_local', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const BODY = { model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user' as const, content: 'x' }] };

describe('Claude transport ceiling (D2)', () => {
  it('sits above the longest Workflow Assessment timeout', async () => {
    const { CLAUDE_TRANSPORT_TIMEOUT_MS } = await import('@/lib/server/ai/claudeClient');
    expect(CLAUDE_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS);
    // Node fetch's undici default is 300 s for headers and between body chunks.
    expect(WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it('gives the shared client its own undici dispatcher', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    const { getClaudeClient } = await import('@/lib/server/ai/claudeClient');
    const client = getClaudeClient() as unknown as { fetchOptions?: { dispatcher?: unknown } };
    expect(client.fetchOptions?.dispatcher).toBeInstanceOf(Agent);
  });

  // undici timers have roughly one-second resolution, so the timings are in seconds.
  it('applies the client dispatcher to the SDK fetch, so its timeouts govern the transport', async () => {
    const { server, url } = await delayedServer(3_000);
    try {
      // A dispatcher shorter than the response ends the call even though the
      // per-call timeout is longer. The SDK reports it as a connection timeout,
      // which is exactly how Node's hidden 300 s default would have surfaced.
      const strict = new Anthropic({ apiKey: 'test-key-not-real', baseURL: url, maxRetries: 0, timeout: 10_000,
        fetchOptions: { dispatcher: new Agent({ headersTimeout: 1_000, bodyTimeout: 1_000 }) } });
      await expect(strict.messages.create(BODY)).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);

      const ceiling = new Anthropic({ apiKey: 'test-key-not-real', baseURL: url, maxRetries: 0, timeout: 10_000,
        fetchOptions: { dispatcher: new Agent({ headersTimeout: 6_000, bodyTimeout: 6_000 }) } });
      await expect(ceiling.messages.create(BODY)).resolves.toMatchObject({ id: 'msg_local' });
    } finally {
      server.close();
    }
  }, 20_000);

  it('still lets the per-call timeout fire first', async () => {
    const { server, url } = await delayedServer(1_500);
    try {
      process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
      process.env.ANTHROPIC_BASE_URL = url;
      const { getClaudeClient } = await import('@/lib/server/ai/claudeClient');
      await expect(getClaudeClient().messages.create(BODY, { timeout: 300 }))
        .rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    } finally {
      server.close();
    }
  });
});

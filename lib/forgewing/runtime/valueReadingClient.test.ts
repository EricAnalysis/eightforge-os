import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildValueReadingMessagesRequest,
  createClaudeValueReadingProvider,
  isValueReadingProviderConfigured,
  loadValueReadingPrompt,
  valueReadingProviderModel,
} from '@/lib/forgewing/runtime/valueReadingClient';
import {
  VALUE_READING_EXECUTION,
  VALUE_READING_OUTPUT_JSON_SCHEMA,
  type ValueReadingProviderRequest,
} from '@/lib/server/valueReadingEngine';

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

const REQUEST: ValueReadingProviderRequest = {
  requestDigestSha256: 'd'.repeat(64),
  renderDigestSha256: sha(BYTES),
  model: 'model-under-test',
  timeoutMs: VALUE_READING_EXECUTION.timeoutMs,
  maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens,
  promptTemplateId: VALUE_READING_EXECUTION.promptTemplateId,
  promptTemplateVersion: VALUE_READING_EXECUTION.promptTemplateVersion,
  outputSchemaVersion: VALUE_READING_EXECUTION.outputSchemaVersion,
  image: { mediaType: 'image/png', bytes: BYTES },
  textExcerpts: null,
};

describe('value-reading provider request (B4.5)', () => {
  it('sends exactly the rendered bytes, the prompt and the schema, at temperature 0 with no SDK retries', () => {
    const built = buildValueReadingMessagesRequest(REQUEST, 'PROMPT');
    // Compile-time proof that the body is a valid SDK request (tsc checks this file).
    const sdkBody: Anthropic.MessageCreateParamsNonStreaming = built.body;
    expect(sdkBody.model).toBe('model-under-test');
    expect(built.options).toEqual({ timeout: VALUE_READING_EXECUTION.timeoutMs, maxRetries: 0 });
    expect(Object.keys(built.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system', 'temperature']);
    expect(built.body).toMatchObject({ model: 'model-under-test', temperature: 0, max_tokens: 300, system: 'PROMPT' });
    expect(built.body.output_config.format.schema).toBe(VALUE_READING_OUTPUT_JSON_SCHEMA);
    expect(built.body.messages).toHaveLength(1);
    const [image, text] = built.body.messages[0]!.content;
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(BYTES).toString('base64') } });
    // The transmitted image decodes to exactly the bytes the request digest names.
    expect(sha(new Uint8Array(Buffer.from((image as { source: { data: string } }).source.data, 'base64'))))
      .toBe(REQUEST.renderDigestSha256);
    // No text from the document unless the engine asked for it.
    expect(JSON.parse((text as { text: string }).text)).toEqual({ task: 'read_priced_line',
      output_schema_version: VALUE_READING_EXECUTION.outputSchemaVersion });
  });

  it('carries text excerpts only when the engine included them', () => {
    const built = buildValueReadingMessagesRequest({ ...REQUEST,
      textExcerpts: { targetLineText: 'Debris CY sia 50', neighbouringLineTexts: ['Hauling TON $8.75'] } }, 'PROMPT');
    expect(JSON.parse((built.body.messages[0]!.content[1] as { text: string }).text)).toEqual({
      task: 'read_priced_line', output_schema_version: VALUE_READING_EXECUTION.outputSchemaVersion,
      text_excerpts: { target_line: 'Debris CY sia 50', neighbouring_lines: ['Hauling TON $8.75'] } });
  });

  it('refuses an image that is not the digested bytes, a missing model, or another contract', () => {
    expect(() => buildValueReadingMessagesRequest({ ...REQUEST, renderDigestSha256: 'e'.repeat(64) }, 'P'))
      .toThrow('render_digest_mismatch');
    expect(() => buildValueReadingMessagesRequest({ ...REQUEST, image: { mediaType: 'image/png', bytes: new Uint8Array([9]) } }, 'P'))
      .toThrow('render_digest_mismatch');
    expect(() => buildValueReadingMessagesRequest({ ...REQUEST, model: null }, 'P')).toThrow('provider_model_missing');
    for (const changed of [{ promptTemplateVersion: 'v1' }, { promptTemplateId: 'other' }, { outputSchemaVersion: 'value_reading_output_v1' }]) {
      expect(() => buildValueReadingMessagesRequest({ ...REQUEST, ...changed }, 'P')).toThrow('value_reading_contract_mismatch');
    }
  });

  it('pins the v2 prompt bytes: editing the prompt requires a new template version', () => {
    const prompt = readFileSync(path.join(process.cwd(), 'lib/forgewing/prompts/valueReading.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(VALUE_READING_EXECUTION.promptTemplateVersion).toBe('v2');
    expect(sha(prompt)).toBe('17ba8da5a1efdb172a6b347ce0bdc43c798e97a08b6098e400144a4d9c1bbcad');
    expect(loadValueReadingPrompt().replace(/\r\n/g, '\n')).toBe(prompt);
  });
});

describe('value-reading provider (B4.5)', () => {
  const message = (text: string, stopReason = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason: stopReason });

  it('returns the raw structured output text, passing the abort signal through', async () => {
    const create = vi.fn(async () => message('{"reading":"unreadable"}'));
    const provider = createClaudeValueReadingProvider({ model: 'm', prompt: 'PROMPT', client: () => ({ messages: { create } }) });
    const controller = new AbortController();
    expect(provider.providerModel).toBe('m');
    expect(await provider.read(REQUEST, controller.signal)).toBe('{"reading":"unreadable"}');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ system: 'PROMPT' }),
      { timeout: VALUE_READING_EXECUTION.timeoutMs, maxRetries: 0, signal: controller.signal });
  });

  it('turns truncation, refusal and abort into provider failures, never into a reading', async () => {
    const run = (create: () => Promise<unknown>, signal = new AbortController().signal) =>
      createClaudeValueReadingProvider({ model: 'm', prompt: 'P', client: () => ({ messages: { create } }) as never }).read(REQUEST, signal);
    await expect(run(async () => message('{"reading":', 'max_tokens'))).rejects.toThrow('provider_truncated_output');
    await expect(run(async () => message('', 'refusal'))).rejects.toThrow('provider_refusal');
    const aborted = new AbortController();
    aborted.abort();
    await expect(run(async () => { throw new Error('socket closed'); }, aborted.signal)).rejects.toThrow('provider_timeout');
    // A bad image never reaches the client.
    const create = vi.fn();
    await expect(createClaudeValueReadingProvider({ model: 'm', prompt: 'P', client: () => ({ messages: { create } }) as never })
      .read({ ...REQUEST, renderDigestSha256: 'f'.repeat(64) }, new AbortController().signal)).rejects.toThrow('render_digest_mismatch');
    expect(create).not.toHaveBeenCalled();
  });

  it('is configured only with a key, and runs on the Forgewing model when one is set', () => {
    expect(isValueReadingProviderConfigured({})).toBe(false);
    expect(isValueReadingProviderConfigured({ ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(isValueReadingProviderConfigured({ ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(valueReadingProviderModel({ FORGEWING_MODEL: ' forgewing-model ' })).toBe('forgewing-model');
  });
});

// Server-only Claude "Ask This Project" adapter. Read-only explanations only.

import {
  getClaudeClient,
  getClaudeModel,
} from '@/lib/server/ai/claudeClient';
import { CLAUDE_REQUEST_OPTIONS } from '@/lib/server/ai/claudeRequestOptions';
import { getClaudeSamplingParameters } from '@/lib/server/ai/claudeSampling';
import type { AskProjectClaudeContext } from '@/lib/server/ai/askProjectContext';

export const ASK_PROJECT_CLAUDE_SYSTEM_PROMPT = [
  'You are Claude assisting EightForge operators with read-only project explanations.',
  'Answer only from the provided EightForge project context.',
  'Do not invent facts. If the context is insufficient, say exactly what is missing.',
  'Do not mutate, approve, override, resolve, create, delete, or update anything.',
  'Do not claim a decision, finding, execution item, audit event, document, schema, or fact has changed.',
  'Preserve evidence references when available, including document ids, fact ids, anchor ids, pages, validator finding ids, and decision ids.',
  'Treat canonical project truth as the only authority. Surfaces read canonical truth; they never produce it.',
  'retrieval.reviewedTruth.effective holds human-reviewed values: they are applied project truth and outrank any extracted value for the same evidence. Values in retrieval.reviewedTruth.held are not applied; say so if you mention them.',
].join('\n');

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

export async function askProjectWithClaude(params: {
  question: string;
  context: AskProjectClaudeContext;
}): Promise<{ answer: string; model: string; observation: AskProviderObservation }> {
  const client = getClaudeClient();
  const model = getClaudeModel();
  const startedAt = performance.now();

  const message = await client.messages.create({
    model,
    ...getClaudeSamplingParameters(model),
    max_tokens: 1200,
    system: ASK_PROJECT_CLAUDE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          'EightForge project context JSON:',
          JSON.stringify(params.context),
          '',
          `Question: ${params.question}`,
        ].join('\n'),
      },
    ],
  }, { ...CLAUDE_REQUEST_OPTIONS.budgeted });

  return {
    answer: extractTextContent(message.content),
    model,
    // Metadata only, for the durable telemetry ledger (S7); never returned to the browser.
    observation: {
      returnedModel: typeof message.model === 'string' ? message.model : null,
      providerRequestId: typeof (message as { _request_id?: unknown })._request_id === 'string'
        ? (message as { _request_id: string })._request_id : null,
      stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      inputTokens: typeof message.usage?.input_tokens === 'number' ? message.usage.input_tokens : null,
      outputTokens: typeof message.usage?.output_tokens === 'number' ? message.usage.output_tokens : null,
      latencyMs: performance.now() - startedAt,
    },
  };
}

export type AskProviderObservation = Readonly<{
  returnedModel: string | null;
  providerRequestId: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}>;

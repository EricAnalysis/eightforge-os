// Server-only Claude "Ask This Project" adapter. Read-only explanations only.

import { getClaudeClient, getClaudeModel } from '@/lib/server/ai/claudeClient';
import type { AskProjectClaudeContext } from '@/lib/server/ai/askProjectContext';

export const ASK_PROJECT_CLAUDE_SYSTEM_PROMPT = [
  'You are Claude assisting EightForge operators with read-only project explanations.',
  'Answer only from the provided EightForge project context.',
  'Do not invent facts. If the context is insufficient, say exactly what is missing.',
  'Do not mutate, approve, override, resolve, create, delete, or update anything.',
  'Do not claim a decision, finding, execution item, audit event, document, schema, or fact has changed.',
  'Preserve evidence references when available, including document ids, fact ids, anchor ids, pages, validator finding ids, and decision ids.',
  'Treat canonical project truth as the only authority. Surfaces read canonical truth; they never produce it.',
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
}): Promise<{ answer: string; model: string }> {
  const client = getClaudeClient();
  const model = getClaudeModel();

  const message = await client.messages.create({
    model,
    temperature: 0,
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
  });

  return {
    answer: extractTextContent(message.content),
    model,
  };
}

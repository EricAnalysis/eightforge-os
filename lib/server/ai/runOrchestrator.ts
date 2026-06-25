// Server-only Improvement Orchestrator adapter. Generates text instructions only.

import { ORCHESTRATOR_SYSTEM_PROMPT } from '@/lib/server/ai/orchestratorSystemPrompt';
import { getClaudeClient, getClaudeModel } from '@/lib/server/ai/claudeClient';
import {
  getOrchestratorRootCauseCategory,
  type OrchestratorRootCauseCategoryKey,
} from '@/lib/shared/orchestratorTaxonomy';

export type OrchestratorStructuredFields = {
  rootCauseCategory?: OrchestratorRootCauseCategoryKey;
  affectedFiles?: string;
  evidenceLinks?: string;
};

export type RunOrchestratorInput = {
  diagnostic: string;
  structuredFields?: OrchestratorStructuredFields;
};

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

export function buildOrchestratorUserContent(input: RunOrchestratorInput): string {
  const fields = input.structuredFields ?? {};
  const rootCauseCategory = getOrchestratorRootCauseCategory(fields.rootCauseCategory);
  const structured = [
    [
      'Root cause category',
      rootCauseCategory ? `${rootCauseCategory.label} (${rootCauseCategory.key})` : undefined,
    ],
    ['Affected files/paths', fields.affectedFiles],
    ['Evidence links/snippets', fields.evidenceLinks],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([label, value]) => `${label}: ${value!.trim()}`)
    .join('\n');

  return [
    'Structured diagnostic fields:',
    structured || 'None provided.',
    '',
    'Freeform diagnostic:',
    input.diagnostic.trim(),
  ].join('\n');
}

export async function runOrchestrator(
  input: RunOrchestratorInput,
): Promise<{ generatedPrompt: string; model: string }> {
  const diagnostic = input.diagnostic.trim();
  if (!diagnostic) {
    throw new Error('diagnostic is required');
  }

  const client = getClaudeClient();
  const model = getClaudeModel();

  const message = await client.messages.create({
    model,
    temperature: 0,
    max_tokens: 4000,
    system: ORCHESTRATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildOrchestratorUserContent({
          diagnostic,
          structuredFields: input.structuredFields,
        }),
      },
    ],
  });

  return {
    generatedPrompt: extractTextContent(message.content),
    model,
  };
}

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  getOrchestratorRootCauseCategory,
  type OrchestratorRootCauseCategoryKey,
} from '@/lib/shared/orchestratorTaxonomy';

export type OrchestratorPromptFileInput = {
  question?: string;
  diagnostic?: string;
  answer?: string;
  generatedPrompt?: string;
  model: string;
  rootCauseCategory?: OrchestratorRootCauseCategoryKey;
  structuredFields?: Record<string, string | undefined>;
  now?: Date;
  docsRoot?: string;
  fileExists?: (absolutePath: string) => Promise<boolean>;
};

export type OrchestratorPromptFileResult = {
  absolutePath: string;
  relativePath: string;
  filename: string;
};

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function slugFromDiagnostic(diagnostic: string): string {
  const slug = diagnostic
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug || 'diagnostic';
}

export function slugFromQuestion(question: string): string {
  const slug = slugFromDiagnostic(question);
  return slug === 'diagnostic' ? 'question' : slug;
}

function slugFromRootCauseCategory(key: OrchestratorRootCauseCategoryKey): string {
  return key.replace(/_/g, '-');
}

export function buildPromptFileMarkdown(input: {
  question?: string;
  diagnostic?: string;
  answer?: string;
  generatedPrompt?: string;
  model: string;
  rootCauseCategory?: OrchestratorRootCauseCategoryKey;
  structuredFields?: Record<string, string | undefined>;
  generatedAt: Date;
}): string {
  const question = readPromptFileQuestion(input);
  const answer = readPromptFileAnswer(input);
  const rootCauseCategory = getOrchestratorRootCauseCategory(input.rootCauseCategory);
  const structured = Object.entries(input.structuredFields ?? {})
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `- ${key}: ${value!.trim()}`)
    .join('\n');

  return [
    '---',
    `generated_at: ${formatTimestamp(input.generatedAt)}`,
    `model: ${input.model}`,
    `root_cause_category: ${rootCauseCategory ? `${rootCauseCategory.key} (${rootCauseCategory.label})` : 'none'}`,
    'tool: improvement-orchestrator-ai',
    '---',
    '',
    '# EightForge Engineering Orchestrator Answer',
    '',
    '## Raw Input',
    '',
    question,
    '',
    '## Structured Context',
    '',
    structured || '_None provided._',
    '',
    '## Generated Answer',
    '',
    answer,
    '',
  ].join('\n');
}

function readPromptFileQuestion(input: { question?: string; diagnostic?: string }): string {
  return input.question?.trim() || input.diagnostic?.trim() || '';
}

function readPromptFileAnswer(input: { answer?: string; generatedPrompt?: string }): string {
  return input.answer?.trim() || input.generatedPrompt?.trim() || '';
}

async function defaultFileExists(absolutePath: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeOrchestratorPromptFile(
  input: OrchestratorPromptFileInput,
): Promise<OrchestratorPromptFileResult> {
  const now = input.now ?? new Date();
  const docsRoot = input.docsRoot ?? process.cwd();
  const promptsDir = path.join(docsRoot, 'docs', 'prompts');
  const datePrefix = formatLocalDate(now);
  const question = readPromptFileQuestion(input);
  const answer = readPromptFileAnswer(input);
  const slug = input.rootCauseCategory
    ? slugFromRootCauseCategory(input.rootCauseCategory)
    : slugFromQuestion(question);
  const exists = input.fileExists ?? defaultFileExists;

  await mkdir(promptsDir, { recursive: true });

  let suffix = 0;
  let filename = `${datePrefix}-${slug}.md`;
  let absolutePath = path.join(promptsDir, filename);

  while (await exists(absolutePath)) {
    suffix += 1;
    filename = `${datePrefix}-${slug}-${suffix}.md`;
    absolutePath = path.join(promptsDir, filename);
  }

  const markdown = buildPromptFileMarkdown({
    question,
    answer,
    model: input.model,
    rootCauseCategory: input.rootCauseCategory,
    structuredFields: input.structuredFields,
    generatedAt: now,
  });

  await writeFile(absolutePath, markdown, { encoding: 'utf8', flag: 'wx' });

  return {
    absolutePath,
    relativePath: path.relative(docsRoot, absolutePath).replace(/\\/g, '/'),
    filename,
  };
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  buildPromptFileMarkdown,
  slugFromDiagnostic,
  writeOrchestratorPromptFile,
} from '@/lib/server/ai/orchestratorPromptFiles';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('orchestrator prompt files', () => {
  it('builds a sanitized short slug from the diagnostic', () => {
    assert.equal(
      slugFromDiagnostic('  UI totals drift when CYD rows are rendered!!! '),
      'ui-totals-drift-when-cyd-rows-are-rendered',
    );
  });

  it('writes a dated prompt file and appends a suffix instead of overwriting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-prompts-'));
    tempDirs.push(root);
    const promptsDir = path.join(root, 'docs', 'prompts');
    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      path.join(promptsDir, '2026-06-25-ui-consumption-issue.md'),
      'existing',
      'utf8',
    );

    const result = await writeOrchestratorPromptFile({
      docsRoot: root,
      now: new Date(2026, 5, 25, 9, 30, 0),
      diagnostic: 'UI totals drift',
      generatedPrompt: 'Phase A - Audit',
      model: 'claude-sonnet-4-6',
      rootCauseCategory: 'ui_consumption_issue',
      structuredFields: { rootCauseCategory: 'ui_consumption_issue' },
    });

    assert.equal(result.filename, '2026-06-25-ui-consumption-issue-1.md');
    assert.equal(result.relativePath, 'docs/prompts/2026-06-25-ui-consumption-issue-1.md');
    const contents = await readFile(result.absolutePath, 'utf8');
    assert.match(contents, /generated_at:/);
    assert.match(contents, /model: claude-sonnet-4-6/);
    assert.match(contents, /root_cause_category: ui_consumption_issue \(UI Consumption Issue\)/);
    assert.match(contents, /UI totals drift/);
    assert.match(contents, /rootCauseCategory: ui_consumption_issue/);
    assert.match(contents, /Phase A - Audit/);
  });

  it('formats traceability headers without unrelated environment data', () => {
    const markdown = buildPromptFileMarkdown({
      diagnostic: 'Diagnostic',
      generatedPrompt: 'Prompt',
      model: 'claude-sonnet-4-6',
      generatedAt: new Date('2026-06-25T12:00:00.000Z'),
    });

    assert.match(markdown, /generated_at: 2026-06-25T12:00:00.000Z/);
    assert.equal(markdown.includes('ANTHROPIC_API_KEY'), false);
  });
});

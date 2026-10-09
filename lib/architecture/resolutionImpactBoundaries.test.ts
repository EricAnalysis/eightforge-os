import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const code = (relative: string) => read(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ENGINE = 'lib/server/resolutionImpactPreview.ts';
const ROUTE = 'app/api/projects/[id]/resolution-cases/impact/route.ts';
const IMPACT = 'lib/resolution/resolutionImpact.ts';
const SECTION = 'components/resolution/ResolutionImpactSection.tsx';
const WORKSPACE = 'components/resolution/ResolutionWorkspace.tsx';

describe('resolution impact boundaries (B5-C)', () => {
  it('reaches no write path: no record, link, closure, review, persistence or revalidation call', () => {
    for (const relative of [ENGINE, ROUTE, IMPACT, 'lib/resolution/resolutionPreviewInput.ts']) {
      const text = code(relative);
      for (const forbidden of [
        'recordRegionBoundAssertion', 'insertManualRateLink', 'closeManualRateLinkFindings', 'persistValidationRun',
        'runValidationFlow', 'requestFactOverrideRevalidation', 'requestManualRateLinkRevalidation',
        'recordRecoveryReview', 'executeProjectExecutionResolution', '.insert(', '.update(', '.upsert(', '.delete(', '.rpc(',
        'loadValidatorSourceSnapshot', 'runProjectValidation',
      ]) expect(`${relative}:${forbidden}:${text.includes(forbidden)}`).toBe(`${relative}:${forbidden}:false`);
    }
    // One read pass, then the pure derivation and execution, in memory.
    const engine = code(ENGINE);
    expect(engine).toContain('loadValidatorSourceReads');
    expect(engine).toContain('deriveValidatorSourceSnapshot');
    expect(engine).toContain('executeProjectValidation');
  });

  it('calls no AI provider and reads no Forgewing value', () => {
    for (const relative of [ENGINE, ROUTE, IMPACT, SECTION]) {
      const text = read(relative);
      for (const term of ['@/lib/server/ai', '@/lib/forgewing', '@anthropic-ai/sdk', 'callClaudeFor', 'suggestions', 'proposedValue']) {
        expect(`${relative}:${term}:${text.includes(term)}`).toBe(`${relative}:${term}:false`);
      }
    }
  });

  it('the route only previews: POST with a case id and a whitelisted decision', () => {
    const route = code(ROUTE);
    expect(route).toContain('export async function POST');
    expect(route).not.toMatch(/export async function (GET|PUT|PATCH|DELETE)/);
    expect(route).toContain('parseResolutionPreviewInput(body?.input)');
  });

  it('the client displays impact and never computes it', () => {
    for (const relative of [SECTION, WORKSPACE]) {
      const text = read(relative);
      expect(text).not.toMatch(/import \{[^}]*\} from '@\/lib\/resolution\/resolutionImpact'/);
      expect(text).not.toContain('buildResolutionImpact');
      expect(text).not.toContain('executeProjectValidation');
    }
    const section = code(SECTION);
    const fetches = [...section.matchAll(/fetch\((.*?),(?:\s*$| \{)/gm)].map((match) => match[1]!.trim());
    expect(fetches).toEqual(['`/api/projects/${encodeURIComponent(entry.projectId)}/resolution-cases/impact`']);
    // What it sends is a case id and the decision: no impact field.
    expect(section).toContain('body: JSON.stringify({ caseId: entry.caseId, input })');
    // Unavailable impact says so instead of showing zeros.
    expect(section).toContain('Impact cannot yet be computed for this action.');
  });
});

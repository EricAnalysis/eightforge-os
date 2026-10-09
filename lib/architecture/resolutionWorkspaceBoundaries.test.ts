import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const code = (relative: string) => read(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WORKSPACE = 'components/resolution/ResolutionWorkspace.tsx';
const REQUEST = 'lib/resolution/resolutionActionRequest.ts';
const PAGE = 'app/platform/projects/[id]/resolve/page.tsx';

describe('resolution workspace boundaries (B5-B)', () => {
  it('reads the server read model as types only; it derives no case of its own', () => {
    const workspace = read(WORKSPACE);
    expect(workspace).toMatch(/import type \{[^}]*ResolutionCase[^}]*\} from '@\/lib\/resolution\/resolutionCases'/);
    expect(workspace).not.toMatch(/import \{[^}]*\} from '@\/lib\/resolution\/resolutionCases'/);
    for (const forbidden of ['buildResolutionQueue', 'resolveProjectIssueObjects', 'regionAssertionEntryTargets',
      'resolveRegionBoundAssertions', 'executeProjectValidation', 'buildValidatorInputFromSourceSnapshot']) {
      expect(`${forbidden}:${workspace.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('writes only through the request the server-listed action builds; no generic approve', () => {
    const workspace = code(WORKSPACE);
    const fetches = [...workspace.matchAll(/fetch\((.*?),(?:\s*$| \{)/gm)].map((match) => match[1]!.trim());
    expect(fetches.sort()).toEqual([
      '`/api/documents/${encodeURIComponent(documentId)}/file`',
      '`/api/projects/${encodeURIComponent(projectId)}/resolution-cases`',
      'built.request.url',
    ].sort());
    for (const relative of [WORKSPACE, REQUEST, PAGE]) {
      expect(`${relative}:${/\/approve\b/.test(code(relative))}`).toBe(`${relative}:false`);
    }
    // Every write field that binds evidence comes from the listed action.
    const request = code(REQUEST);
    for (const field of ['anchorKey', 'pageRepresentationDigest', 'sourceObservationIds', 'sourceRegion', 'supersedesAssertionId']) {
      expect(request).toContain(`${field}: action.`);
    }
    expect(request).toContain('proposalId: action.proposalId');
  });

  it('reuses the shared evidence viewer and the existing manual link panel', () => {
    const workspace = read(WORKSPACE);
    expect(workspace).toContain("from '@/components/recovery/SourceEvidencePage'");
    expect(workspace).toContain("from '@/components/validator/ManualRateLinkResolutionPanel'");
  });

  it('keeps Forgewing out of Core: no runtime import, and the slot only for server-included suggestions', () => {
    const workspace = read(WORKSPACE);
    for (const term of ['@/lib/forgewing', '@/lib/server/ai', '@anthropic-ai/sdk', 'recoveryOperationalPolicy']) {
      expect(`${term}:${workspace.includes(term)}`).toBe(`${term}:false`);
    }
    expect(workspace).toContain('const showSuggestions = forgewingSuggestionsIncluded && entry.suggestions.length > 0;');
    expect(workspace).toContain('const showReading = forgewingSuggestionsIncluded');
    expect(workspace).toContain("offeredAction(entry, 'request_value_reading')");
    expect(workspace).toContain("offeredAction(entry, 'review_value_reading')");
    expect(workspace).toContain('Forgewing visual reading · Unverified');
    expect(workspace).not.toMatch(/valueReadingEngine|createValueReadingProposal|runValueReading/);
  });

  it('keeps reading selection in a human draft and refresh on the same case when still displayed', () => {
    const workspace = code(WORKSPACE);
    expect(workspace).toContain('setForm((current) => ({ ...current, ...draft }))');
    expect(workspace).toContain('setSelectedReadingId(suggestion.proposalId)');
    expect(workspace).toContain("input.kind === 'request_value_reading' || input.kind === 'review_value_reading'");
    // A filter change during the request must not reopen a hidden document.
    expect(workspace).toContain('if (refreshed && filterResolutionQueue(refreshed, documentFilterRef.current).cases.some((candidate) => candidate.caseId === entry.caseId)) setSelectedId(entry.caseId)');
    // Failed refresh preserves the current selection, including a changed filter.
    expect(workspace).toMatch(/} else if \(refreshed\) \{\s*setSelectedId\(entry.caseId\);/);
    expect(workspace).toContain('setDecisionRevision((revision) => revision + 1)');
    expect(workspace).toContain('resolutionDecisionIdentity(selected, queue.forgewingSuggestionsIncluded)');
  });

  it('adds no keyboard shortcuts yet', () => {
    expect(/keydown|onKeyDown|useHotkeys/i.test(code(WORKSPACE))).toBe(false);
  });

  it('is reachable from the document and Validator surfaces by record, not by composed case id', () => {
    expect(read('components/documents/ReviewedValuesPanel.tsx')).toContain('resolutionWorkspaceHref(projectId, { documentId, anchorKey: target.anchorKey })');
    expect(read('components/projects/ValidatorTab.tsx')).toContain('resolutionWorkspaceHref(projectId, { findingId: selectedIssue?.findingId ?? null })');
  });
});

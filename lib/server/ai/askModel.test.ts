import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PROJECT_ASK_QUALIFIED_MODELS, resolveProjectAskModel } from './askModel';

describe('Project Ask model qualification (D3)', () => {
  it('qualifies only the Ask contract model and never falls back', () => {
    expect([...PROJECT_ASK_QUALIFIED_MODELS]).toEqual(['claude-sonnet-4-6']);
    expect(resolveProjectAskModel({})).toEqual({ model: 'claude-sonnet-4-6', source: 'default', qualified: true });
    expect(resolveProjectAskModel({ ANTHROPIC_MODEL: 'claude-sonnet-5-5' }))
      .toEqual({ model: 'claude-sonnet-5-5', source: 'ANTHROPIC_MODEL', qualified: false });
    expect(resolveProjectAskModel({ ANTHROPIC_MODEL: 'claude-sonnet-5-5', FORGEWING_PROJECT_ASK_MODEL: 'claude-sonnet-4-6' }))
      .toEqual({ model: 'claude-sonnet-4-6', source: 'FORGEWING_PROJECT_ASK_MODEL', qualified: true });
  });

  it('is independent of the Forgewing model allowlist and FORGEWING_MODEL', () => {
    expect(resolveProjectAskModel({ FORGEWING_MODEL: 'claude-sonnet-4-6', ANTHROPIC_MODEL: 'claude-unqualified-9' }).qualified)
      .toBe(false);
  });

  it('the Ask route and client take the model only from the Ask resolver', () => {
    const route = readFileSync('app/api/projects/[id]/ask/route.ts', 'utf8');
    const client = readFileSync('lib/server/ai/askProject.ts', 'utf8');
    expect(route).not.toMatch(/getClaudeModel|FORGEWING_QUALIFIED_MODELS|resolveForgewingModel/);
    expect(client).not.toMatch(/getClaudeModel/);
    expect(route).toContain('const askModel = resolveProjectAskModel();');
    expect(route.indexOf('if (!askModel.qualified)')).toBeLessThan(route.indexOf('buildAskProjectContext({'));
    expect(route.indexOf('if (!askModel.qualified)')).toBeLessThan(route.indexOf('reserveForgewingProviderCall(admin'));
  });
});

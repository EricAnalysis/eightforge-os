import { describe, expect, it } from 'vitest';
import { buildSafeAskContract, detectAskScope } from './globalCommand';

describe('detectAskScope', () => {
  it('uses route defaults before query overrides', () => {
    expect(detectAskScope('/platform/portfolio')).toBe('portfolio');
    expect(detectAskScope('/platform/reviews')).toBe('intelligence');
    expect(detectAskScope('/platform/projects/project-1')).toBe('project');
    expect(detectAskScope('/platform/documents')).toBe('search');
  });

  it('overrides project scope for portfolio, intelligence, and search intent', () => {
    const projectPath = '/platform/projects/project-1';

    expect(detectAskScope(projectPath, 'What is total exposure across all projects?')).toBe('portfolio');
    expect(detectAskScope(projectPath, 'Which rule failures keep recurring?')).toBe('intelligence');
    expect(detectAskScope(projectPath, 'Open invoice INV-100 document')).toBe('search');
  });

  it('allows scoped entry cards to force scope instead of re-detecting route or query intent', () => {
    expect(
      buildSafeAskContract({
        pathname: '/platform/reviews',
        question: 'Open invoice INV-100 document',
        forcedScope: 'intelligence',
      }).scope,
    ).toBe('intelligence');

    expect(
      buildSafeAskContract({
        pathname: '/platform/documents',
        question: 'Which projects need review?',
        forcedScope: 'portfolio',
      }).scope,
    ).toBe('portfolio');
  });
});

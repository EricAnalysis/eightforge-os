export type ProjectTabKey =
  | 'overview'
  | 'documents'
  | 'validator'
  | 'audit';

export const PROJECT_FORGE_TABS: Array<{ key: ProjectTabKey; label: string; href: string }> = [
  { key: 'overview', label: 'Overview', href: '#project-overview' },
  { key: 'documents', label: 'Documents', href: '#project-documents' },
  { key: 'validator', label: 'Validator', href: '#project-validator' },
  { key: 'audit', label: 'Audit', href: '#project-audit' },
];

const LEGACY_ACTIONS_HASH = '#project-actions';
// Facts was folded into the Documents surface; the anchor id is preserved there
// so existing deep links (Ask responses, decision context CTAs) keep resolving.
const LEGACY_FACTS_HASH = '#project-facts';
// Decisions was folded into the Validator surface (3-panel Findings / Evidence &
// Truth / Decision & Execution layout); the anchor id is preserved there so
// existing deep links (execution item links, decision context CTAs, Ask
// responses) keep resolving.
const LEGACY_DECISIONS_HASH = '#project-decisions';

export function projectTabFromHash(hash: string): ProjectTabKey {
  if (hash === LEGACY_ACTIONS_HASH) return 'validator';
  if (hash === LEGACY_FACTS_HASH) return 'documents';
  if (hash === LEGACY_DECISIONS_HASH) return 'validator';
  const matched = PROJECT_FORGE_TABS.find((tab) => tab.href === hash);
  return matched?.key ?? 'overview';
}

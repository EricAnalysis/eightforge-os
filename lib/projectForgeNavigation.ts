export type ProjectTabKey =
  | 'overview'
  | 'documents'
  | 'facts'
  | 'validator'
  | 'decisions'
  | 'audit';

export const PROJECT_FORGE_TABS: Array<{ key: ProjectTabKey; label: string; href: string }> = [
  { key: 'overview', label: 'Overview', href: '#project-overview' },
  { key: 'documents', label: 'Documents', href: '#project-documents' },
  { key: 'facts', label: 'Facts', href: '#project-facts' },
  { key: 'validator', label: 'Validator', href: '#project-validator' },
  { key: 'decisions', label: 'Decisions', href: '#project-decisions' },
  { key: 'audit', label: 'Audit', href: '#project-audit' },
];

const LEGACY_ACTIONS_HASH = '#project-actions';

export function projectTabFromHash(hash: string): ProjectTabKey {
  if (hash === LEGACY_ACTIONS_HASH) return 'decisions';
  const matched = PROJECT_FORGE_TABS.find((tab) => tab.href === hash);
  return matched?.key ?? 'overview';
}

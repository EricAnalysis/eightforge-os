# Pre-Simplification Snapshot Recovery

**Date:** 2026-06-21
**Git tag:** pre-surface-simplification-snapshot
**Commit hash:** 5e536a1a9b3f1e223e2911d5981fe56b192ce130 (confirmed via git show pre-surface-simplification-snapshot --stat)
**Source commit:** 5e536a1

This snapshot directory was recreated in this pass (chore/restore-pre-simplification-snapshot) because the original copy step from the June 2026 session was never actually committed to the repo (the tag resolved but docs/design/snapshots/pre-simplification/ did not exist on main).

## Recovered Surfaces (exact filenames, from commit 5e536a1)

- ProjectOverview.tsx (Overview surface)
- ProjectDocumentsForge.tsx (Documents surface)
- ProjectFactsForge.tsx (Facts surface)
- Validator surface — **not found at snapshot commit** under `ProjectValidatorForge` or `ValidatorForge`; no substitute was copied
- ProjectDecisionQueueFrame.tsx (Decisions surface)
- ProjectAuditForge.tsx (Audit surface)

## Recovered Routing/Navigation (prefixed)

- routing__projectForgeNavigation.ts
- routing__ProjectOverview.tsx

## Search Results at Commit
The Overview, Documents, Facts, Decisions, and Audit surfaces were located through the provided search terms. Neither approved Validator search term existed at the snapshot commit, so no Validator component was copied.

This is an additive-only safety artifact. Zero runtime impact.

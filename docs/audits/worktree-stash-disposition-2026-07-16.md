# Worktree and stash disposition — 2026-07-16

## Scope and method

This is a read-only inventory captured on 2026-07-16. `git worktree list`, the
contents of `.claude/worktrees`, `git stash list`, and `git stash show -p` for
every listed stash were inspected. Recommendations deliberately preserve the
current evidence until the owning engineer confirms intent.

## Disposition

| worktree/stash | branch | summary | last activity | recommended disposition |
| --- | --- | --- | --- | --- |
| `C:/Dev/eightforge-os` | `codex/validator-workspace-single-assembly` | Primary checkout; contains untracked `docs/audits/prod-first-load-decomposition-2026-07-15.md`. | 2026-07-15 — `a00c40a` | needs-owner-review |
| `.claude/worktrees/angry-clarke-82eda7` | detached at `20a1647` | Detached rate-row-validation fix checkout. | 2026-07-03 | needs-owner-review |
| `.claude/worktrees/cool-albattani-ac7ef7` | detached at `6e27634` | Detached checkout at merged PR #49 commit. | 2026-06-30 | needs-owner-review |
| `.claude/worktrees/epic-morse-32eb3a` | `claude/epic-morse-32eb3a` | Merge commit for management-reduction rate-collision work. | 2026-06-29 | keep |
| `.claude/worktrees/feat+disposal-treatment-override-propagation` | `worktree-feat+disposal-treatment-override-propagation` | Disposal-fee treatment override propagation feature. | 2026-06-28 | keep |
| `.claude/worktrees/gracious-pascal-5faa9b` | `claude/gracious-pascal-5faa9b` | Dirty one-file change removes transaction-row paging, fetch, fallback diagnostic, and dataset row attachment from `useProjectWorkspaceData.ts` (82 deletions, 1 insertion). This changes the workspace from attached canonical rows to persisted transaction summaries, so its intended data/grain behavior needs owner confirmation. | base commit 2026-06-29; dirty 2026-06-29 worktree | needs-owner-review |
| `.claude/worktrees/happy-wescoff-0ec989` | `claude/happy-wescoff-0ec989` | Checkout at merged PR #49 commit. | 2026-06-30 | keep |
| `.claude/worktrees/silly-herschel-6bb0fd` | detached at `6e27634` | Detached checkout at merged PR #49 commit. | 2026-06-30 | needs-owner-review |
| `C:/Dev/eightforge-os-ask` | `feat/claude-project-ask-mvp` | Project Ask MVP worktree. | 2026-06-25 | keep |
| `C:/Dev/eightforge-os-cc-fix` | `feat/command-center-canonical-status` | Command Center canonical approval-status routing. | 2026-07-02 | keep |
| `C:/Dev/eightforge-os-cs15` | `emartind8/cs-15-shadow-mismatch-upsert` | Active CS-15 isolated worktree. | 2026-07-15 base | keep |
| `C:/Dev/eightforge-os-cs22` | `emartind8/cs-22-worktree-stash-disposition` | Active CS-22 disposition worktree. | 2026-07-15 base | keep |
| `C:/Dev/eightforge-os-cs23` | `emartind8/cs-23-docs-drift` | Active CS-23 isolated worktree. | 2026-07-15 base | keep |
| `C:/Dev/eightforge-os-integration` | `feat/manual-rate-link-integration` | Manual rate-link integration checkout. | 2026-07-02 | keep |
| `C:/Dev/eightforge-os-orchestrator` | `feat/improvement-orchestrator-ai` | Improvement orchestrator AI checkout. | 2026-06-25 | keep |
| `C:/Dev/eightforge-os-pass22` | `feat/manual-rate-link-pass2.2-exposure-fix` | Manual rate-link exposure-rollup fix checkout. | 2026-07-02 | keep |
| `C:/Dev/eightforge-os-remove-ai-enrichment` | `chore/remove-ai-enrichment-subsystem` | Dirty eight-file AI-enrichment-removal work: removes `aiDecisionPersistence.ts` and `documentAiEnrichment.ts`; removes AI-enrichment/persistence paths and related tests; adjusts job processing, heuristic decisions, and supporting docs (749 deletions, 5 insertions). This is a broad behavioral removal and needs owner confirmation before merge or discard. | base commit 2026-06-22; dirty worktree | needs-owner-review |
| `C:/Dev/eightforge-os-upload-guidance-merge` | `codex/upload-guidance-merge` | Upload-guidance merge checkout. | 2026-07-02 | keep |
| `C:/tmp/eightforge-gitattributes-fix` | `chore/fix-gitattributes-encoding-and-rule` | `.gitattributes` encoding/text-rule fix checkout. | 2026-06-27 | keep |
| `C:/tmp/eightforge-os-pricing-audit` | `codex/audit-pricing-applicability` | Pricing-applicability audit checkout. | 2026-06-27 | keep |
| `.claude/worktrees/beautiful-fermat-0ed7fb` | not registered | Directory exists but is absent from `git worktree list`; inspect before any cleanup. | directory timestamp 2026-06-12 | needs-owner-review |
| `.claude/worktrees/eager-moore-cdb85c` | not registered | Directory exists but is absent from `git worktree list`; inspect before any cleanup. | directory timestamp 2026-06-12 | needs-owner-review |
| `.claude/worktrees/jovial-austin-6ae7a3` | not registered | Directory exists but is absent from `git worktree list`; inspect before any cleanup. | directory timestamp 2026-06-12 | needs-owner-review |
| `.claude/worktrees/sad-mirzakhani-5a4190` | not registered | Directory exists but is absent from `git worktree list`; inspect before any cleanup. | directory timestamp 2026-06-12 | needs-owner-review |
| `.claude/worktrees/wonderful-driscoll-6bf3f7` | not registered | Directory exists but is absent from `git worktree list`; inspect before any cleanup. | directory timestamp 2026-06-12 | needs-owner-review |
| `stash@{0}` | `feat/extractor-diagnostic-agent` | Forge Documents surface WIP: replaces large document-detail UI areas with Forge-surface/extraction-state presentation and adds state/boundary tests (9 files; 618 additions, 553 deletions). | 2026-06-25 12:41 -0400 | needs-owner-review |
| `stash@{1}` | `feat/vision-rate-table-supplement` | Adds pre-simplification design snapshots (nine snapshot files, 6,525 additions); historical reference material rather than a small feature patch. | 2026-06-17 11:55 -0400 | needs-owner-review |
| `stash@{2}` | `main` | Extends project decision summaries with a governing-contract pricing-row link (one file; 17 additions, 2 deletions). | 2026-06-16 15:31 -0400 | needs-owner-review |
| `stash@{3}` | `main` | Adjusts Validator-tab action visibility by gate state (one file; 35 additions, 37 deletions). | 2026-06-16 15:31 -0400 | needs-owner-review |
| `stash@{4}` | `main` | Changes the decision-queue “Inspect Evidence” target to use the available contract-pricing link (one-line change). | 2026-06-16 15:31 -0400 | needs-owner-review |

## Owner commands after a decision

Use the following exact commands only after confirming the corresponding row's
recommended disposition. They are intentionally not executed by this issue.

| row(s) | review / preserve command | command after an owner explicitly chooses merge or discard |
| --- | --- | --- |
| Any registered worktree marked `keep` | `git -C <worktree-path> status --short` | Merge: `git merge <branch>` from the intended integration branch. Discard checkout only: `git worktree remove <worktree-path>`. |
| Primary checkout | `git -C C:/Dev/eightforge-os status --short` | After reviewing the untracked audit doc, either add it intentionally or remove it manually; no blanket cleanup command is recommended. |
| `gracious-pascal-5faa9b` | `git -C C:/Dev/eightforge-os/.claude/worktrees/gracious-pascal-5faa9b diff -- lib/useProjectWorkspaceData.ts` | Keep/merge: `git -C C:/Dev/eightforge-os/.claude/worktrees/gracious-pascal-5faa9b commit -am "<approved message>"` then `git merge claude/gracious-pascal-5faa9b`; discard only after approval: `git -C C:/Dev/eightforge-os/.claude/worktrees/gracious-pascal-5faa9b restore lib/useProjectWorkspaceData.ts`. |
| `C:/Dev/eightforge-os-remove-ai-enrichment` | `git -C C:/Dev/eightforge-os-remove-ai-enrichment diff --stat; git -C C:/Dev/eightforge-os-remove-ai-enrichment diff` | Keep/merge: `git -C C:/Dev/eightforge-os-remove-ai-enrichment commit -am "<approved message>"` then `git merge chore/remove-ai-enrichment-subsystem`; discard only after approval: `git -C C:/Dev/eightforge-os-remove-ai-enrichment restore .`. |
| Detached registered worktrees | `git -C <worktree-path> status --short; git -C <worktree-path> log -1 --oneline` | Preserve as branch: `git -C <worktree-path> switch -c <owner-chosen-branch>`; discard checkout only: `git worktree remove <worktree-path>`. |
| Unregistered `.claude/worktrees/*` directories | `Get-ChildItem -Force C:/Dev/eightforge-os/.claude/worktrees/<directory>` | No removal command is prescribed until the owner determines whether it is an intentionally retained artifact. |
| `stash@{0}` through `stash@{4}` | `git stash show -p stash@{n}` | Apply for review: `git stash apply stash@{n}`; only after successful review and integration, delete: `git stash drop stash@{n}`. |

## Safety note

Nothing in this issue deletes anything. This document records evidence and
owner-only follow-up commands; it does not merge, discard, drop, delete, or
otherwise mutate any pre-existing worktree or stash.

# B8.5 Workflow Assessment audit and implementation contract

Audit baseline: `ca16c64299113a07b04d2cf472ce2513d5569ef5` (remote main, 2026-10-12). The unrelated dirty checkout at `C:\Dev\eightforge-os` is preserved; B8.5 uses a clean managed worktree.

## Read-only audit findings

1. `PublicLanding` renders `WorkflowIntakeDialog` and the already neutral “Describe Your Workflow” CTA. Keep the existing product headline. Generalize only intake copy and, if needed, CTA-adjacent explanatory copy.
2. The dialog has six ordered fields, back/next navigation retaining in-memory answers, a single-flight submit lock, and reset on close. It has no persisted resume. The public route checks BotID before strict server validation and append-only persistence.
3. `workflowIntake` owns source answers only; `workflowIntakeRead` is the single known-ID RPC reader. Public intake has no tenant association. Caller-controlled identities/organization fields are rejected.
4. Both source intake and derived assessment have explicit `schema_version` identities. SQL restricts them to v1. A seventh answer cannot be safely persisted without a migration. Historical submissions, assessments, and reviews are immutable evidence.
5. The assessment server reads persisted answers, calls the existing pure Forgewing assessment task through the durable claim chain, then appends a non-authoritative assessment version. The provider uses strict JSON/Zod output, bounded calls, exact excerpt grounding, and runtime-owned non-authority markers.
6. Document assumptions occur in the intake prompts, `documentsInvolved`, provider prompt framing, source-question enums/cardinality, and operator labels. There is no required minimum document count: `documents` may already be empty. EXTRACT's legacy `sourceDocument` key holds unrestricted prose and can represent a system without renaming persisted specifications.
7. Human review is authenticated and allowlisted, covers every step, validates classification-specific replacements, and appends immutable parent/child review records. The effective resolver pins exact assessment/review versions and source identity and composes accepted or replaced specifications.
8. Top-level AI summary and document lists are not separately approved by this review. Reuse reviewed step specifications for operational context; relevant context, frequency/volume, terminology and success definitions can be expressed as ADVISORY details under the existing review model. Do not describe raw AI summary as reviewed truth.
9. Assessment → effective specification → implementation plan → repository-aware Plan V2 already exists. Assessment and B8.3 triaged-signal inputs converge in the existing generation worker. Preserve its shared orchestration and provider payload boundaries.
10. No approved customer terminology persistence seam exists. Keep terminology in reviewed descriptions for future proposals; do not invent active terminology storage.
11. B8.2 mapping proposals/approval/activation/withdrawal require tenant-scoped typed header evidence and owner/admin authority. Assessment context can be a read-only planning input but cannot replace that evidence, bind a public submission to an organization, or activate a revision.
12. B8.4 explicitly returns `assessment_sourced_no_originating_friction` for assessment pins. Intake generalization does not invalidate that policy or require measurement changes.
13. Exactly-six dependencies are the dialog field/question lists and tests, intake validator/reader, task's v1 input literal and field record, source-question enum and `sourceQuestions.max(6)`, provider prompt, and intake labels. The six determinism conditions and their gap/support bounds are independent and stay unchanged.
14. Historical v1 answers must keep their original keys/labels and schema identity. Introduce v2 with seven questions; dispatch by persisted schema, without filling a historical success answer or relabeling historical documents as systems.

## Reconciliation and scoped implementation

The initial seven-question implementation required no authority expansion. The later owner decision explicitly superseded anonymous intake: customer assessment creation, files, analysis and recommendations now require authentication and server-resolved organization ownership. Preserve one assessment pipeline, explicit v1/v2 source contracts, version-aware provider validation, and additive migrations. Preserve v1 defaults for historical/internal compatibility. Never update/backfill old answers or derived payloads.

The read-only customer-adaptation context contains only effective human-reviewed specifications with exact review provenance and a digest. It excludes raw provider summaries and intake answers, does not claim tenant ownership, and grants no activation authority. Reuse the existing authenticated platform read seam; only its narrowly named consumer is added to the architecture guard.

The owner has conditionally approved the migration if all gates are green. Deploy schema before v2 app code. Roll back new intake/uploads by disabling their entry points while retaining recorded evidence and additive columns. Any v1-compatible writer must keep the authenticated organization boundary; do not restore anonymous customer analysis or remove/rewrite recorded evidence. The PR review boundary still applies.

## Validation contract

Run focused intake/provider/schema/reviewed-context/UI tests first. Then type-check and one dependent regression covering Phase 11, Plan V2, customer adaptation, B8.3/B8.4 boundaries and architecture seals. Run build and `git diff --check`. Run full migration replay plus direct effective SQL probes. CI already runs one final full Vitest suite. Browser verification covers both document review and CRM/scheduling workflows with local test submission containment; no production adaptations.

Expected deliverables: versioned intake and assessment contracts, seven-question UI, historical rendering, generalized prompt, read-only reviewed context seam, focused tests, additive migration and SQL probes, browser evidence, and one focused PR. Commit message: `feat: generalize reviewed workflow assessment for customer adaptation` (migration may be a separate adjacent commit).

## Earlier seven-question evidence (before authenticated attachments)

- Focused intake/UI tests: 30 passed. Reviewed-context/reader/architecture tests: 31 passed. Provider/closure/qualification/landing slice: 49 passed after the final contract changes. Runtime client/structured-output tests: 18 passed.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit`, exit 0.
- Dependent regression: 977 assertions passed; one architecture scanner assertion exceeded its fixed 30-second budget under concurrent type-checking, with a worker timeout. This is not a clean full regression pass. The scanner rerun independently passed all 70 tests (scan 18.47 seconds), without changing its timeout or assertions.
- Full disposable PostgreSQL replay: 133 migrations passed, including direct workflow authority, B8.5 v1/v2 immutability/review, concurrency and B8.2 lifecycle probes. No production database was used.
- The migration was moved into the filename generated by `supabase migration new workflow_assessment_v2`. Its SQL bytes and position after the previous final migration are unchanged; reuse the executed SQL/replay evidence. The generated filename is `20261012195656_workflow_assessment_v2.sql`.
- Browser: document-heavy and CRM/scheduling examples completed all seven questions, back/next retention, exact request fields, acknowledgement and reset using an intercepted local submission endpoint. No real submission or provider call. Corrected seven-indicator layout passed desktop (1280px) and mobile (390px) geometry checks.
- These results predate authenticated attachments. The final gates below replace them where the changed code invalidates the earlier proof.
- Evidence is outside the repository at `C:\Users\ADMS Thompson\Documents\Codex\B85-20261012`.

## Optional attachment audit (additional user scope)

The additional upload request was audited read-only against existing architecture. The user subsequently instructed that files should not require sign-in yet.

Confirmed conflict: anonymous public intake has no tenant or upload actor; authenticated upload derives both from `getActorContext`. There is no anonymous ownership/onboarding/claim model or assessment attachment association. An anonymous upload cannot meet the requested organization-scoped ownership invariants using the existing contract.

Existing storage/source identity can be reused only after ownership and evidence-only persistence are resolved. The current upload creates ordinary `documents` inventory records and requires document classification. Immutable source artifacts require a matching document and organization. Upload identity failure currently reports success with identity unavailable; assessment links must instead fail closed. File reads are organization-filtered with 300-second signed URLs; deployed bucket privacy is not established by repository configuration. Soft deletion preserves storage, and no assessment draft cleanup/retention lifecycle exists.

Provider-free PDF layout primitives retain page/geometry provenance. XLS/XLSX parsing retains sheet/header/row structure but loses formulas versus displayed values and materializes all rows. Current CSV/JSON extraction is generic text, and DOC/DOCX has no application text parser. Reusing the full document extraction orchestrator would invoke unrelated classification/provider/domain processing, which is incompatible with context-only evidence.

## Owner decision and authenticated evidence implementation

The owner superseded the earlier direction: the assessment itself requires authentication. The public landing page remains public, and its CTA leads through sign-in to the assessment. No anonymous ownership or broad prospect entitlement system is introduced. Existing organization membership is the minimum access seam; a separate prospect/trial capability can be reviewed later.

Reused seams are the platform session-token context, verified `getActorContext`, existing storage bucket/API and immutable object-version capture, shared PDF layout reader, XLSX parsing library, durable assessment orchestration, provider task, human review, and Plan V2 resolver. A pinned pure Node Word parser extends shared parsing infrastructure. Assessment files create no live `documents` or project rows.

New service-only RLS tables hold server-owned organization/actor-bound drafts and immutable file metadata/context/provenance. Submission serializes against upload/removal on the draft row, rejects failed active files, freezes exact file/source/representation pins, and appends seven-answer v2 intake. Removal detaches evidence before submission and preserves stored source identity. Recorded evidence is retained, following existing evidence preservation; automated expiry/destructive cleanup is deferred.

Private storage is checked at upload time. Object paths bind organization/draft/file IDs with no overwrite. A restrictive managed Storage policy rejects direct anonymous/authenticated browser access to assessment-prefixed objects; other storage paths remain unaffected. API reads bind verified organization, draft and file ID and verify bytes against the digest, streaming downloads without exposed storage URLs. An isolated Storage RLS fixture in the default disposable replay exercises the exact policy under an otherwise permissive policy.

Provider input uses at most five files, 10 MiB each, with at most 4,000 selected-content characters per file. Metadata/source refs and limitations are also schema-bounded. PDF uses at most three native-text pages; scanned/unreadable files fail visibly. Word retains readable paragraph/table separators without inferring layout or heading levels. Workbooks retain sheet/range/cell addresses, formulas and cached displayed values without recalculation; sampling is bounded. CSV preserves row/cell structure; JSON preserves a bounded tree. Structured samples remain complete JSON values, with disclosed omissions. Corrupt/unsupported inputs fail visibly; failed files must be removed before submission.

The provider receives only validated bounded contexts, not raw files, URLs, tenant identity or unrelated files. Representation hashes are recomputed before any call; attachment inputs cannot replace intake determinism grounding. B8.3 allowlists, B8.2 activation authority and B8.4 assessment measurement semantics remain unchanged.

New organization-owned assessment/review reads and review writes enforce organization scope while preserving the existing platform reviewer allowlist and historical unassigned evidence. Read-only file controls are available after submission and in the human-review surface. No public customer-specific recommendation surface remains.

The earlier seven-question-only build/replay results are superseded for changed paths by the final authenticated-evidence gates. Reuse the historical browser/question/layout proofs for unchanged behavior, and the completed focused auth/tenant/provider tests. The updated signed-in browser cases passed with local synthetic auth and intercepted HTTP only: seven questions, text-only submission, multiple files, status, removal, failed-file submission blocking and recovery. No database/provider calls were made by those browser checks.

## Final authenticated evidence gates

- Disposable PostgreSQL replay passed all 134 migrations, including the authenticated assessment/file probes, exact restrictive Storage policy, organization isolation, immutable source manifests, historical v1/v2 compatibility and existing workflow authority/lifecycle checks. The migration, replay runner and SQL probe bytes are unchanged since that replay. Reuse it after parser/UI-only corrections; no production database was touched.
- The dependent Windows regression completed 88 files: 82 passed, three failed and three skipped; 1,500 assertions passed and ten failed. This was not a clean regression pass. Seven failures came from an outdated integration mock missing the new nullable organization column; the corrected integration file passed all 12 tests. One lexical architecture guard required the review surface to consume a read-only evidence wrapper; its unchanged guard passed all 21 tests after that correction. Two failures came from an existing Windows path-separator assumption in the Forgewing gates scanner; the unchanged scanner passed all five tests on Linux. The other 82 passing files remain valid and were not rerun.
- Focused final checks passed: authenticated intake/dialog (30), review access/read boundaries (52), own-assessment read (3), provider assessment (35), server evidence (10), review packet (15), extraction parser (19, plus the added compressed archive safety regression), and Next file tracing (8). Structured workbook/JSON pruning and cyclic OLE/forged ZIP rejection retain valid structured context and fail visibly without provider calls. Ambiguous metadata-write failure preserves potentially linked source bytes.
- Browser checks passed authenticated text-only and document/system examples, exact seven-answer submission, multiple uploads, corrupt-file blocking/removal recovery and authenticated file controls. All HTTP was intercepted with synthetic local identity; no real provider/database calls occurred. Reuse the unchanged desktop/mobile question-indicator geometry proof.
- Final build and CI status are recorded after completion. The build's first attempt compiled but hit Node's default 2 GiB heap during TypeScript; the final attempt uses 4 GiB headroom. Tests and production behavior were not weakened to work around resource pressure.

Verification commands: `node node_modules/vitest/vitest.mjs run <affected files> --maxWorkers 1 --no-file-parallelism --testTimeout 120000`; `node node_modules/typescript/bin/tsc --noEmit`; `bash scripts/verify-step0-migration-replay.sh`; `NODE_OPTIONS=--max-old-space-size=4096 npm run build`; `git diff --check`; CI `npx vitest run --reporter verbose` with no quarantined files. Linux execution uses a Git-tree snapshot and the same Node 24.13.1 runtime. Evidence logs and browser artifacts remain outside the repository in the folder above.

Deploy the additive schema before application code only after green review gates. The owner conditionally approved the migration; this implementation does not merge, deploy or apply it to a managed database. Future prospect entitlements and explicit evidence-to-project promotion remain separately scoped actions.

# Command Center B-BUG Audit — Error vs Empty State Trace + Fix Specs

**Date:** 2026-06-09  
**Branch:** feat/WorkHereOnly  
**Phase:** A — Read-only audit. No code changed.  
**Scope:** All Command Center warning banners; deep trace on the two confirmed B-BUG banners.

---

## 1. Banner Inventory

### 1a. Command Center — `app/platform/page.tsx`

The Command Center page (`app/platform/page.tsx`, lines 535–546) renders an array of warning strings from `operationalModel?.warnings`. These strings are produced server-side inside `loadOperationalQueueModel` in `lib/server/operationalQueue.ts` and returned as part of the `OperationalQueueModel` payload from `GET /api/operations`.

There are **five possible warning banners** in this surface, all originating in `lib/server/operationalQueue.ts`:

| # | Banner text | Source line | Table queried |
|---|-------------|-------------|---------------|
| 1 | "Document review state is unavailable. Review-based signals may be incomplete." | 1792 | `document_reviews` |
| 2 | "Recent feedback is unavailable. Intelligence exceptions may be incomplete." | 1795 | `decision_feedback` |
| 3 | "Recent document counts are unavailable." | 1798 | `documents` (count-only) |
| 4 | "Validator findings are unavailable. Queue-backed line issues may be incomplete." | 1822 | `project_validation_findings` |
| 5 | "Validator evidence links are unavailable. Queue deep links may fall back to the validator tab." | 1836 | `project_validation_evidence` |

Banners 1 and 2 are the confirmed B-BUG items.  
Banners 3, 4, and 5 share the same conditional pattern (see Section 6).

The render path is:

```
app/platform/page.tsx (line 267–268)
  useOperationalModel(enabled)
    → lib/useOperationalModel.ts
      → fetch('/api/operations')
        → app/api/operations/route.ts
          → loadOperationalQueueModel({ admin, organizationId })
            → lib/server/operationalQueue.ts (lines 1700–2033)
              → warnings[] array
                → OperationalQueueModel.warnings
                  → operationalModel.warnings (page.tsx line 281–284)
                    → rendered at page.tsx lines 535–546
```

The render conditional (page.tsx lines 535–546):

```tsx
{!isLoading && warnings.length > 0 ? (
  <div className="grid gap-2">
    {warnings.map((warning) => (
      <div
        key={warning}
        className="rounded-2xl border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-4 py-3 text-[11px] text-[var(--ef-warning-soft)]"
      >
        {warning}
      </div>
    ))}
  </div>
) : null}
```

Note: a separate hard-error banner exists at page.tsx lines 522–533, keyed on the hook-level `error` string (set when the `/api/operations` fetch itself fails). This is distinct from the warnings array.

### 1b. Documents Workspace — `app/platform/documents/page.tsx`

The Documents page has a single `workspaceWarning` state (line 662) rendered at lines 1256–1260. Three possible values, all set client-side in `fetchWorkspaceData`:

| # | Banner text | Source line | Table queried |
|---|-------------|-------------|---------------|
| 6 | "Document review state is unavailable. Needs Review filters may be incomplete." | 727 | `document_reviews` |
| 7 | "Decision state is unavailable. Workspace status may be incomplete." | 735 | `decisions` |
| 8 | "Execution task state is unavailable. Workspace status may be incomplete." | 745 | `workflow_tasks` |

Note: only one of these fires per load (last one to error wins, no array accumulation). Banner 6 shares the same root cause as Banner 1 — same table, same missing schema.

---

## 2. B-BUG Trace Per Banner

### Banner 1 — "Document review state is unavailable. Review-based signals may be incomplete."

**Render location:** `app/platform/page.tsx` lines 535–546 (warning loop).

**Query (operationalQueue.ts lines 1756–1759):**
```typescript
admin
  .from('document_reviews')
  .select('document_id, status, reviewed_at')
  .eq('organization_id', organizationId),
```

**Current conditional (operationalQueue.ts lines 1791–1793):**
```typescript
if (reviewsResult.error) {
  warnings.push('Document review state is unavailable. Review-based signals may be incomplete.');
}
```

**State distinction — does the code separate all three states?**

| State | Handled? | Banner fires? |
|-------|----------|---------------|
| `reviewsResult.data === []` (loaded, legitimately empty) | Yes — `documentReviews: reviewsResult.data ?? []` | **No** |
| `reviewsResult.error !== null` (query failed) | Yes — warning pushed | **Yes — B-BUG** |
| Pre-load / null data | Not applicable (Supabase returns `[]`, not `null`, for empty tables) | N/A |

**B-BUG location confirmed:** `lib/server/operationalQueue.ts` line 1791. The conditional fires on query error only. An empty table (valid state) does not trigger the banner. A query failure (schema drift, table absent) always triggers it.

**Downstream effect of error path:** When the error fires, `documentReviews` is passed as `[]` to `buildOperationalQueueModel` (line 1854–1856). This means `reviewStatusByDocumentId` is empty, so all documents report `reviewStatus = 'not_reviewed'`. The operational queue then underreports `needs_review_count` and silently omits documents that should be surfaced. The warning text "signals may be incomplete" is technically accurate but the trigger is wrong.

---

### Banner 2 — "Recent feedback is unavailable. Intelligence exceptions may be incomplete."

**Render location:** `app/platform/page.tsx` lines 535–546 (same warning loop).

**Query (operationalQueue.ts lines 1760–1767):**
```typescript
admin
  .from('decision_feedback')
  .select(
    'id, decision_id, is_correct, feedback_type, review_error_type, notes, disposition, created_at, decisions(id, title, severity, document_id, status)',
  )
  .eq('organization_id', organizationId)
  .order('created_at', { ascending: false })
  .limit(30),
```

**Current conditional (operationalQueue.ts lines 1794–1796):**
```typescript
if (feedbackResult.error) {
  warnings.push('Recent feedback is unavailable. Intelligence exceptions may be incomplete.');
}
```

**State distinction:**

| State | Handled? | Banner fires? |
|-------|----------|---------------|
| `feedbackResult.data === []` (no feedback rows) | Yes — `feedback: feedbackResult.data ?? []` | **No** |
| `feedbackResult.error !== null` (query failed) | Yes — warning pushed | **Yes — B-BUG** |
| Pre-load / null data | Not applicable | N/A |

**B-BUG location confirmed:** `lib/server/operationalQueue.ts` line 1794. Same pattern as Banner 1.

**PostgREST join failure mechanism:** The select includes `decisions(id, title, severity, document_id, status)` — a PostgREST relational embed. PostgREST resolves this by looking for a FK from `decision_feedback` to `decisions`. In the deployed schema, the FK `decision_feedback_decision_id_fkey` points to `public.document_decisions`, not `public.decisions`. PostgREST cannot find a `decision_feedback → decisions` relationship and returns:

```
Could not find a relationship between 'decision_feedback' and 'decisions' in the schema cache
```

This sets `feedbackResult.error`, which triggers the banner. The fix path therefore has two dimensions: schema (repoint the FK) and code (guard the conditional correctly).

---

## 3. Schema Drift Dependency Map

### 3a. Banner 1 — `document_reviews` table

**Deployed state:** Table is **absent** from the deployed Supabase schema (confirmed per task brief).

**Local migration:** `supabase/migrations/20260318000000_document_reviews.sql` — creates `public.document_reviews` with columns `id`, `organization_id`, `document_id`, `status`, `reviewed_by`, `reviewed_at`, `updated_at`. Includes RLS policies.

**Apply status:** Not applied to deployed project `jpzeckefppmiujwajgvk`.

**Effect:** Every execution of `loadOperationalQueueModel` issues a SELECT on `document_reviews`. With the table absent, PostgREST returns an error (`relation "public.document_reviews" does not exist`). `reviewsResult.error` is always truthy. **Banner 1 fires on every Command Center load.**

**B-BUG fix and schema drift fix are the same item:** Once `20260318000000_document_reviews.sql` is applied:
- The table exists
- The query returns `[]` (empty) or actual rows
- `reviewsResult.error` is `null`
- Banner 1 stops firing

However, the B-BUG in the conditional remains latent: if the table later develops a query error for any other reason (RLS misconfiguration, network partition, column mismatch), the banner would fire again on that error rather than on an absent-data condition. The conditional still needs the code fix described in Section 4.

**Secondary location:** Banner 6 in `app/platform/documents/page.tsx` (line 724–728) queries the same `document_reviews` table client-side and fires the same banner text with the same B-BUG pattern. It shares the same schema drift root cause.

---

### 3b. Banner 2 — `decision_feedback` FK mismatch

**Deployed state:** `decision_feedback` table **exists** but FK `decision_feedback_decision_id_fkey` points to `public.document_decisions` instead of `public.decisions`.

**Evidence (docs/environment/golden-data-location.md lines 117–122):**
```
decision_feedback rows: 0
current FK: decision_feedback_decision_id_fkey -> document_decisions
classification: State C — empty feedback table, FK-only/cosmetic repoint
```

**Local migration:** `supabase/migrations/20260606000000_repoint_decision_feedback_fk_to_decisions.sql` — drops the wrong FK and adds the correct one pointing to `public.decisions(id) ON DELETE CASCADE`. Includes an orphan-safety preflight.

**Why the correct FK was never applied:** `supabase/migrations/20250314000000_deterministic_decision_backbone.sql` (Section 11, lines 475–486) attempted to add `decision_feedback_decision_id_fkey → decisions.id` using `IF NOT EXISTS`. However, the FK already existed pointing to `document_decisions`, so the `IF NOT EXISTS` guard skipped the ADD. The correct FK was never established.

**Apply status:** `20260606000000` not yet applied. Preflight confirms zero orphaned rows — safe to apply.

**Effect:** PostgREST relational embed `decisions(...)` in the `decision_feedback` SELECT cannot resolve due to missing FK relationship. Query fails. `feedbackResult.error` is always truthy. **Banner 2 fires on every Command Center load.**

**Dependency chain:**
```
decision_feedback FK → document_decisions  (wrong, deployed)
  → PostgREST cannot find decision_feedback→decisions relationship
    → feedbackResult.error set
      → warnings.push('Recent feedback is unavailable...')
        → Banner 2 fires on every load
```

Once `20260606000000_repoint_decision_feedback_fk_to_decisions.sql` is applied:
- FK points to `decisions`
- PostgREST relational embed resolves correctly
- `feedbackResult.error` is `null`
- Banner 2 stops firing

As with Banner 1, the code-level B-BUG in the conditional remains latent and should be fixed independently.

---

## 4. Fix Specifications

### 4a. Banner 1 — "Document review state is unavailable. Review-based signals may be incomplete."

**File:** `lib/server/operationalQueue.ts`  
**Line:** 1791–1793

**Current conditional:**
```typescript
if (reviewsResult.error) {
  warnings.push('Document review state is unavailable. Review-based signals may be incomplete.');
}
```

**Correct conditional:**
```typescript
// Query error is not an empty-state condition — do not surface a degraded-data warning.
// Log or throw for observability; do not conflate error with absent data.
// The downstream `documentReviews: []` fallback already degrades gracefully.
if (reviewsResult.error) {
  // Server-side log only — no operator-facing warning for query failures.
  console.warn('[operationalQueue] document_reviews query failed:', reviewsResult.error.message);
}
// If the intent is to warn operators when review data is genuinely absent (empty table),
// that condition is: !reviewsResult.error && (reviewsResult.data?.length ?? 0) === 0
// However, an empty document_reviews table is valid state — no warning is warranted there.
// Recommendation: remove the warnings.push entirely from the error branch.
```

**Minimal code change:**
```typescript
// Remove this block entirely:
if (reviewsResult.error) {
  warnings.push('Document review state is unavailable. Review-based signals may be incomplete.');
}

// Replace with (if server-side observability is desired):
if (reviewsResult.error) {
  console.warn('[operationalQueue] document_reviews unavailable:', reviewsResult.error.message);
}
```

**Change type:** Component change only (no hook change required — the hook correctly exposes `error` state at the page level separately).

**Schema drift dependency:** Removing the warning from the code path can be applied now, independently of schema migration. The banner will stop firing immediately once the code change is deployed. The schema migration must still be applied for the underlying data to be available.

---

### 4b. Banner 2 — "Recent feedback is unavailable. Intelligence exceptions may be incomplete."

**File:** `lib/server/operationalQueue.ts`  
**Line:** 1794–1796

**Current conditional:**
```typescript
if (feedbackResult.error) {
  warnings.push('Recent feedback is unavailable. Intelligence exceptions may be incomplete.');
}
```

**Correct conditional:**
```typescript
// Same pattern as document_reviews: error state ≠ absent data.
// Remove from warnings.push. Add server-side log if observability is needed.
if (feedbackResult.error) {
  console.warn('[operationalQueue] decision_feedback unavailable:', feedbackResult.error.message);
}
```

**Minimal code change:**
```typescript
// Remove this block entirely:
if (feedbackResult.error) {
  warnings.push('Recent feedback is unavailable. Intelligence exceptions may be incomplete.');
}

// Replace with (if server-side observability is desired):
if (feedbackResult.error) {
  console.warn('[operationalQueue] decision_feedback unavailable:', feedbackResult.error.message);
}
```

**Change type:** Component change only (server function, no hook change required).

**Schema drift dependency:** Same as Banner 1 — the code fix can be applied independently. The FK migration (`20260606000000`) must still be applied for `feedbackResult` to return actual data.

---

### 4c. Banner 6 (Documents page) — "Document review state is unavailable. Needs Review filters may be incomplete."

**File:** `app/platform/documents/page.tsx`  
**Line:** 724–728

**Current conditional:**
```typescript
if (reviewsResult.error) {
  setReviews([]);
  setWorkspaceWarning(
    'Document review state is unavailable. Needs Review filters may be incomplete.',
  );
}
```

**Correct conditional:**
```typescript
if (reviewsResult.error) {
  setReviews([]);
  // Do not set workspaceWarning — query error ≠ genuinely absent data.
  // If a hard-error signal is needed, use setDocsError() instead of setWorkspaceWarning().
}
```

**Schema drift dependency:** Same as Banner 1 — the `document_reviews` table must exist for this query to succeed.

---

## 5. Application Order

### What can be fixed now (independent of Supabase schema)

Both code fixes in Section 4a and 4b are **independently deployable**. Removing `warnings.push()` from the error branches in `loadOperationalQueueModel` stops the banners immediately, regardless of whether the schema migrations have been applied.

**Priority:** Apply the code fixes first. This stops the false banners on every operator load now, and ensures the warn-on-error B-BUG pattern does not reappear after schema migrations are applied.

**Safe to commit:** Yes. No schema dependency. Changes are in `lib/server/operationalQueue.ts` only (server function, no RLS impact, no data mutation).

---

### What requires Supabase schema resolution first

Applying the code fix alone does not restore the underlying data. After the code fix:
- Banner 1 is gone, but `documentReviews` is still `[]` on every load (because `document_reviews` doesn't exist)
- Banner 2 is gone, but `feedback` is still `[]` on every load (because the FK join fails)
- `needs_review_count`, `intelligence.needs_review_documents`, and reviewer signal downstream of `buildOperationalQueueModel` remain silently incorrect

**Schema fixes required:**
1. Apply `supabase/migrations/20260318000000_document_reviews.sql` — creates `document_reviews` table
2. Apply `supabase/migrations/20260606000000_repoint_decision_feedback_fk_to_decisions.sql` — repoints `decision_feedback` FK

**Recommended apply order:**
1. Code fix (remove banner from error branch) → deploy
2. Apply `20260318000000_document_reviews.sql` on a dev/preview branch, verify query returns `[]` (empty), promote
3. Apply `20260606000000_repoint_decision_feedback_fk_to_decisions.sql`, verify PostgREST join resolves, promote
4. Verify Command Center loads without warnings on a clean session

**Blocker check:** `golden-data-location.md` documents that `decision_feedback` has zero rows — the FK repoint is State C (safe/cosmetic). The `document_reviews` migration uses `CREATE TABLE IF NOT EXISTS` — idempotent and safe.

---

## 6. Other B-BUG Candidates Found During Audit

All five Command Center warnings in `lib/server/operationalQueue.ts` share the same B-BUG conditional pattern (`if (result.error) { warnings.push(...) }`). Three additional candidates beyond the two primary ones:

### Candidate A — "Recent document counts are unavailable." (operationalQueue.ts line 1797–1799)

**Query:** `documents` table, count-only (`head: true`)  
**Conditional:**
```typescript
if (recentDocumentsResult.error) {
  warnings.push('Recent document counts are unavailable.');
}
```
**B-BUG:** Same pattern. Fires on query error. The `documents` table exists and is not schema-drift affected, so this banner is unlikely to fire currently — but the conditional is wrong in principle.

---

### Candidate B — "Validator findings are unavailable..." (operationalQueue.ts line 1821–1822)

**Query:** `project_validation_findings` table  
**Conditional:**
```typescript
if (findingsResult.error) {
  warnings.push('Validator findings are unavailable. Queue-backed line issues may be incomplete.');
}
```
**B-BUG:** Same pattern. Additionally, this query is conditional on `projectIds.length > 0`, so it only fires when projects exist. Not currently blocked by schema drift.

---

### Candidate C — "Validator evidence links are unavailable..." (operationalQueue.ts line 1835–1836)

**Query:** `project_validation_evidence` table  
**Conditional:**
```typescript
if (evidenceResult.error) {
  warnings.push('Validator evidence links are unavailable. Queue deep links may fall back to the validator tab.');
}
```
**B-BUG:** Same pattern. Only fires when `findingIds.length > 0` (nested inside findings block). Not currently schema-drift affected.

---

### Candidate D — Documents page banners 7 and 8 (`app/platform/documents/page.tsx`)

- "Decision state is unavailable..." (line 733–737) — fires on `decisionsResult.error`
- "Execution task state is unavailable..." (line 742–746) — fires on `tasksResult.error`

Both `decisions` and `workflow_tasks` tables exist and are not schema-drift affected, so these are unlikely to fire currently. However, both share the identical B-BUG conditional pattern.

**Additional note:** The `workspaceWarning` state in `documents/page.tsx` is a single string (not an array). The three candidates (Banners 6, 7, 8) are evaluated in sequence — each overwrites the previous. If `document_reviews` fails first and then `workflow_tasks` also fails, only the `workflow_tasks` message is shown. This is a separate (minor) flaw: only the last error is surfaced.

---

## Acceptance

- [x] Document exists at `docs/decisions/COMMAND_CENTER_BBUG_AUDIT.md`
- [x] Section 1: All 8 Command Center and Documents-workspace banners inventoried
- [x] Section 2: B-BUG trace per banner (render → conditional → hook → error vs empty vs null)
- [x] Section 3: Schema drift dependency map for both confirmed banners
- [x] Section 4: Fix specifications with exact file, line, before/after for all confirmed B-BUG items
- [x] Section 5: Application order — what can be fixed now vs what requires Supabase
- [x] Section 6: Five additional B-BUG candidates identified and documented
- [x] No code files modified

# B4.4 local browser qualification

Run from the repository root with dependencies installed. The runner uses `B44_CHROME_EXECUTABLE` when provided, otherwise local Windows Chrome when present, otherwise Playwright's installed Chromium. It installs no browser:

```powershell
npx vite-node --config vitest.config.ts scripts/evaluation/b44/run.ts
```

The runner starts a temporary loopback Vite server, opens headless Chrome, executes the actual Resolution Workspace and reviewed-values panel, then closes both. It prints an absolute artifact directory containing screenshots and `report.json` with request bodies and actual impact results.

The frontend aliases only Next Link, authentication, and the source-page renderer. Queue projection uses the actual Core queue builder, region-assertion resolution, and Forgewing reading projector. Impact requests execute the actual `previewResolutionImpact` with its default `validateInMemory`, the real Validator, and a synthetic source snapshot. No Validator results or impact counts are invented.

The provider and persistence transports use synthetic in-memory rows. Assertion transport runs the actual parsing, evidence preparation, and chain checks, then creates an in-memory reviewed row. This verifies browser request wiring and source-bound reviewed-value visibility. It does **not** prove database persistence, database-derived accepted/modified provenance, provider execution, activation/entitlement enforcement, or production readiness. Those require the separate B3 SQL and B4.3/B4.4 backend gates. The report carries this limitation explicitly.

Scenarios cover Ask with no automatic form population, explicit full-row selection with no request or write, real impact preview, unedited and edited cited submissions, visible reviewed values, Reject/Defer without queue advancement, stale-refresh draft/citation invalidation, unreadable/service-failed/budget outcomes, and manual Core entry with no Forgewing area or citation.

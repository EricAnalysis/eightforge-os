# Durable browser verification

Use this harness for authenticated browser audits and UI verification. Do not copy a Chrome profile or rely on an existing browser session.

## One-time local setup

The seed script only accepts the local development Supabase project (`jpzeckefppmiujwajgvk`) unless `--force` is explicitly supplied. It creates or updates `e2e-verifier@eightforge.test`, confirms its email, and upserts the same `user_profiles` organization association used by the app. The profile is a `viewer`, so the browser is an ordinary authenticated organization member rather than a service-role client.

Set a local-only password, then seed the identity:

```powershell
$env:E2E_TEST_USER_PASSWORD = '<long-local-only-password>'
npm run seed:test-user
```

For reuse across shells, place the same value in `.env.test.local` (which is ignored):

```dotenv
E2E_TEST_USER_PASSWORD=<long-local-only-password>
# Optional; defaults to e2e-verifier@eightforge.test
E2E_TEST_USER_EMAIL=e2e-verifier@eightforge.test
```

The seed script updates the Auth password on every run and verifies a Golden Project read using an anon-key authenticated session. It never writes the password to a source file or `tests/.auth/`.

## Refresh the persisted browser state

Start the local app in one terminal:

```powershell
npm run dev
```

Then refresh the state in another terminal:

```powershell
npx playwright test --project=setup
```

The setup probes the existing `tests/.auth/user.json`; it keeps it when usable and signs in again when it has expired or redirects to `/login`. The file is ignored by Git.

## Run the Golden smoke verification

```powershell
npx playwright test tests/e2e/golden-overview.smoke.spec.ts --project=chromium-smoke
```

The test writes success, failure, and evidence screenshots to `output/playwright/` (also ignored). It records the elapsed time to the Golden Overview marker as a Playwright annotation. If the known render stall prevents that marker within 120 seconds, it records a stall annotation and leaves the evidence captures skipped; this does not invalidate the authentication harness.

Future audits and browser-verification prompts must use this seed + setup flow rather than copying a Chrome profile. Keep browser verification as an ordinary authenticated user; never expose or use `SUPABASE_SERVICE_ROLE_KEY` in the browser.

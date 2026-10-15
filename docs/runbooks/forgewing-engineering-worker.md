# Forgewing Engineering Worker: host runbook

The Engineering Worker is the production host for repository-aware Plan V2
reasoning (B1-B3a). Vercel is the control plane only: the authenticated
`/api/internal/repository-plan-runs` route queues a job, and this worker claims
and runs it. Background and authority:
[repository-plan-foundation.md](../architecture/repository-plan-foundation.md).

**Authority.** The worker is advisory. It claims jobs through its own database
role `forgewing_engineering_worker` (NOLOGIN, NOBYPASSRLS), never the service
role, and can only execute the claim, exact-source read, provider-start,
success/failure and Plan V2 persistence functions. Every artifact is
`non_authoritative`, `executable: false`, `requiresHumanReview: true`.
Engineering review, Linear projection and execution stay human.

## What the host needs

| Need | Detail |
|---|---|
| Image | `Dockerfile.worker` (Node 24.21.0, git, locked dependencies), built from one commit |
| Checkout | A real, clean EightForge Git checkout (with `.git` objects and origin) at the **same commit** as the image, mounted read-only at `/repository` |
| Network | Outbound HTTPS to Supabase and Anthropic only. No inbound port. |
| Secrets | `FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN` (dedicated-role JWT), `ANTHROPIC_API_KEY` |
| Config | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or `NEXT_PUBLIC_SUPABASE_ANON_KEY`) |

Never give the worker `SUPABASE_SERVICE_ROLE_KEY`; it would be refused anyway.

## Build

```bash
COMMIT=$(git rev-parse origin/main)
git archive --format=tar "$COMMIT" | docker build -f Dockerfile.worker -t eightforge-forgewing-worker:"$COMMIT" -
```

Building from `git archive` sends only committed bytes: no `.env`, no untracked
files, no CRLF checkout drift.

## Checkout

```bash
git clone https://github.com/EricAnalysis/eightforge-os.git /srv/eightforge-checkout
git -C /srv/eightforge-checkout checkout --detach "$COMMIT"
```

Keep it clean; the worker verifies a clean tree and refuses otherwise. Update it
only together with the image (same commit), never while a job is running.

## Mint the worker token

The token is a JWT whose `role` claim is exactly `forgewing_engineering_worker`,
signed with the Supabase project's JWT secret so PostgREST runs requests under
that role. Mint it on a trusted machine. It is a secret: never commit it, never
put it in Vercel.

```bash
SUPABASE_JWT_SECRET='<project JWT secret>' node -e '
const { createHmac } = require("node:crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({ role: "forgewing_engineering_worker", iss: "eightforge-worker", iat: now, exp: now + 90 * 86400 });
const sig = createHmac("sha256", process.env.SUPABASE_JWT_SECRET).update(head + "." + body).digest("base64url");
console.log(head + "." + body + "." + sig);'
```

- Lifetime is 90 days at most. Rotate by minting a new token, restarting the
  worker with it, then letting the old token expire. To revoke early, rotate
  the project JWT secret, which invalidates every token signed with it.
- A token whose role is anything else, including `service_role`, makes the
  worker exit at startup with `worker_client_unconfigured`.

## Run

```bash
docker run -d --name forgewing-worker --restart unless-stopped \
  --read-only --tmpfs /tmp \
  -v /srv/eightforge-checkout:/repository:ro \
  -e SUPABASE_URL -e SUPABASE_PUBLISHABLE_KEY \
  -e FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e FORGEWING_MODEL=claude-sonnet-4-6 \
  eightforge-forgewing-worker:"$COMMIT"
```

Optional settings:
- `FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS`: 1,000-60,000; default 5,000.
- `FORGEWING_REPOSITORY_PLAN_ONE_SHOT=1`: process one job, then exit.
- `FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS`: default 60,000, maximum 120,000.
- `FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS`: default 8,000, maximum 16,000.

**Fail-closed startup.** The worker exits with code 1 before any poll in any of
these cases:
- `FORGEWING_REPOSITORY_ROOT` is missing or not absolute;
- the polling interval is invalid;
- the dedicated-role client cannot be built (`worker_client_unconfigured`);
- `/repository` is not a Git checkout (`repository_checkout_missing`).

## Deployment procedure and fail-closed verification

Do these steps in order. Stop at the first failure. Nothing here enables provider reasoning.

1. **Pick the commit.**
   ```bash
   COMMIT=$(git rev-parse origin/main)
   ```
   Use the commit that is deployed on Vercel. The worker and the control plane must agree on job and Plan V2 schemas.
2. **Build the image** from `git archive "$COMMIT"` (see [Build](#build)) and tag it with the commit.
3. **Prepare the checkout** at the same commit, read-only for the container user (see [Checkout](#checkout)).
4. **Mint the token** (see [Mint the worker token](#mint-the-worker-token)) and store it in the host's secret store, not in shell history or files in the checkout.
5. **Run the host preflight** with exactly the environment the container will get:
   ```bash
   node scripts/workers/forgewing-worker-preflight.mjs --checkout /srv/eightforge-checkout --image-commit "$COMMIT"
   ```
   It must print `PREFLIGHT: PASS`. It checks:
   - the Supabase target is set;
   - the service-role key is absent;
   - the token role is exactly `forgewing_engineering_worker`, unexpired and at most 90 days;
   - the checkout is a clean Git repository whose HEAD equals the image commit.

   It never prints secrets or contacts Supabase or Anthropic. Provider gates are only reported.
6. **Fail-closed proof (negative runs, expected to fail).** Each must exit 1 with the stated code before any poll:
   - **No token:** `docker run --rm eightforge-forgewing-worker:"$COMMIT"` gives `configuration_failed code=worker_client_unconfigured`.
   - **A `service_role` token:** gives `worker_client_unconfigured`.
   - **The right token but no checkout mounted:** gives `repository_checkout_missing`.
7. **First safe job, still with provider gates off.**
   - Queue one ADVISORY job from a reviewed assessment.
   - Run the container once with `-e FORGEWING_REPOSITORY_PLAN_ONE_SHOT=1`.
   - Confirm `GET /api/internal/repository-plan-runs/<jobId>` reports `succeeded` with `providerCallCount: 0`.
8. **Start the long-running worker** (see [Run](#run)) with `--restart unless-stopped`, still with provider gates off.
9. **Record the deployment** in the engineering log: the commit, the image digest, the token expiry date (never the token), and the preflight and one-shot results.

Provider reasoning is a separate, later decision (next section). Even with the gates set, a model outside `FORGEWING_QUALIFIED_MODELS` keeps it disabled.

## Turn on provider reasoning (separately, deliberately)

With the gates off, the worker still completes ADVISORY and insufficient-evidence
jobs with zero provider calls. Provider-required jobs fail with
`provider_disabled`, which the UI shows as "Forgewing unavailable".

To allow provider reasoning, add:
- `FORGEWING_SHADOW_ENABLED=1`;
- `FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED=1`;
- a model in `FORGEWING_QUALIFIED_MODELS` (S2). An unqualified model keeps the
  gate closed with `model_unqualified`.

**First safe check, before enabling the provider gates:**
1. Queue one ADVISORY job from the reviewed assessment's implementation-plan page.
2. Run the worker once with `FORGEWING_REPOSITORY_PLAN_ONE_SHOT=1`.
3. Confirm with `GET /api/internal/repository-plan-runs/<jobId>` that the job
   succeeded with `providerCallCount: 0`.

## Operating signals

- **Logs** carry job identity and typed codes only (`succeeded jobId=...
  providerCallCount=...`, `failed jobId=... code=...`). They never include
  prompts, repository contents, provider output or credentials.
- **No worker running:** a queued job stays `pending`. After five minutes the
  run control stops polling and says that no worker has picked the job up. The
  job is untouched and is claimed when a worker starts.
- **Stop:** `docker stop forgewing-worker`. SIGTERM ends the poll loop after the
  current job.
- **Rollback:** stop the container. Queued jobs wait; persisted Plan V2 runs are
  immutable evidence.

## Improvement deployment worker (B8.4)

The improvement deployment worker (`scripts/workers/improvement-deployment-worker.ts`)
makes no provider calls. It shares the same token, role, image and checkout.

```bash
docker run --rm --read-only --tmpfs /tmp -v /srv/eightforge-checkout:/repository:ro \
  -e SUPABASE_URL -e SUPABASE_PUBLISHABLE_KEY -e FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN \
  --entrypoint node eightforge-forgewing-worker:"$COMMIT" \
  node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/workers/improvement-deployment-worker.ts
```

Schedule it with the host's scheduler (cron or a systemd timer). It runs one
pass per invocation.

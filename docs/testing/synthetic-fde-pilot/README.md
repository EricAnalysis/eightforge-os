# Synthetic FDE Customer Pilot

**Everything here is fictional.** All customer, agency, people, contract, rate, and ticket details are invented. Files are labeled `SYNTHETIC`. **Status: prepared, not executed.**

This package tests the Forward Deployed Engineering workflow from Workflow Assessment through approval and staleness. It was written against merged FDE Plan Approval ([EricAnalysis/eightforge-os#298](https://github.com/EricAnalysis/eightforge-os/pull/298), merge commit `2737e24`).

## Who sees what

| Folder | Audience | Contents |
|---|---|---|
| `customer/` | Customer actor | Profile, seven intake answers, documents, upload order |
| `operator/` | Authorized reviewer and test operator | Follow-up answer bank, waiver test, human-review scenario, later upload, negative test files |
| `evaluator/` | Independent evaluator only | Frozen expected-outcome manifest and scoring guide |

Keep `evaluator/` away from the customer and reviewer actors until scoring.

## Execution rules

- **Never run this against production.** Do not insert synthetic records into production, perform real approvals, or bypass authentication.
- Do not edit `evaluator/expected-outcome-manifest.json` after the first run. `SHA256SUMS` records the frozen version.
- Stop immediately and report if any step would need a production credential or customer data.

## Environment required

The environment must be verified before the pilot starts. See [MISSING-CAPABILITIES.md](MISSING-CAPABILITIES.md) for what doesn't exist yet.

1. A Supabase project with no customer data, all migrations through `20261104120000`, Auth, and Storage with a private `documents` bucket.
2. The EightForge app at or after `2737e24`, pointed only at that project.
3. Three synthetic users:
   - **Customer member**, in Org A, not allowlisted.
   - **Authorized reviewer**, in Org A, listed in `INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS`.
   - **Outsider**, in Org B, used for isolation checks.
4. For Workflow Assessment, per `docs/runbooks/forgewing-production-env.md`:
   - Forgewing master switch on and `FORGEWING_WORKFLOW_ASSESSMENT_ENABLED=1`.
   - `FORGEWING_WORKFLOW_ASSESSMENT_DAILY_CAP` above 0.
   - `FORGEWING_MODEL` set to a qualified model.
   - `ANTHROPIC_API_KEY` set.
   - Org A has an entitlement row, plus a data-policy row approving `text_excerpts`.
   - `CRON_SECRET` set, to trigger the assessment.

## Run order

Before starting, confirm the files are intact:

```bash
sha256sum -c SHA256SUMS
```

1. **Capture a baseline** of canonical table row counts in the test database.
2. **Scenario 1, standard intake.** The customer follows `customer/02-upload-plan.md` and submits. The operator triggers the assessment:
   `POST /api/internal/workflow-assessment` with `{"submissionId":"..."}` and `Authorization: Bearer $CRON_SECRET`. The reviewer then follows `operator/human-review-scenario.md`, Parts A and B.
3. **Scenario 2, waiver.** The reviewer follows `operator/waiver-test-instructions.md`, then `operator/human-review-scenario.md`, Part C, to record the approval.
4. **Scenario 3, later upload.** Follow `operator/later-amendment-upload.md`.
5. **Compare canonical row counts** against the baseline.
6. **Score** with `evaluator/README.md`.

## Regenerating the files

```bash
python generate_package.py
```

The script uses only the Python standard library, so repeated runs produce identical bytes. Handwritten documents are included in `SHA256SUMS` as they stand.

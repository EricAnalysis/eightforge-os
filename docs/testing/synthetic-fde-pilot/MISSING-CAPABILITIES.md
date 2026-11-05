# Capabilities the pilot needs or will expose

SYNTHETIC pilot package. These come from reading the code at merge commit `2737e24`. Nothing here was found by running the pilot.

## Prevents execution today

| Gap | Effect | What is needed |
|---|---|---|
| **No verified isolated environment.** The repo has `supabase/migrations` but no `supabase/config.toml`. | The pilot can't start. | Stand up a local Supabase stack or a verified empty project. Supabase Preview branches apply migrations (PR #298's did), but one would need its isolation and a matching app deployment confirmed first. |
| **The assessment needs a live model call.** It runs behind the Forgewing gates and an internal trigger. | Without it there is no assessment and no FDE plan. | Enable it only in the isolated environment, with synthetic data, an entitlement row, and a data-policy row. This costs money and needs owner approval. |
| **BotID guards intake submission.** `POST /api/workflow-intake` fails closed on a bot verdict. | Scripted submission may be refused. | Use a real browser session and check local behavior. Do not bypass it. |

## Limits the pilot's goals

| Gap | Effect on the scenario |
|---|---|
| **A later upload does not reassess.** The upload path creates a new evidence revision and plan digest, but never calls the assessment. The assessment claim also excludes a submission that already has an assessment. | Scenario 3 tests staleness and re-review, not reassessment. The model never reads Amendment No. 2. |
| **The FDE plan reads no document values.** It tracks files and needs, not rates or tickets. | The plan can't verify rates, apply amendment precedence, or find the rounding contradiction. Only the model (from bounded context) or a human can. |
| **Bounded context hides evidence from the model.** PDFs give 3 pages, sheets give 12 rows, and each file gives 4,000 characters. | The model can't see tickets from T-100210 onward. Humans must open the files. |
| **Only an authorized reviewer can record a waiver.** Audit correction P1 limited decisions to the platform reviewer allowlist. | The customer states the position, and the reviewer records it. **The label "Customer-Acknowledged" overstates this** and needs an owner decision on wording, or on a customer-side acknowledgment. |
| **The reviewer must belong to the customer's organization.** Actor scope and plan scope must match. | Org A needs its own allowlisted reviewer. A separate platform reviewer organization can't be tested. |
| **Follow-up answers are reviewer-recorded.** The answer route is allowlist-gated. | The reviewer types the customer's answers from the bank. |
| **The customer's route back to the FDE page is thin.** The link appears only in the same session, after "Check assessment status". Returning starts a new draft. | Save the assessment ID, or reach the page from the reviewer side. |
| **Waiver eligibility depends on the model naming the document.** Only a `described_document` or an answered follow-up can be waived. | If the model omits the truck list, Scenario 2 can't start. This is scored as `PILOT-PRECONDITION`. |
| **Owner activation has no recording path.** The need comes from a fixed catalogue status. | If a step matches `model_explanation`, that plan can't be approved. |
| **A reclassified step has no resolution path in this flow.** It creates an `assessment_review_conflict` that blocks approval on that assessment version. | The reviewer should not reclassify just to proceed. If one is truly needed, record a finding and stop. |

## Not tested by this package

- Vercel's 4.5 MB request limit, against the 10 MB application limit. All pilot files are far smaller.
- Actual invoice generation, because no FDE path produces one. The manifest's ticket arithmetic is ground truth for human conclusions and any future capability.

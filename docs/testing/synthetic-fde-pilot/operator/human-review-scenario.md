# Human Review Scenario (SYNTHETIC)

For the **authorized reviewer** in Org A. Open every source you cite. Your conclusions must come from what you read, not from this script. Record what actually happens, including anything that blocks you.

## Part A: Assessment review

Open the assessment in the review queue at `/platform/workflows/reviews`.

1. Read the proposed steps against the intake.
2. If a step's classification is right, accept it as proposed.
3. Keep every human-only decision as `HUMAN`: mixed-load classification, light-load sign-off, invoice approval, and correction of past invoices.
4. If a human-only decision was proposed as `RULE` or `VERIFY`, don't accept it. Record `changes_required`, **stop**, and report this as a finding, because the plan can't proceed on that assessment version.
5. If you accept every step, record an overall `accepted`.

## Part B: Follow-up answers and information needs

1. Record follow-up answers from `follow-up-answer-bank.json`, picking the entry closest to each question. Use "Anything not listed here" when none fits. Never invent an answer.
2. Select **Open FDE plan approval**. Read the status, plan digest, documents, and needs.
3. As a test, try to approve with needs still open. The approval should not be available.

Resolve each need with your own conclusion, your rationale, and a source:

| Need type | How to handle it |
|---|---|
| Supported described document | Open the file, then confirm only what it actually shows, citing that file. |
| Parser limitation (partial document) | Open the **whole** file. State what you read beyond the partial extract, citing that file. |
| Follow-up answer | Treat it as a customer statement. Confirm only what you checked. |
| Relationship or assessment limitation | Check the sources, and state your conclusion. |
| Truck certification list | See `waiver-test-instructions.md`. |
| Review conflict, missing human decision, owner activation, or unavailable evidence | You can't confirm or waive these. Record the block as a finding. |

### What to look for in the documents

Read these yourself and form your own conclusion:

- Do the MSA and the SOP treat partial cubic yards the same way? If not, which governs, and why?
- Is Amendment No. 1 fully executed on the copy you have?
- Do the tickets, taken in full, show anything that shouldn't go straight to billing?
- Do all schedule items have a rate?

**You may not decide these on the customer's behalf:** how to bill mixed-load ticket T-100211, whether T-100210 gets paid, or whether past invoices get corrected. Note each as reserved to the Project Director.

## Part C: Decision

After following the waiver test, choose **Approve recommendation**, and write your rationale. Your approval records a recommendation only. It doesn't authorize implementation, activation, or changes to Project Truth.

Then confirm:

- The status reads **Approved — Customer-Acknowledged Evidence Waiver**.
- The recommendation shows each conclusion, and shows the waived item as unverified.
- History shows your decision and rationale.

# Later Amendment Upload (SYNTHETIC)

Start only after an approval exists from Scenario 2.

## Before uploading

Save these values from the FDE plan page or API response:

- The base digest and current status
- The history entries, including version and rationale
- The waiver record

Keep the page's earlier state available in a **second browser tab**. You'll use it to test a stale submission.

## Upload

1. As the customer member, open the saved FDE plan page.
2. Under **Add supporting document**, choose `customer/documents/later/06-contract-amendment-02.pdf`.
3. Associate it with the information need about the pricing schedule or contract amendments. If there's more than one, pick the closest and record which one.
4. Select **Upload supporting document**.

## Check

As the reviewer, reload the page. Then record:

- Status, base digest, and evidence revision
- The earlier approval's label, and whether a current recommendation still shows
- The new document's entry, and the state of the need you associated it with
- Whether a new parser limitation need appeared
- Whether the earlier decision, rationale, and waiver are still readable

## Stale submission test

From the **second tab**, which still holds the earlier plan, try to record a decision. It should be refused, and nothing should be recorded.

## Reconsider

Read Amendment No. 2. Consider which earlier conclusions it changes, including tickets and rates after its effective date. Re-resolve every need, re-enter the waiver if you still support it, then record a new decision.

## Optional negative tests

Run these after re-approval, then record each result. Each file is in `negative-test-files/`.

| File | Action |
|---|---|
| `unsupported-field-notes.txt` | Upload it. |
| `not-a-real-workbook.xlsx` | Upload it. |
| `scanned-ticket-batch-image-only.pdf` | Upload it, then upload any valid replacement to confirm you aren't blocked. |

As the **customer member**, try to record a decision through the API. As the **outsider** in Org B, try to open the plan and a document. Record each response.

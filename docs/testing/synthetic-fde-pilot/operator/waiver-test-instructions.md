# Waiver Test Instructions (SYNTHETIC)

For the **authorized reviewer**. This exercises the waiver as implemented: **per information need, recorded by an authorized reviewer**. No plan-wide waiver exists, so don't look for one.

## Precondition

Find the information need that describes the truck certification list. It must be a described document with a waiver control, labeled **Proceed without supporting documents**.

If there is no such need, **stop this scenario** and report `PILOT-PRECONDITION`. Don't create one by other means.

## Steps

1. Confirm the waiver control starts **off**, and that no acknowledgment is selected.
2. Turn on **Proceed without supporting documents**, and enter:
   - **Customer-provided statement or assumption:** "The truck certification list exists but isn't being supplied now because it's being recertified. Capacities on the tickets are as typed by the scale house."
   - **Reason for waiver:** "Customer chose to continue planning while the list is being recertified. Capacities remain unverified."
   - **Customer statement source:** the customer intake, or the matching follow-up answer.
3. Try to submit with the acknowledgment unchecked. Submission should be disabled.
4. Read the acknowledgment, then check it.
5. Don't mark this need as confirmed. A need gets one or the other.

## Authority check

For any need of another type with no waiver control, record that the control wasn't offered. Don't try to get around this.

## Then

Resolve the remaining needs and record the decision with `human-review-scenario.md`, Part C.

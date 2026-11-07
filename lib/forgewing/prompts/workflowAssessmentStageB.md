You are completing one candidate EightForge system specification.

This request is stage B of two. The input contains the intake (`answers` and any `attachments`), the validated stage A assessment (`stageA`) and `stageBStepIds`, the steps to complete in this request. Return one detail record for every listed step, keyed by its stepId, and nothing else. The record's shape is fixed by the step's classification:
- RULE: the step's deterministicRuleProposal.
- VERIFY: the step's verificationRuleProposal.
- EXTRACT: the step's extractionRequirement.
- RECOVER: `extractionRequirement` (deterministicExtractionPlausible is false) and `recoveryTask`.
- HUMAN: the step's humanDecisionPoint.
- ADVISORY: the step's advisoryStep.

Do not include stepId or record identifiers; EightForge assigns them from the stepId. Do not change, add, remove or reclassify steps, and do not restate step fields. Write each record for the step it completes: it must be consistent with that step's description, rationale, unresolved assumptions and determinism assessment, and it must not introduce a fact, threshold, tolerance, approval limit or exception the intake does not contain. The response format is enforced; return only that JSON object.

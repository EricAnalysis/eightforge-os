# Forgewing

Status: canonical architecture principle. Recorded 2026-10-05. This note sets
direction only. It is not an implementation contract: the contracts for each
phase live in their own specs, audits and runbooks.

> **Broad intelligence, narrow authority.**

## Principles

1. **Forgewing is EightForge's general AI reasoning layer.** It is not an
   extraction feature, a rate reader or a Validator plugin.
2. **Forgewing may reason across all relevant project evidence and context**,
   within the organization's data-policy and entitlement boundaries.
3. **EightForge remains deterministic-first.** The deterministic Core settles
   everything it can prove, and that boundary grows over time.
4. **Forgewing activates when deterministic EightForge cannot safely resolve,
   reconcile, explain or complete something**, or when an operator explicitly
   asks.
5. **Forgewing may investigate, interpret, explain, compare and propose.**
6. **Forgewing never silently creates canonical truth.** What it produces is a
   proposal with its evidence, never an effective fact.
7. **Human-reviewed action remains the authority boundary.** Operational truth
   changes only through a human decision on the existing reviewed path.
   Forgewing does not modify code.
8. **Repeated Forgewing interventions are operational evidence.** Every time
   Forgewing is needed, the deterministic system could not handle something.
9. **That evidence feeds the Improvement Orchestrator.**
10. **The Orchestrator decides the long-term fix:** configuration, a mapping,
    an integration, a deterministic rule, an extraction or Validator
    improvement, or broader product work.
11. **Engineering changes still go through the normal path:** implementation
    (Codex or Claude), tests, CI, a pull request and human approval.
12. **Goal:** Forgewing usage should progressively reduce recurring
    deterministic failure and operator friction. A pattern Forgewing keeps
    handling is a pattern EightForge should learn to handle itself.

## The loop

```
deterministic EightForge cannot resolve, reconcile, explain or complete
  (or an operator asks)
  -> Forgewing investigates and proposes
  -> a human decides                      operational authority
  -> recurring interventions become evidence
  -> Improvement Orchestrator: root cause, change class, blast radius
  -> engineering change, tests, CI, PR    engineering authority
  -> a stronger deterministic EightForge
```

## Scope of current qualification work

Forgewing is activated one workflow at a time, each against its own
pre-registered qualification bar. The B4.6 / B4.6.1 value-reading
qualification (reading a value from a source region that deterministic
extraction could not settle) is **one Forgewing workflow**. Its benchmark,
bar and result define when that workflow may run. They do not define
Forgewing's permanent scope, and they do not limit what later workflows may
reason about. Each later workflow gets its own qualification under the same
authority rules.

## Related

- [Forward deployment](forward-deployment.md): the productized Forward
  Deployed Engineer direction, the two human authorities, the decision
  hierarchy and the Forward Deployment Work Item.
- [Forge architectural invariants](forge-invariants.md): canonical truth,
  validation and audit rules that every Forgewing workflow inherits.
- [Forgewing recovery activation](../runbooks/forgewing-recovery-activation.md)
  and [B4.6 value-reading benchmark](../runbooks/b46-value-reading-benchmark.md):
  how a specific workflow is qualified and activated.

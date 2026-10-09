# Forgewing

Status: canonical architecture principle. Recorded 2026-10-05, extended
2026-10-06. This note sets direction only. It is not an implementation
contract: the contracts for each phase live in their own specs, audits and
runbooks.

> **Broad intelligence, automatic investigation, narrow authority.**

## Definition

Forgewing is EightForge's cross-system operational intelligence layer. It
connects EightForge's evidence, nodes, decisions and workflows. It
investigates uncertainty automatically, helps move projects through
reconciliation and integrity, and turns recurring operational friction into
evidence for continuous system improvement.

It is not a feature, and not only value reading, recovery or a chat assistant.

| Layer | Role |
| --- | --- |
| EightForge Core | The operational truth graph: documents, extraction, canonical facts, contract and rate authority, Validator, reconciliation, relationships, reviews, workflow state, diagnostics. |
| Forgewing | Reasoning across that graph. |
| Improvement Orchestrator | Improving the graph and the system from real usage. |

## Standing rule

> Whenever EightForge knows that it does not know, knows that something is
> questionable, or deliberately refuses to publish something, Forgewing should
> automatically investigate it and present an evidence-backed option to the
> human operator.

Uncertainty events that create or enrich a ResolutionCase:

| Class | Meaning |
| --- | --- |
| Unresolved | EightForge could not determine something. |
| Withheld | EightForge found evidence but refused to publish it. |
| Questionable | EightForge produced something it knows requires review. |
| Conflict | Two authoritative-looking pieces of evidence disagree. |
| Missing | Expected evidence, a document or a relationship is absent. |
| Coverage failure | EightForge could not read the source sufficiently. |
| Validator failure | Canonical facts do not reconcile operationally. |
| Operator question | A human asks Forgewing to investigate. |

The operator should open an already-investigated case, not a raw failure
that needs a button press before anything is known.

## Two kinds of breadth

1. **Context breadth.** Forgewing gets the minimum evidence required to act,
   plus controlled, read-only access to the broader project graph needed to
   understand the problem. A wrong rate may come from OCR, a header, an
   attachment relationship, a contract version, a superseding amendment, a
   unit, an invoice association or a missing document, and a single crop
   cannot show which. EightForge resolves the relevant context for each
   investigation; it never sends a whole project indiscriminately. Context
   selection stays relevant, provenance-preserving, tenant-safe, policy-aware
   and budget-aware.
2. **Activation breadth.** Every class above activates Forgewing, not only an
   unresolved priced line.

## Authority

| Capability | Breadth |
| --- | --- |
| Read, understand, investigate, compare, diagnose, calculate impact, explain, prepare proposals | Broad, automatic |
| Write canonical truth or take an operational action | Narrow, typed, human-reviewed |

Automatic investigation is never automatic authority. Each case keeps its own
typed human action (value confirmation, continuation attribution, header or
structure correction, relationship confirmation, Validator resolution,
document linkage). Forgewing never receives a generic write path.

Automatic investigation still runs inside the existing gates: organization
entitlement, the data-policy ledger, the durable budget, and per-workflow
qualification and activation. A workflow that has not passed its own
pre-registered qualification bar does not run automatically.

## Principles

1. **EightForge remains deterministic-first.** The deterministic Core settles
   everything it can prove, and that boundary grows over time.
2. **Forgewing activates on every known uncertainty event** above, and when an
   operator asks.
3. **Forgewing may investigate, interpret, explain, compare and propose**,
   across all relevant project evidence and context.
4. **Forgewing never silently creates canonical truth.** What it produces is a
   proposal or explanation with its evidence, never an effective fact.
5. **Human-reviewed action remains the authority boundary.** Operational truth
   changes only through a human decision on an existing typed path.
   Forgewing does not modify code.
6. **Repeated Forgewing interventions are operational evidence.** Every time
   Forgewing is needed, the deterministic system could not handle something.
7. **That evidence feeds the Improvement Orchestrator**, which decides the
   long-term fix: configuration, a mapping, an integration, a deterministic
   rule, an extraction or Validator improvement, or broader product work.
8. **Engineering changes still go through the normal path:** implementation
   (Codex or Claude), tests, CI, a pull request and human approval.
9. **Goal:** Forgewing usage should progressively reduce recurring
   deterministic failure and operator friction. A pattern Forgewing keeps
   handling is a pattern EightForge should learn to handle itself.

## The loop

```
EightForge Core detects uncertainty
  (unresolved, withheld, questionable, conflict, missing,
   coverage failure, Validator failure, operator question)
  -> ResolutionCase
  -> Forgewing investigates automatically, with resolved project context
  -> evidence-backed proposal or explanation, with impact
  -> a human decides on the case's typed path    operational authority
  -> reviewed truth or action
  -> outcomes and recurring cases become evidence
  -> Improvement Orchestrator: root cause, change class, blast radius
  -> engineering change, tests, CI, PR            engineering authority
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

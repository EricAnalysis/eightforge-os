# Benchmark labels (human ground truth)

This directory holds **completed** human labels, one file per benchmark page,
named `<pageKey>.labels.json` (for example `golden-p8.labels.json`).

It is empty until a person labels a page. Nothing generates a file here: the
harness scores only against labels a human wrote, and reports
`labels_unavailable` for anything else.

## How a file gets here

1. Generate the workspace:
   `npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-workspace.ts -- --out .benchmark-workspace`
2. Label the page with `label-tool.html` in that workspace.
3. Copy that page's `labels.json` here as `<pageKey>.labels.json` and commit it.

### Delegated (dual-AI) truth

Labels finalized through the E3 delegated path (`authority:
delegated_dual_ai_evaluation_ground_truth_only`) must be committed together with
the two approval artifacts that authorized them:

```
<pageKey>.labels.json          # the finalizer's labels.json, byte-for-byte
<pageKey>.approvals/chatgpt.json
<pageKey>.approvals/claude.json
```

`benchmarkTrackedTruth.test.ts` fails if delegated truth is committed without
exactly these two approvals, if either decision is not `approve`, or if either
approval's `candidateSha256`, page, source or frame differs from the committed
labels. Human-approved labels need no approval files. This check proves the
committed files are consistent with each other; it does not authenticate who
wrote an approval.

Only the labels (and, for delegated truth, their approvals) are committed. The workspace itself — including the rendered
page images — is gitignored, because the corpus documents are client material
and deliberately live outside this repository.

## What binds

Every label file pins the source sha256, byte length, physical page number and
the page's canonical frame. The harness re-verifies all four before scoring, so
a label file can never drift onto different bytes or a different coordinate
frame.

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

Only the labels are committed. The workspace itself — including the rendered
page images — is gitignored, because the corpus documents are client material
and deliberately live outside this repository.

## What binds

Every label file pins the source sha256, byte length, physical page number and
the page's canonical frame. The harness re-verifies all four before scoring, so
a label file can never drift onto different bytes or a different coordinate
frame.

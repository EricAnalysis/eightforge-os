#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips this deployment, any other exit builds it.
# Skips only when nothing a deployment runs changed since the last successful
# deployment: documentation, tests and offline evaluation tooling. Comparing
# against that deployment (not just the newest commit's parent) means a push
# whose last commit is docs-only still builds when earlier commits changed code.
# No previous deployment, a commit missing from the clone, or any git error
# builds as before.
BASE="${VERCEL_GIT_PREVIOUS_SHA:-}"
[ -n "$BASE" ] || exit 1
git cat-file -e "${BASE}^{commit}" 2>/dev/null || exit 1
git diff --quiet "$BASE" HEAD -- . \
  ':(exclude,glob)docs/**' \
  ':(exclude,glob)**/*.md' \
  ':(exclude,glob)**/*.test.ts' \
  ':(exclude,glob)**/*.test.tsx' \
  ':(exclude,glob)scripts/evaluation/**' \
  ':(exclude,glob)lib/evaluation/benchmark/labels/**'

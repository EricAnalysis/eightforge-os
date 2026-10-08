#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips this deployment, any other exit builds it.
# Skips only when the commit changes nothing a deployment runs: documentation,
# tests and offline evaluation tooling. Anything else, or any git error (a
# shallow clone without the parent commit), builds as before.
git diff --quiet HEAD^ HEAD -- . \
  ':(exclude,glob)docs/**' \
  ':(exclude,glob)**/*.md' \
  ':(exclude,glob)**/*.test.ts' \
  ':(exclude,glob)**/*.test.tsx' \
  ':(exclude,glob)scripts/evaluation/**' \
  ':(exclude,glob)lib/evaluation/benchmark/labels/**'

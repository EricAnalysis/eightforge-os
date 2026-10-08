# Decision: keep deployed function storage small

Date: 2026-10-08. Trigger: Vercel reported the Hobby team at 100% of its
included Function Storage (10 GB).

## Cause

Every retained deployment stores the files each of its functions traces.
Measured on a local production build (`next build`, `.next/server/app/**/*.nft.json`,
counting only files a Vercel checkout contains):

- 119 routes traced **841 MB** per deployment; Vercel retained about 11
  deployments, consistent with the ~10 GB reported.
- The four extraction functions (`/api/documents/process`, `/api/documents/upload`,
  `/api/documents/[id]/evaluate`, `/api/jobs/process/[jobId]`) traced 89 MB
  each: both canvas native binaries (glibc 33 MB and musl 31 MB) and all four
  pdf.js builds bundled inside `pdf-parse`, of which only one is ever loaded.
- Nine evaluation workspace routes traced 261 MB of repository data
  (evaluation artifacts, fixtures, labels, migrations) through `process.cwd()`
  reads, although they serve only on localhost outside production.

## Decision

1. `next.config.ts` `outputFileTracingExcludes`:
   - all routes: the musl canvas binary (Vercel runs glibc; the loader picks
     the gnu binary) and the three unused `pdf-parse` pdf.js builds (extraction
     never sets `version`, so the default v1.10.100 is the only one loaded);
   - evaluation routes only: their repository data.
2. `vercel.json` `ignoreCommand` (`scripts/vercel/ignore-build.sh`): skip a
   deployment when a commit changes only documentation, tests or offline
   evaluation tooling. Any other change, or any git error, builds as before.

Result: **841 MB → 574 MB** traced per deployment (−32%), with fewer
deployments created. Every file dropped against a baseline build was checked
to fall under an intended exclusion; the extraction, OCR and value-reading
functions keep every file they load (tesseract language data, gnu canvas
binary, default pdf.js, pdfjs-dist).

## Guard rails

Next matches exclude patterns loosely: the `'*'` patterns are applied
unanchored while tracing every function, and scoped patterns can match inside
`node_modules`. A first attempt to exclude a stale root `eng.traineddata`
also removed the packaged `eng.traineddata.gz` from every OCR function.
`lib/architecture/nextConfigTracing.test.ts` therefore checks, with Next's own
matcher, that no pattern matches a required runtime file or any file of the
Next.js server runtime, and that scoped patterns apply only to evaluation routes.

## Not done here

- Upgrading the plan (user decision).
- Removing the evaluation workspaces from production builds entirely (their
  remaining ~19 MB each is compiled code and traced sources).

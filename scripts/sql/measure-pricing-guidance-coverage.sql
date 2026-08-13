-- Phase 3A rollout measurement: pricing-source topology and operator guidance coverage.
--
-- WHY THIS EXISTS
-- Phase 3A makes operator rate-page guidance a precondition for canonical pricing
-- on captured paginated sources: without a resolvable operator range the scope is
-- `no_scope`/`provisional`, every observation is diagnostic-only, and the document
-- contributes zero canonical rate rows. That is the intended authority doctrine,
-- not a defect — but its blast radius on reprocess is a function of how many live
-- pricing documents actually carry guidance. Measure before deciding rollout.
--
-- DO NOT use a low coverage number as grounds to reintroduce whole-document
-- fallback. Low coverage is an argument about sequencing and operator workflow,
-- not about weakening the scope rule.
--
-- READ-ONLY. No writes, no DDL. Safe to run against production.
--
-- NOTE ON PRE-EXISTING ROWS
-- `capture_state` is introduced by this change and no historical row carries it.
-- For rows written before it, the container's PRESENCE is the only signal, and it
-- is ambiguous exactly where this measurement matters: a missing container means
-- either a genuinely pre-provenance extraction or a modern non-paginated source.
-- Bucket 5 below isolates that ambiguity by file type — its size is the input to
-- the "do we need a backfill marker?" decision.

WITH pricing_documents AS (
  SELECT
    d.id,
    d.organization_id,
    d.name,
    COALESCE(d.document_type, '') AS document_type,
    LOWER(COALESCE(NULLIF(SPLIT_PART(d.name, '.', -1), d.name), '')) AS file_ext
  FROM public.documents d
  WHERE LOWER(COALESCE(d.document_type, '')) IN ('contract', 'price_sheet', 'price sheet')
),
extraction_blob AS (
  -- Mirrors loadLegacyExtractionRows + pickPreferredExtractionBlob: the
  -- whole-document blob rows (field_key IS NULL), newest first, preferring the
  -- first row that actually carries extraction data.
  SELECT DISTINCT ON (de.document_id)
    de.document_id,
    de.data #> '{extraction,physical_page_provenance_v1}' AS provenance_container
  FROM public.document_extractions de
  WHERE de.field_key IS NULL
  ORDER BY
    de.document_id,
    (de.data #> '{extraction}') IS NOT NULL DESC,
    de.created_at DESC
),
guidance AS (
  SELECT
    g.document_id,
    COALESCE(jsonb_array_length(
      CASE WHEN jsonb_typeof(g.rate_schedule_page_ranges) = 'array'
        THEN g.rate_schedule_page_ranges ELSE '[]'::jsonb END
    ), 0) AS range_count
  FROM public.contract_upload_guidance g
),
classified AS (
  SELECT
    p.id,
    p.file_ext,
    COALESCE(gu.range_count, 0) > 0 AS has_guidance,
    eb.provenance_container,
    CASE
      WHEN eb.provenance_container IS NULL THEN
        CASE WHEN p.file_ext IN ('pdf') THEN 'absent_container_paginated'
             WHEN p.file_ext IN ('xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt', 'md')
               THEN 'absent_container_non_paginated'
             ELSE 'absent_container_unknown_topology' END
      WHEN eb.provenance_container ->> 'capture_state' IS NOT NULL
        THEN 'declared_' || (eb.provenance_container ->> 'capture_state')
      -- Pre-declaration container: written only by the paginated PDF path.
      ELSE 'undeclared_container_paginated'
    END AS topology_bucket
  FROM pricing_documents p
  LEFT JOIN extraction_blob eb ON eb.document_id = p.id
  LEFT JOIN guidance gu ON gu.document_id = p.id
)
SELECT
  topology_bucket,
  COUNT(*)                                          AS documents,
  COUNT(*) FILTER (WHERE has_guidance)              AS with_operator_guidance,
  COUNT(*) FILTER (WHERE NOT has_guidance)          AS without_operator_guidance,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE has_guidance) / NULLIF(COUNT(*), 0),
    1
  )                                                 AS guidance_coverage_pct
FROM classified
GROUP BY topology_bucket
ORDER BY documents DESC;

-- ── Interpretation ───────────────────────────────────────────────────────────
-- The five numbers requested map to buckets above:
--
--   modern provenance-aware pricing documents
--     = declared_captured + undeclared_container_paginated
--   modern docs WITH non-empty operator guidance
--     = the `with_operator_guidance` column of those buckets
--   modern docs WITHOUT guidance
--     = the `without_operator_guidance` column of those buckets
--       ⚠️  THIS IS THE BLACKOUT SET. On reprocess these yield zero canonical
--           rate rows under Phase 3A.
--   historical / pre-provenance pricing documents
--     = declared_legacy_pre_provenance  (expected to be ZERO today: no writer
--       emits it and no durable marker exists — see the backfill question below)
--   non-paginated pricing documents
--     = declared_not_applicable_non_paginated + absent_container_non_paginated
--
-- BACKFILL DECISION INPUT
-- `absent_container_paginated` is the ambiguous set: paginated sources with no
-- container at all. These are the only documents for which a durable
-- pre-provenance marker would be needed, since nothing else can distinguish
-- "extracted before provenance capture" from "capture never ran". If this bucket
-- is non-empty, a backfill marker is required before `legacy_pre_provenance` can
-- ever be asserted truthfully. If it is empty, the state can stay unreachable.

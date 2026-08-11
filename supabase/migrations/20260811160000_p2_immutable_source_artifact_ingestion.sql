-- P2 immutable source-artifact identity at ingestion.
--
-- Legacy extraction artifacts remain valid. New upload-time records additionally
-- retain the immutable storage coordinates and the computation origin. Writes
-- remain service-role RPC-only and every row remains append-only under the
-- existing extraction_source_artifacts trigger.

ALTER TABLE public.extraction_source_artifacts
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS identity_origin text;

ALTER TABLE public.extraction_source_artifacts
  ADD CONSTRAINT extraction_source_artifacts_storage_bucket_check
    CHECK (storage_bucket IS NULL OR btrim(storage_bucket) <> ''),
  ADD CONSTRAINT extraction_source_artifacts_storage_path_check
    CHECK (storage_path IS NULL OR btrim(storage_path) <> ''),
  ADD CONSTRAINT extraction_source_artifacts_identity_origin_check
    CHECK (
      identity_origin IS NULL
      OR identity_origin IN ('upload', 'processing', 'backfill')
    );

-- A document/storage version is one immutable byte object. The prior unique
-- constraint included source_sha256 and therefore allowed the same version to
-- acquire two hashes. Fail migration replay/deployment rather than silently
-- accepting any pre-existing contradiction.
DO $$
DECLARE
  conflict_count bigint;
  representative_organization_id uuid;
  representative_source_document_id uuid;
  representative_storage_object_version text;
BEGIN
  WITH conflicts AS (
    SELECT
      artifact.organization_id,
      artifact.source_document_id,
      artifact.storage_object_version
    FROM public.extraction_source_artifacts artifact
    GROUP BY
      artifact.organization_id,
      artifact.source_document_id,
      artifact.storage_object_version
    HAVING count(*) > 1
  )
  SELECT count(*)
  INTO conflict_count
  FROM conflicts;

  IF conflict_count > 0 THEN
    SELECT
      artifact.organization_id,
      artifact.source_document_id,
      artifact.storage_object_version
    INTO
      representative_organization_id,
      representative_source_document_id,
      representative_storage_object_version
    FROM public.extraction_source_artifacts artifact
    GROUP BY
      artifact.organization_id,
      artifact.source_document_id,
      artifact.storage_object_version
    HAVING count(*) > 1
    ORDER BY
      artifact.organization_id,
      artifact.source_document_id,
      artifact.storage_object_version
    LIMIT 1;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'immutable source artifact version conflicts require review before P2 migration: conflict_count=%s, organization_id=%s, source_document_id=%s, storage_object_version=%s',
        conflict_count,
        representative_organization_id,
        representative_source_document_id,
        representative_storage_object_version
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_extraction_source_artifacts_document_version
  ON public.extraction_source_artifacts (
    organization_id,
    source_document_id,
    storage_object_version
  );

CREATE OR REPLACE FUNCTION public.record_extraction_source_artifact_identity(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  org_id uuid := (payload->>'organization_id')::uuid;
  document_id uuid := (payload->>'source_document_id')::uuid;
  source_sha text := lower(btrim(payload->>'source_sha256'));
  object_version text := btrim(payload->>'storage_object_version');
  object_bucket text := btrim(payload->>'storage_bucket');
  object_path text := btrim(payload->>'storage_path');
  media_type text := btrim(payload->>'media_type_sniffed');
  byte_count bigint := (payload->>'byte_length')::bigint;
  origin text := btrim(payload->>'identity_origin');
  source_row public.extraction_source_artifacts%ROWTYPE;
  outcome text := 'newly_populated';
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF source_sha IS NULL OR source_sha !~ '^[0-9a-f]{64}$'
    OR object_version IS NULL OR object_version = ''
    OR object_bucket IS NULL OR object_bucket = ''
    OR object_path IS NULL OR object_path = ''
    OR media_type IS NULL OR media_type = ''
    OR byte_count IS NULL OR byte_count < 0
    OR origin IS NULL OR origin NOT IN ('upload', 'processing', 'backfill') THEN
    RAISE EXCEPTION 'invalid source artifact identity payload' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.documents document
    WHERE document.id = document_id
      AND document.organization_id = org_id
  ) THEN
    RAISE EXCEPTION 'source document must belong to the payload organization'
      USING ERRCODE = '23514';
  END IF;

  -- Hash is deliberately excluded: contradictory hashes for one immutable
  -- version must serialize against each other and be compared below.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    org_id::text || ':' || document_id::text || ':' || object_version,
    0
  ));

  SELECT * INTO source_row
  FROM public.extraction_source_artifacts artifact
  WHERE artifact.organization_id = org_id
    AND artifact.source_document_id = document_id
    AND artifact.storage_object_version = object_version
  ORDER BY artifact.created_at ASC, artifact.id ASC
  LIMIT 1;

  IF source_row.id IS NOT NULL THEN
    IF source_row.source_sha256 <> source_sha
      OR source_row.byte_length <> byte_count
      OR source_row.media_type_sniffed <> media_type
      OR (
        source_row.storage_bucket IS NOT NULL
        AND source_row.storage_bucket <> object_bucket
      )
      OR (
        source_row.storage_path IS NOT NULL
        AND source_row.storage_path <> object_path
      ) THEN
      RAISE EXCEPTION 'immutable source artifact identity conflict'
        USING ERRCODE = '23514';
    END IF;
    outcome := 'already_populated';
  ELSE
    INSERT INTO public.extraction_source_artifacts (
      organization_id,
      source_document_id,
      source_sha256,
      storage_object_version,
      storage_bucket,
      storage_path,
      media_type_sniffed,
      byte_length,
      identity_origin
    ) VALUES (
      org_id,
      document_id,
      source_sha,
      object_version,
      object_bucket,
      object_path,
      media_type,
      byte_count,
      origin
    )
    RETURNING * INTO source_row;
  END IF;

  RETURN jsonb_build_object(
    'source_artifact_id', source_row.id,
    'organization_id', source_row.organization_id,
    'source_document_id', source_row.source_document_id,
    'source_sha256', source_row.source_sha256,
    'storage_object_version', source_row.storage_object_version,
    'storage_bucket', source_row.storage_bucket,
    'storage_path', source_row.storage_path,
    'media_type_sniffed', source_row.media_type_sniffed,
    'byte_length', source_row.byte_length,
    'identity_origin', source_row.identity_origin,
    'created_at', source_row.created_at,
    'outcome', outcome
  );
END;
$$;

ALTER FUNCTION public.record_extraction_source_artifact_identity(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_extraction_source_artifact_identity(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_extraction_source_artifact_identity(jsonb)
  TO service_role;

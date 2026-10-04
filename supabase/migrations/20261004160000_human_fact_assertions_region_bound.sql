-- Forgewing resolution layer B3: region-bound human-reviewed values.
--
-- Reuses public.human_fact_assertions, the existing append-only reviewed-value
-- ledger. It does not create a second ledger. An operator may now assert a
-- value bound to an exact source region (document, artifact, physical page,
-- boxes, observation ids) pinned to the page representation digest the
-- operator reviewed. No machine fact is required, so this covers values
-- deterministic extraction never produced or could not prove.
--
-- Authority. A row here is HUMAN_REVIEWED, always. AI proposals are never
-- stored here: a Forgewing proposal stays in its own non-authoritative table,
-- and an assertion may only reference one. Until that table exists (B4),
-- the record function accepts only review_origin = 'operator_entered'.
--
-- History. The table stays append-only (trg_human_fact_assertions_append_only).
-- A correction or withdrawal inserts a new row that supersedes the current
-- head of the same (document, fact_key, anchor_key) chain. Nothing is
-- updated or deleted. The effective assertion is the single chain head whose
-- digest still matches the current page; anything else fails closed in the
-- application resolver.
--
-- Forward-only and additive. New columns are nullable, so existing rows
-- are untouched. Two CHECK constraints are replaced by strict supersets of
-- themselves, so every existing row still satisfies them.

ALTER TABLE public.human_fact_assertions
  ADD COLUMN source_artifact_id uuid,
  ADD COLUMN physical_page_number integer
    CONSTRAINT human_fact_assertions_physical_page_check CHECK (physical_page_number > 0),
  ADD COLUMN source_region jsonb,
  ADD COLUMN page_representation_digest text
    CONSTRAINT human_fact_assertions_page_digest_check
    CHECK (page_representation_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN parser_version text,
  ADD COLUMN source_observation_ids text[],
  ADD COLUMN original_source_text text,
  ADD COLUMN anchor_key text
    CONSTRAINT human_fact_assertions_anchor_key_check CHECK (btrim(anchor_key) <> ''),
  ADD COLUMN review_origin text
    CONSTRAINT human_fact_assertions_review_origin_check
    CHECK (review_origin IN (
      'operator_entered', 'ai_proposed_operator_approved', 'ai_proposed_operator_modified')),
  ADD COLUMN forgewing_proposal_id text,
  ADD COLUMN request_digest_sha256 text
    CONSTRAINT human_fact_assertions_request_digest_check
    CHECK (request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT human_fact_assertions_request_digest_unique UNIQUE (request_digest_sha256);

ALTER TABLE public.human_fact_assertions
  DROP CONSTRAINT human_fact_assertions_binding_check,
  ADD CONSTRAINT human_fact_assertions_binding_check
    CHECK (source_binding IN ('source_bound', 'domain_assertion', 'region_bound'));

ALTER TABLE public.human_fact_assertions
  DROP CONSTRAINT human_fact_assertions_source_target_check,
  ADD CONSTRAINT human_fact_assertions_source_target_check CHECK (
    source_binding IN ('domain_assertion', 'region_bound')
    OR num_nonnulls(target_machine_fact_id, target_verified_field_id) >= 1
  );

-- 'withdrawn' lets an operator retract a reviewed value by appending a row,
-- never by mutating or deleting one.
ALTER TABLE public.human_fact_assertions
  DROP CONSTRAINT human_fact_assertions_status_check,
  ADD CONSTRAINT human_fact_assertions_status_check
    CHECK (status IN ('active', 'superseded', 'needs_review', 'withdrawn'));

-- A region-bound row carries a complete anchor and a request identity. A
-- withdrawal carries no value and always supersedes something. Rows of the
-- older bindings carry no region columns at all.
ALTER TABLE public.human_fact_assertions
  ADD CONSTRAINT human_fact_assertions_region_anchor_check CHECK (
    CASE WHEN source_binding = 'region_bound' THEN
      source_document_id IS NOT NULL
      AND physical_page_number IS NOT NULL
      AND page_representation_digest IS NOT NULL
      AND jsonb_typeof(source_region) = 'object'
      AND jsonb_typeof(source_region -> 'boxes') = 'array'
      AND jsonb_array_length(source_region -> 'boxes') > 0
      AND anchor_key IS NOT NULL
      AND review_origin IS NOT NULL
      AND request_digest_sha256 IS NOT NULL
      AND status IN ('active', 'withdrawn')
      AND (status = 'withdrawn') = (asserted_value IS NULL)
      AND (status <> 'withdrawn' OR supersedes_assertion_id IS NOT NULL)
      AND (review_origin = 'operator_entered') = (forgewing_proposal_id IS NULL)
    ELSE
      num_nonnulls(source_artifact_id, physical_page_number, source_region,
        page_representation_digest, parser_version, source_observation_ids,
        original_source_text, anchor_key, review_origin, forgewing_proposal_id,
        request_digest_sha256) = 0
      AND status <> 'withdrawn'
    END
  );

CREATE INDEX idx_human_fact_assertions_region_chain
  ON public.human_fact_assertions (organization_id, source_document_id, fact_key, anchor_key)
  WHERE source_binding = 'region_bound';

CREATE INDEX idx_human_fact_assertions_supersedes
  ON public.human_fact_assertions (organization_id, supersedes_assertion_id)
  WHERE supersedes_assertion_id IS NOT NULL;

CREATE FUNCTION public.record_region_bound_human_fact_assertion(
  p_organization_id uuid,
  p_actor_id uuid,
  p_source_document_id uuid,
  p_fact_key text,
  p_asserted_value jsonb,
  p_status text,
  p_reason text,
  p_source_artifact_id uuid,
  p_physical_page_number integer,
  p_source_region jsonb,
  p_page_representation_digest text,
  p_parser_version text,
  p_source_observation_ids text[],
  p_original_source_text text,
  p_anchor_key text,
  p_review_origin text,
  p_forgewing_proposal_id text,
  p_supersedes_assertion_id uuid,
  p_request_digest_sha256 text
) RETURNS TABLE(assertion_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing record;
  v_head_count integer;
  v_head_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_request_digest_sha256 IS NULL OR p_request_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_page_representation_digest IS NULL OR p_page_representation_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid region assertion identity' USING ERRCODE = '22023';
  END IF;
  IF p_fact_key IS NULL OR btrim(p_fact_key) = '' OR p_anchor_key IS NULL OR btrim(p_anchor_key) = ''
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'region assertion requires fact key, anchor and reason' USING ERRCODE = '22023';
  END IF;
  -- Proposal is not truth. Until Forgewing value proposals exist as their own
  -- non-authoritative records (B4), nothing here may claim AI provenance.
  IF p_review_origin IS DISTINCT FROM 'operator_entered' OR p_forgewing_proposal_id IS NOT NULL THEN
    RAISE EXCEPTION 'only operator_entered region assertions are accepted' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('active', 'withdrawn')
     OR (p_status = 'withdrawn') <> (p_asserted_value IS NULL)
     OR (p_status = 'withdrawn' AND p_supersedes_assertion_id IS NULL) THEN
    RAISE EXCEPTION 'region assertion status incoherent' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || '|' || p_source_document_id::text || '|' || p_fact_key || '|' || p_anchor_key, 0));

  SELECT * INTO v_existing FROM public.human_fact_assertions
    WHERE request_digest_sha256 = p_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id <> p_organization_id
       OR v_existing.actor_id <> p_actor_id
       OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_existing.fact_key <> p_fact_key
       OR v_existing.anchor_key IS DISTINCT FROM p_anchor_key
       OR v_existing.asserted_value IS DISTINCT FROM p_asserted_value
       OR v_existing.status <> p_status
       OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
       OR v_existing.supersedes_assertion_id IS DISTINCT FROM p_supersedes_assertion_id THEN
      RAISE EXCEPTION 'region assertion request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.documents
                 WHERE id = p_source_document_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'document outside actor organization' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE id = p_actor_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'actor not found in organization' USING ERRCODE = '42501';
  END IF;

  -- One linear chain per (document, fact_key, anchor_key). A new row must
  -- supersede exactly the current head, so two competing active values are
  -- never created through this function.
  SELECT count(*), min(h.id::text)::uuid INTO v_head_count, v_head_id
    FROM public.human_fact_assertions h
    WHERE h.organization_id = p_organization_id
      AND h.source_binding = 'region_bound'
      AND h.source_document_id = p_source_document_id
      AND h.fact_key = p_fact_key
      AND h.anchor_key = p_anchor_key
      AND NOT EXISTS (
        SELECT 1 FROM public.human_fact_assertions s
        WHERE s.organization_id = h.organization_id AND s.supersedes_assertion_id = h.id);
  IF v_head_count > 1 THEN
    RAISE EXCEPTION 'region assertion chain is ambiguous' USING ERRCODE = '23505';
  END IF;
  IF p_supersedes_assertion_id IS DISTINCT FROM (CASE WHEN v_head_count = 1 THEN v_head_id END) THEN
    RAISE EXCEPTION 'region assertion must supersede the current chain head' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.human_fact_assertions(
    organization_id, source_document_id, fact_key, asserted_value, source_binding,
    supersedes_assertion_id, actor_id, reason, status,
    source_artifact_id, physical_page_number, source_region, page_representation_digest,
    parser_version, source_observation_ids, original_source_text, anchor_key,
    review_origin, forgewing_proposal_id, request_digest_sha256)
  VALUES (
    p_organization_id, p_source_document_id, p_fact_key, p_asserted_value, 'region_bound',
    p_supersedes_assertion_id, p_actor_id, btrim(p_reason), p_status,
    p_source_artifact_id, p_physical_page_number, p_source_region, p_page_representation_digest,
    p_parser_version, p_source_observation_ids, p_original_source_text, p_anchor_key,
    p_review_origin, p_forgewing_proposal_id, p_request_digest_sha256)
  RETURNING id INTO assertion_id;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_region_bound_human_fact_assertion(
  uuid, uuid, uuid, text, jsonb, text, text, uuid, integer, jsonb, text, text, text[], text, text,
  text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_region_bound_human_fact_assertion(
  uuid, uuid, uuid, text, jsonb, text, text, uuid, integer, jsonb, text, text, text[], text, text,
  text, text, uuid, text) TO service_role;

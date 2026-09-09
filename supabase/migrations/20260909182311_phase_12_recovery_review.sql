-- Phase 12B: immutable human review of a Forgewing recovery proposal.
--
-- The human is the only authority that can authorize a deterministic
-- reconstruction re-entry. This table is that authorization, append-only and
-- pinned to an exact proposal digest. There is no latest-wins row and no
-- mutable disposition: changing one's mind appends a new review version, and
-- the confirmation resolver refuses to guess between them.
--
-- A review never authors a value. `confirmed_observation_id` must be an
-- eligible observation the proposal itself cited, and `confirmed_raw_text` is
-- read out of the proposal's own evidence inside this function -- never taken
-- from the caller. "Modified" therefore means selecting a different already-
-- observed token, which is the only recovery Forgewing V1 can represent.

CREATE TABLE public.forgewing_recovery_proposal_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  proposal_row_id uuid NOT NULL REFERENCES public.forgewing_recovery_proposals(id) ON DELETE RESTRICT,
  proposal_digest_sha256 text NOT NULL CHECK (proposal_digest_sha256 ~ '^[0-9a-f]{64}$'),
  review_version integer NOT NULL CHECK (review_version > 0),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK (disposition IN ('accepted','modified','rejected','deferred')),
  confirmed_observation_id text,
  confirmed_raw_text text,
  reviewer_rationale text NOT NULL CHECK (length(btrim(reviewer_rationale)) BETWEEN 1 AND 4000),
  review_request_digest_sha256 text NOT NULL UNIQUE CHECK (review_request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (proposal_row_id, review_version),
  -- Only an approving disposition confirms an observation, and it always
  -- confirms exactly one with its authored text alongside it.
  CONSTRAINT forgewing_recovery_reviews_confirmation_coherent
    CHECK ((disposition IN ('accepted','modified')) = (confirmed_observation_id IS NOT NULL)
       AND (confirmed_observation_id IS NOT NULL) = (confirmed_raw_text IS NOT NULL))
);

CREATE INDEX forgewing_recovery_proposal_reviews_proposal_idx
  ON public.forgewing_recovery_proposal_reviews (proposal_row_id, review_version);

ALTER TABLE public.forgewing_recovery_proposal_reviews ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER forgewing_recovery_proposal_reviews_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_recovery_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_recovery_mutation();

REVOKE ALL ON TABLE public.forgewing_recovery_proposal_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forgewing_recovery_proposal_reviews TO service_role;

CREATE FUNCTION public.record_forgewing_recovery_proposal_review(
  p_organization_id uuid, p_proposal_id text, p_proposal_digest_sha256 text,
  p_reviewer_actor_id uuid, p_disposition text, p_confirmed_observation_id text,
  p_reviewer_rationale text, p_review_request_digest_sha256 text
) RETURNS TABLE(
  review_id uuid, review_version integer, proposal_row_id uuid,
  confirmed_observation_id text, confirmed_raw_text text, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_proposal record;
  v_existing record;
  v_version integer;
  v_confirmed_text text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_review_request_digest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid recovery review identity' USING ERRCODE = '22023';
  END IF;
  IF p_disposition NOT IN ('accepted','modified','rejected','deferred')
     OR ((p_disposition IN ('accepted','modified')) <> (p_confirmed_observation_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'review disposition incoherent' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_proposal_digest_sha256, 0));

  SELECT * INTO v_existing FROM public.forgewing_recovery_proposal_reviews
    WHERE review_request_digest_sha256 = p_review_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.proposal_digest_sha256 <> p_proposal_digest_sha256
       OR v_existing.reviewer_actor_id <> p_reviewer_actor_id
       OR v_existing.disposition <> p_disposition
       OR v_existing.confirmed_observation_id IS DISTINCT FROM p_confirmed_observation_id
       OR v_existing.reviewer_rationale <> btrim(p_reviewer_rationale) THEN
      RAISE EXCEPTION 'review request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.review_version, v_existing.proposal_row_id,
      v_existing.confirmed_observation_id, v_existing.confirmed_raw_text, false;
    RETURN;
  END IF;

  -- Exact pin. A review of "whatever the newest proposal is" is not a review.
  SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
    WHERE proposal_id = p_proposal_id AND proposal_digest_sha256 = p_proposal_digest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact recovery proposal not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_proposal.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'recovery proposal outside reviewer organization' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE id = p_reviewer_actor_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'reviewer not found in organization' USING ERRCODE = '42501';
  END IF;

  IF p_confirmed_observation_id IS NOT NULL THEN
    -- The confirmed value is read out of the proposal's own evidence. A human
    -- selects among observations; nothing here lets one be authored.
    SELECT e->>'rawText' INTO v_confirmed_text
      FROM jsonb_array_elements(v_proposal.evidence) e
      WHERE e->>'observationId' = p_confirmed_observation_id
        AND (e->>'eligible')::boolean;
    IF v_confirmed_text IS NULL THEN
      RAISE EXCEPTION 'confirmed observation is not eligible proposal evidence' USING ERRCODE = '22023';
    END IF;
    IF p_disposition = 'accepted' AND p_confirmed_observation_id <> v_proposal.selected_observation_id THEN
      RAISE EXCEPTION 'accepted review must confirm the proposed observation' USING ERRCODE = '22023';
    END IF;
    IF p_disposition = 'modified' AND p_confirmed_observation_id = v_proposal.selected_observation_id THEN
      RAISE EXCEPTION 'modified review must confirm a different observation' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT coalesce(max(r.review_version), 0) + 1 INTO v_version
    FROM public.forgewing_recovery_proposal_reviews r
    WHERE r.proposal_row_id = v_proposal.id;

  INSERT INTO public.forgewing_recovery_proposal_reviews(
    organization_id, proposal_row_id, proposal_digest_sha256, review_version,
    reviewer_actor_id, disposition, confirmed_observation_id, confirmed_raw_text,
    reviewer_rationale, review_request_digest_sha256)
  VALUES (
    p_organization_id, v_proposal.id, p_proposal_digest_sha256, v_version,
    p_reviewer_actor_id, p_disposition, p_confirmed_observation_id, v_confirmed_text,
    btrim(p_reviewer_rationale), p_review_request_digest_sha256)
  RETURNING id INTO review_id;
  review_version := v_version;
  proposal_row_id := v_proposal.id;
  confirmed_observation_id := p_confirmed_observation_id;
  confirmed_raw_text := v_confirmed_text;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_recovery_proposal_review(
  uuid,text,text,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_recovery_proposal_review(
  uuid,text,text,uuid,text,text,text,text) TO service_role;

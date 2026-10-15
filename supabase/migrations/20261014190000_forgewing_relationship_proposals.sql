-- Forgewing P3.2 V1: immutable document-relationship proposals (`amends` only).
--
-- A proposal says "document X amends document Y", with the evidence that
-- suggests it. It is never a relationship: nothing here writes
-- document_relationships, documents, precedence or Validator state, and no
-- truth path reads these tables. The ONLY way a proposed link becomes
-- effective is the existing human route (document-precedence
-- `link_relationship`), which creates the document_relationships row as the
-- operator; the review row below then records that the operator confirmed
-- this proposal, binding it to the relationship row the operator created
-- (D0 provenance: suggestion -> human decision -> effective relationship).
--
-- Both tables are append-only, immutable (trigger), RLS-enabled with no
-- policies, readable by service_role only, and writable only through the two
-- SECURITY DEFINER record functions, which pin organization, project,
-- documents and actor inside the database. Nothing is deleted; there is no
-- retention expiry (proposal history is audit evidence).

CREATE TABLE public.forgewing_relationship_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  target_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  -- V1 vocabulary: amends only. Widening is a reviewed migration.
  relationship_type text NOT NULL CHECK (relationship_type = 'amends'),
  proposal_kind text NOT NULL CHECK (proposal_kind = 'referenced_amendment_link'),
  -- Who proposed: the deterministic B7 candidate rule, or (later, once
  -- qualified) a model. A model proposal must name its model and prompt.
  proposer text NOT NULL CHECK (proposer IN ('deterministic_b7_candidate', 'forgewing_model')),
  model text CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 200),
  prompt_version text CHECK (prompt_version IS NULL OR length(btrim(prompt_version)) BETWEEN 1 AND 100),
  -- The Validator finding the proposal answers, when there is one.
  anchor_check_key text CHECK (anchor_check_key IS NULL OR length(anchor_check_key) BETWEEN 1 AND 500),
  amendment_number integer CHECK (amendment_number IS NULL OR amendment_number BETWEEN 1 AND 999),
  -- [{documentId, page, matchedText}], 1..10 entries: the cited source text.
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 10),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 1000),
  -- The precedence snapshot the proposal was computed against.
  precedence_snapshot_digest text NOT NULL CHECK (precedence_snapshot_digest ~ '^[0-9a-f]{64}$'),
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[0-9a-f]{64}$'),
  authority text NOT NULL DEFAULT 'non_authoritative' CHECK (authority = 'non_authoritative'),
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review),
  requested_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forgewing_relationship_proposals_distinct_documents CHECK (source_document_id <> target_document_id),
  CONSTRAINT forgewing_relationship_proposals_model_identity CHECK (
    (proposer = 'forgewing_model') = (model IS NOT NULL AND prompt_version IS NOT NULL)),
  CONSTRAINT forgewing_relationship_proposals_org_digest_unique UNIQUE (organization_id, proposal_digest)
);

CREATE INDEX forgewing_relationship_proposals_project_idx
  ON public.forgewing_relationship_proposals (organization_id, project_id, created_at DESC);

CREATE TABLE public.forgewing_relationship_proposal_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL REFERENCES public.forgewing_relationship_proposals(id) ON DELETE RESTRICT,
  -- accepted: the operator created the proposed link through link_relationship.
  -- already_linked: the operator confirmed it, and the same link already existed.
  -- rejected / deferred: no relationship written.
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'already_linked', 'rejected', 'deferred')),
  -- The document_relationships row the confirmation rests on (no FK: the
  -- production table carries no FKs; the record function verifies it).
  relationship_id uuid,
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  review_request_digest text NOT NULL CHECK (review_request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forgewing_relationship_proposal_reviews_relationship_shape CHECK (
    (disposition IN ('accepted', 'already_linked')) = (relationship_id IS NOT NULL)),
  CONSTRAINT forgewing_relationship_proposal_reviews_rejection_reason CHECK (
    disposition <> 'rejected' OR reason IS NOT NULL),
  CONSTRAINT forgewing_relationship_proposal_reviews_request_unique UNIQUE (organization_id, review_request_digest)
);

-- One decision per proposal: the first review is final (append-only history,
-- no latest-wins). Deferral is the only non-final disposition.
CREATE UNIQUE INDEX forgewing_relationship_proposal_reviews_one_final
  ON public.forgewing_relationship_proposal_reviews (proposal_id)
  WHERE disposition <> 'deferred';

CREATE FUNCTION public.reject_forgewing_relationship_proposal_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Forgewing relationship proposals and reviews are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER forgewing_relationship_proposals_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_relationship_proposals
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_relationship_proposal_mutation();
CREATE TRIGGER forgewing_relationship_proposal_reviews_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_relationship_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_relationship_proposal_mutation();

ALTER TABLE public.forgewing_relationship_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forgewing_relationship_proposal_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.forgewing_relationship_proposals FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.forgewing_relationship_proposal_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forgewing_relationship_proposals TO service_role;
GRANT SELECT ON TABLE public.forgewing_relationship_proposal_reviews TO service_role;
REVOKE ALL ON FUNCTION public.reject_forgewing_relationship_proposal_mutation() FROM PUBLIC, anon, authenticated, service_role;

-- Record a proposal. Pins both documents to the organization's project and the
-- requester to the organization. Idempotent on (organization, proposal digest).
CREATE FUNCTION public.record_forgewing_relationship_proposal(
  p_organization_id uuid,
  p_project_id uuid,
  p_source_document_id uuid,
  p_target_document_id uuid,
  p_relationship_type text,
  p_proposal_kind text,
  p_proposer text,
  p_model text,
  p_prompt_version text,
  p_anchor_check_key text,
  p_amendment_number integer,
  p_evidence jsonb,
  p_rationale text,
  p_precedence_snapshot_digest text,
  p_proposal_digest text,
  p_requested_by uuid
) RETURNS TABLE (proposal_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'project not in organization' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM public.documents
      WHERE id IN (p_source_document_id, p_target_document_id)
        AND project_id = p_project_id AND organization_id = p_organization_id) <> 2 THEN
    RAISE EXCEPTION 'proposal documents must belong to the project' USING ERRCODE = '23514';
  END IF;
  IF p_requested_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.user_profiles WHERE id = p_requested_by AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'requester not in organization' USING ERRCODE = '23514';
  END IF;

  SELECT p.id INTO v_id FROM public.forgewing_relationship_proposals AS p
  WHERE p.organization_id = p_organization_id AND p.proposal_digest = p_proposal_digest;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  INSERT INTO public.forgewing_relationship_proposals (
    organization_id, project_id, source_document_id, target_document_id, relationship_type, proposal_kind,
    proposer, model, prompt_version, anchor_check_key, amendment_number, evidence, rationale,
    precedence_snapshot_digest, proposal_digest, requested_by)
  VALUES (
    p_organization_id, p_project_id, p_source_document_id, p_target_document_id, p_relationship_type, p_proposal_kind,
    p_proposer, p_model, p_prompt_version, p_anchor_check_key, p_amendment_number, p_evidence, p_rationale,
    p_precedence_snapshot_digest, p_proposal_digest, p_requested_by)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END $$;

-- Record the operator's decision on a proposal. An accepted / already_linked
-- review must cite a document_relationships row that matches the proposal
-- exactly (organization, project, source, target, canonical type); an accepted
-- one must have been created by this reviewer, i.e. through the human route.
CREATE FUNCTION public.record_forgewing_relationship_proposal_review(
  p_organization_id uuid,
  p_proposal_id uuid,
  p_disposition text,
  p_relationship_id uuid,
  p_reason text,
  p_reviewer_actor_id uuid,
  p_review_request_digest text
) RETURNS TABLE (review_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_proposal public.forgewing_relationship_proposals%ROWTYPE;
  v_relationship record;
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  SELECT r.id INTO v_id FROM public.forgewing_relationship_proposal_reviews AS r
  WHERE r.organization_id = p_organization_id AND r.review_request_digest = p_review_request_digest;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  SELECT * INTO v_proposal FROM public.forgewing_relationship_proposals
  WHERE id = p_proposal_id AND organization_id = p_organization_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal not found in organization' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles
      WHERE id = p_reviewer_actor_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'reviewer not in organization' USING ERRCODE = '23514';
  END IF;

  IF p_disposition IN ('accepted', 'already_linked') THEN
    SELECT * INTO v_relationship FROM public.document_relationships
    WHERE id = p_relationship_id
      AND project_id = v_proposal.project_id
      AND source_document_id = v_proposal.source_document_id
      AND target_document_id = v_proposal.target_document_id
      AND relationship_type = v_proposal.relationship_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirmation does not cite the proposed relationship' USING ERRCODE = '23514';
    END IF;
    IF v_relationship.organization_id IS NOT NULL AND v_relationship.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'relationship not in organization' USING ERRCODE = '23514';
    END IF;
    IF p_disposition = 'accepted' AND v_relationship.created_by IS DISTINCT FROM p_reviewer_actor_id THEN
      RAISE EXCEPTION 'an accepted proposal must cite the link this reviewer created' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.forgewing_relationship_proposal_reviews (
    organization_id, proposal_id, disposition, relationship_id, reason, reviewer_actor_id, review_request_digest)
  VALUES (p_organization_id, p_proposal_id, p_disposition, p_relationship_id, p_reason, p_reviewer_actor_id,
    p_review_request_digest)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'this proposal already has a final review' USING ERRCODE = '23505';
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_relationship_proposal(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, integer, jsonb, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgewing_relationship_proposal(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, integer, jsonb, text, text, text, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.record_forgewing_relationship_proposal_review(
  uuid, uuid, text, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgewing_relationship_proposal_review(
  uuid, uuid, text, uuid, text, uuid, text) TO service_role;

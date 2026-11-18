-- FDE Plan Approval hardening. Forward-only: 20261104120000_fde_plan_approval.sql
-- is applied in production and is not edited.
--
-- 1. record_fde_plan_review independently enforces need coverage. The service
--    computes eligibility in lib/projectIntelligence/fdeResolvedPlan.ts; the
--    database no longer trusts the caller's eligible flag on its own. For an
--    approved decision every need in the frozen snapshot must carry exactly one
--    entry, and that entry must be a valid confirmed resolution or a valid
--    waiver. A confirmed resolution of a structural (non-interpretable) need is
--    refused on every disposition. Evidence-reference digests remain checked by
--    the resolver; the database checks reference identity and kind only.
-- 2. TRUNCATE is refused on every FDE plan table, as for
--    customer_header_mapping_revisions_no_truncate.
-- 3. service_role loses the unused direct INSERT on supplemental documents;
--    writes go through record_fde_plan_supplemental_document (SECURITY DEFINER).
--
-- The waiver model, acknowledgment text, and reviewer access are unchanged.

CREATE OR REPLACE FUNCTION public.record_fde_plan_review(
  p_base_snapshot_id uuid,p_base_digest_sha256 text,p_resolved_canonical_json text,p_resolved_digest_sha256 text,
  p_disposition text,p_rationale text,p_request_digest_sha256 text,p_actor_id uuid,
  p_resolutions jsonb,p_waivers jsonb,p_expected_review_version integer
) RETURNS TABLE(review_id uuid,review_version integer,inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_snapshot public.fde_plan_snapshots%ROWTYPE;
  v_existing public.fde_plan_reviews%ROWTYPE;
  v_version integer;
  v_review_id uuid;
  v_resolution jsonb;
  v_waiver jsonb;
  v_resolved jsonb;
  v_need_ids text[];
  v_ack constant text := 'I acknowledge that this information has not been independently verified. I understand that the proposed recommendation may rely on customer-provided information and that supporting evidence may still be required before implementation or activation.';
  -- Mirrors interpretableKinds in lib/projectIntelligence/fdeResolvedPlan.ts.
  v_interpretable_kinds constant text[] := ARRAY['follow_up','described_document','unmatched_file','limited_file','relationship','assessment_limitation'];
  v_plan jsonb;
  v_file_ids text[];
  v_answer_ids text[];
BEGIN
  IF auth.role() <> 'service_role' OR p_base_digest_sha256 !~ '^[a-f0-9]{64}$'
    OR p_resolved_digest_sha256 !~ '^[a-f0-9]{64}$' OR p_request_digest_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'unauthorized FDE review write' USING ERRCODE='42501';
  END IF;
  IF p_resolved_digest_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(p_resolved_canonical_json,'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'resolved plan digest mismatch' USING ERRCODE='23514';
  END IF;
  v_resolved := p_resolved_canonical_json::jsonb;
  IF jsonb_typeof(p_resolutions) IS DISTINCT FROM 'array' OR jsonb_typeof(p_waivers) IS DISTINCT FROM 'array'
    OR p_disposition NOT IN ('approved','rejected','changes_requested')
    OR length(btrim(p_rationale)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid FDE review' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_snapshot FROM public.fde_plan_snapshots WHERE id=p_base_snapshot_id AND plan_digest_sha256=p_base_digest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FDE review snapshot mismatch' USING ERRCODE='42501';
  END IF;
  -- Serialize currentness and version allocation with supplemental uploads.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_snapshot.source_submission_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id=p_actor_id AND p.organization_id=v_snapshot.organization_id)
    OR v_snapshot.evidence_revision IS DISTINCT FROM (SELECT coalesce(max(d.evidence_revision),0) FROM public.fde_plan_supplemental_documents d WHERE d.source_submission_id=v_snapshot.source_submission_id)
    OR v_snapshot.assessment_version IS DISTINCT FROM (SELECT max(a.assessment_version) FROM public.workflow_assessments a WHERE a.source_submission_id=v_snapshot.source_submission_id)
    OR v_resolved->>'basePlanDigestSha256' IS DISTINCT FROM p_base_digest_sha256
    OR v_resolved->>'sourceSubmissionId' IS DISTINCT FROM v_snapshot.source_submission_id::text
    OR v_resolved->>'assessmentId' IS DISTINCT FROM v_snapshot.assessment_id::text
    OR (v_resolved->>'assessmentVersion')::integer IS DISTINCT FROM v_snapshot.assessment_version
    OR (v_resolved->>'evidenceRevision')::integer IS DISTINCT FROM v_snapshot.evidence_revision
    OR v_resolved->>'authority' IS DISTINCT FROM 'non_authoritative' THEN
    RAISE EXCEPTION 'FDE review source or actor mismatch' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') need
    LEFT JOIN LATERAL (
      SELECT a.id FROM public.workflow_assessment_follow_up_answers a
      WHERE a.source_submission_id=v_snapshot.source_submission_id
        AND a.organization_id=v_snapshot.organization_id
        AND a.follow_up_id=substring(need->>'needKey' from 11) AND a.assessment_version<=v_snapshot.assessment_version
      ORDER BY a.revision DESC,a.id DESC LIMIT 1
    ) latest_answer ON true
    WHERE need->>'needKind'='follow_up'
      AND coalesce((SELECT pin->>'answerId' FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb #> '{pinnedInputs,answers}') pin
                    WHERE pin->>'followUpId'=substring(need->>'needKey' from 11) LIMIT 1),'')
        IS DISTINCT FROM coalesce(latest_answer.id::text,'')
  ) OR coalesce((SELECT r.id::text FROM public.workflow_assessment_reviews r
                  WHERE r.assessment_id=v_snapshot.assessment_id AND r.assessment_version=v_snapshot.assessment_version
                  ORDER BY r.review_version DESC LIMIT 1),'')
       IS DISTINCT FROM coalesce(v_snapshot.plan_canonical_json::jsonb #>> '{pinnedInputs,assessmentReview,reviewId}','') THEN
    RAISE EXCEPTION 'FDE plan source revisions changed' USING ERRCODE='23514';
  END IF;
  IF p_disposition='approved' AND (v_resolved->>'eligible' IS DISTINCT FROM 'true'
    OR v_resolved #>> '{deploymentApproach,state}' IS DISTINCT FROM 'candidate_pending_review'
    OR v_resolved #>> '{deploymentApproach,rung}' IS NULL
    OR jsonb_typeof(v_resolved->'blockers') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_resolved->'blockers') <> 0) THEN
    RAISE EXCEPTION 'FDE recommendation is not eligible' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(n->>'needId') INTO v_need_ids FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') n;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_resolutions) r WHERE NOT (r->>'needId'=ANY(coalesce(v_need_ids,'{}'::text[]))))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_waivers) w WHERE NOT (w->>'needId'=ANY(coalesce(v_need_ids,'{}'::text[]))))
    OR (SELECT count(*) FROM jsonb_array_elements(p_resolutions) r) <> (SELECT count(DISTINCT r->>'needId') FROM jsonb_array_elements(p_resolutions) r)
    OR (SELECT count(*) FROM jsonb_array_elements(p_waivers) w) <> (SELECT count(DISTINCT w->>'needId') FROM jsonb_array_elements(p_waivers) w) THEN
    RAISE EXCEPTION 'FDE need identity mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_waivers) w JOIN jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') n ON n->>'needId'=w->>'needId'
    WHERE n->>'needKind' NOT IN ('described_document','follow_up')
      OR w->>'acknowledgmentText' IS DISTINCT FROM v_ack OR w->>'acknowledgmentVersion' IS DISTINCT FROM 'fde_evidence_waiver_v1'
      OR w->>'acknowledged' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'prohibited or unacknowledged FDE waiver' USING ERRCODE='23514';
  END IF;
  -- Pinned evidence identities a reviewer judgment may cite.
  v_plan := v_snapshot.plan_canonical_json::jsonb;
  SELECT coalesce(array_agg(f->>'attachmentId'),'{}'::text[]) INTO v_file_ids
    FROM jsonb_array_elements(coalesce(v_plan #> '{pinnedInputs,suppliedFiles}','[]'::jsonb)) f;
  SELECT coalesce(array_agg(a->>'answerId'),'{}'::text[]) INTO v_answer_ids
    FROM jsonb_array_elements(coalesce(v_plan #> '{pinnedInputs,answers}','[]'::jsonb)) a;
  -- Structural needs (authority, integrity, or human-decision gaps) are never
  -- confirmed by reviewer interpretation, whatever the disposition. The list is
  -- the interpretable kinds; any other kind, including a future one, fails closed.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_resolutions) r
    JOIN jsonb_array_elements(v_plan->'informationNeeds') n ON n->>'needId'=r->>'needId'
    WHERE r->>'disposition'='confirmed'
      AND NOT (coalesce(n->>'needKind','') = ANY (v_interpretable_kinds))) THEN
    RAISE EXCEPTION 'structural FDE need cannot be confirmed' USING ERRCODE='23514';
  END IF;
  -- An approval covers every frozen need exactly once with a valid judgment.
  IF p_disposition='approved' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_plan->'informationNeeds') n
    WHERE (SELECT count(*) FROM jsonb_array_elements(p_resolutions) r WHERE r->>'needId'=n->>'needId')
        + (SELECT count(*) FROM jsonb_array_elements(p_waivers) w WHERE w->>'needId'=n->>'needId') <> 1
      OR (SELECT count(*) FROM jsonb_array_elements(p_resolutions) r
          WHERE r->>'needId'=n->>'needId' AND r->>'disposition'='confirmed'
            AND n->>'needKind' = ANY (v_interpretable_kinds)
            AND length(btrim(coalesce(r->>'conclusion',''))) > 0
            AND length(btrim(coalesce(r->>'rationale',''))) > 0
            AND (CASE WHEN n->>'needKind' IN ('relationship','assessment_limitation')
                   THEN cardinality(v_file_ids) + cardinality(v_answer_ids) > 0
                   ELSE n->>'state'='supplied_uninterpreted'
                     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(n->'sourceIds','[]'::jsonb)) s
                                 WHERE s = ANY (v_file_ids) OR s = ANY (v_answer_ids)) END)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r->'sourceRefs','[]'::jsonb)) ref
                        WHERE ((ref->>'kind'='attachment' AND ref->>'id' = ANY (v_file_ids))
                            OR (ref->>'kind'='follow_up_answer' AND ref->>'id' = ANY (v_answer_ids)))
                          AND (n->>'needKind' IN ('relationship','assessment_limitation')
                            OR coalesce(n->'sourceIds','[]'::jsonb) ? (ref->>'id'))))
       + (SELECT count(*) FROM jsonb_array_elements(p_waivers) w
          WHERE w->>'needId'=n->>'needId'
            AND w->>'requirement' IS NOT DISTINCT FROM n->>'description'
            AND length(btrim(coalesce(w->>'customerStatement',''))) > 0
            AND length(btrim(coalesce(w->>'reason',''))) > 0
            AND ((n->>'needKind'='described_document' AND n->>'state' IN ('not_supplied','requires_clarification'))
              OR (n->>'needKind'='follow_up' AND n->>'state'='supplied_uninterpreted'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(w->'sourceRefs','[]'::jsonb)) ref
                            WHERE ref->>'kind'='follow_up_answer' AND ref->>'id' = ANY (v_answer_ids)
                              AND coalesce(n->'sourceIds','[]'::jsonb) ? (ref->>'id'))))
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(w->'sourceRefs','[]'::jsonb)) ref
                        WHERE (ref->>'kind'='intake' AND ref->>'id'=v_snapshot.source_submission_id::text)
                           OR (ref->>'kind'='follow_up_answer' AND ref->>'id' = ANY (v_answer_ids)))) <> 1
  ) THEN
    RAISE EXCEPTION 'FDE approval does not resolve every need exactly once' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_existing FROM public.fde_plan_reviews WHERE request_digest_sha256=p_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.base_snapshot_id<>p_base_snapshot_id OR v_existing.base_plan_digest_sha256<>p_base_digest_sha256
      OR v_existing.resolved_plan_canonical_json<>p_resolved_canonical_json OR v_existing.disposition<>p_disposition
      OR v_existing.rationale<>p_rationale OR v_existing.reviewer_actor_id<>p_actor_id
      OR v_existing.resolutions_canonical_json<>p_resolutions::text OR v_existing.waivers_canonical_json<>p_waivers::text THEN
      RAISE EXCEPTION 'FDE review idempotency collision' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.review_version,false;
    RETURN;
  END IF;
  SELECT coalesce(max(r.review_version),0) INTO v_version FROM public.fde_plan_reviews r WHERE r.source_submission_id=v_snapshot.source_submission_id;
  -- A decision must be made against the decision history its reviewer actually saw.
  IF p_expected_review_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'FDE decision history changed' USING ERRCODE='40001';
  END IF;
  v_version := v_version+1;
  INSERT INTO public.fde_plan_reviews (organization_id,source_submission_id,base_snapshot_id,base_plan_digest_sha256,
    resolved_plan_digest_sha256,resolved_plan_canonical_json,resolutions_canonical_json,waivers_canonical_json,
    review_version,reviewer_actor_id,disposition,rationale,request_digest_sha256)
  VALUES (v_snapshot.organization_id,v_snapshot.source_submission_id,p_base_snapshot_id,p_base_digest_sha256,
    p_resolved_digest_sha256,p_resolved_canonical_json,p_resolutions::text,p_waivers::text,
    v_version,p_actor_id,p_disposition,btrim(p_rationale),p_request_digest_sha256) RETURNING id INTO v_review_id;
  FOR v_resolution IN SELECT value FROM jsonb_array_elements(p_resolutions) LOOP
    INSERT INTO public.fde_plan_need_resolutions(review_id,need_id,base_snapshot_id,base_plan_digest_sha256,
      disposition,conclusion,rationale,source_refs,reviewer_actor_id,review_version)
    VALUES(v_review_id,v_resolution->>'needId',p_base_snapshot_id,p_base_digest_sha256,
      v_resolution->>'disposition',v_resolution->>'conclusion',v_resolution->>'rationale',
      coalesce(v_resolution->'sourceRefs','[]'::jsonb),p_actor_id,v_version);
  END LOOP;
  FOR v_waiver IN SELECT value FROM jsonb_array_elements(p_waivers) LOOP
    INSERT INTO public.fde_plan_evidence_waivers(review_id,organization_id,source_submission_id,base_snapshot_id,
      base_plan_digest_sha256,resolved_plan_digest_sha256,need_id,requirement,customer_statement,reason,source_refs,
      acknowledged_by_actor_id,acknowledgment_text,acknowledgment_version,acknowledged,review_version,request_digest_sha256)
    VALUES(v_review_id,v_snapshot.organization_id,v_snapshot.source_submission_id,p_base_snapshot_id,p_base_digest_sha256,
      p_resolved_digest_sha256,v_waiver->>'needId',v_waiver->>'requirement',v_waiver->>'customerStatement',
      v_waiver->>'reason',coalesce(v_waiver->'sourceRefs','[]'::jsonb),p_actor_id,
      v_waiver->>'acknowledgmentText',v_waiver->>'acknowledgmentVersion',true,v_version,p_request_digest_sha256);
  END LOOP;
  RETURN QUERY SELECT v_review_id,v_version,true;
END $$;
REVOKE ALL ON FUNCTION public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb,integer) TO service_role;

CREATE TRIGGER fde_plan_supplemental_documents_no_truncate BEFORE TRUNCATE ON public.fde_plan_supplemental_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_snapshots_no_truncate BEFORE TRUNCATE ON public.fde_plan_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_reviews_no_truncate BEFORE TRUNCATE ON public.fde_plan_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_need_resolutions_no_truncate BEFORE TRUNCATE ON public.fde_plan_need_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_evidence_waivers_no_truncate BEFORE TRUNCATE ON public.fde_plan_evidence_waivers
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fde_plan_record_mutation();

REVOKE INSERT ON public.fde_plan_supplemental_documents FROM service_role;

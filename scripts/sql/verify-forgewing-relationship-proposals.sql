\set ON_ERROR_STOP on

-- Forgewing P3.2 V1: immutable `amends` relationship proposals, confirmed only
-- through the operator's link. Disposable fixtures; the replay job drops the DB.

INSERT INTO public.organizations (id, name) VALUES
  ('95320000-0000-4000-8000-000000000001', 'P3.2 org A'),
  ('95320000-0000-4000-8000-000000000002', 'P3.2 org B');
INSERT INTO auth.users (id) VALUES
  ('95320000-0000-4000-8000-000000000011'), ('95320000-0000-4000-8000-000000000012'),
  ('95320000-0000-4000-8000-000000000013');
INSERT INTO public.user_profiles (id, organization_id, role) VALUES
  ('95320000-0000-4000-8000-000000000011', '95320000-0000-4000-8000-000000000001', 'member'),
  ('95320000-0000-4000-8000-000000000012', '95320000-0000-4000-8000-000000000001', 'member'),
  ('95320000-0000-4000-8000-000000000013', '95320000-0000-4000-8000-000000000002', 'member');
INSERT INTO public.projects (id, organization_id, name) VALUES
  ('95320000-0000-4000-8000-000000000021', '95320000-0000-4000-8000-000000000001', 'P3.2 project A'),
  ('95320000-0000-4000-8000-000000000022', '95320000-0000-4000-8000-000000000002', 'P3.2 project B');
INSERT INTO public.documents (id, organization_id, project_id, name, storage_path) VALUES
  ('95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021', 'amendment-3.pdf', 'p32/a3.pdf'),
  ('95320000-0000-4000-8000-000000000032', '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021', 'contract.pdf', 'p32/c.pdf'),
  ('95320000-0000-4000-8000-000000000033', '95320000-0000-4000-8000-000000000002', '95320000-0000-4000-8000-000000000022', 'other-org.pdf', 'p32/o.pdf');

DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public.forgewing_relationship_proposals', 'SELECT')
    OR has_table_privilege('anon', 'public.forgewing_relationship_proposal_reviews', 'SELECT')
    OR has_table_privilege('service_role', 'public.forgewing_relationship_proposals', 'INSERT')
    OR has_table_privilege('service_role', 'public.forgewing_relationship_proposal_reviews', 'INSERT')
    OR has_function_privilege('authenticated', 'public.record_forgewing_relationship_proposal(uuid, uuid, uuid, uuid, text, text, text, text, text, text, integer, jsonb, text, text, text, uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.record_forgewing_relationship_proposal_review(uuid, uuid, text, uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3.2: proposal grants are wrong';
  END IF;
END $$;

CREATE TEMP TABLE p32_relationship_count AS SELECT count(*) AS n FROM public.document_relationships;
GRANT SELECT ON p32_relationship_count TO service_role;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $$
DECLARE
  v record;
  v_again record;
BEGIN
  -- A recorded proposal is non-authoritative, idempotent, and creates no relationship.
  SELECT * INTO v FROM public.record_forgewing_relationship_proposal(
    '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021',
    '95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000032',
    'amends', 'referenced_amendment_link', 'deterministic_b7_candidate', NULL, NULL,
    'SOURCES_REFERENCED_AMENDMENT_MISSING:p:amendment:3', 3,
    '[{"documentId":"95320000-0000-4000-8000-000000000032","page":2,"matchedText":"Amendment No. 3"}]'::jsonb,
    'Identified as Amendment No. 3.', repeat('1', 64), repeat('2', 64), '95320000-0000-4000-8000-000000000011');
  IF v.proposal_id IS NULL OR v.inserted IS NOT TRUE THEN RAISE EXCEPTION 'P3.2: proposal not recorded'; END IF;
  SELECT * INTO v_again FROM public.record_forgewing_relationship_proposal(
    '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021',
    '95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000032',
    'amends', 'referenced_amendment_link', 'deterministic_b7_candidate', NULL, NULL,
    'SOURCES_REFERENCED_AMENDMENT_MISSING:p:amendment:3', 3,
    '[{"documentId":"95320000-0000-4000-8000-000000000032","page":2,"matchedText":"Amendment No. 3"}]'::jsonb,
    'Identified as Amendment No. 3.', repeat('1', 64), repeat('2', 64), '95320000-0000-4000-8000-000000000011');
  IF v_again.proposal_id <> v.proposal_id OR v_again.inserted THEN RAISE EXCEPTION 'P3.2: proposal not idempotent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.forgewing_relationship_proposals
      WHERE id = v.proposal_id AND authority = 'non_authoritative' AND requires_human_review) THEN
    RAISE EXCEPTION 'P3.2: proposal authority markers missing';
  END IF;

  -- Only amends; documents and requester must belong to the organization's project.
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal(
      '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021',
      '95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000032',
      'supersedes', 'referenced_amendment_link', 'deterministic_b7_candidate', NULL, NULL, NULL, 3,
      '[{"documentId":"x"}]'::jsonb, 'r', repeat('1', 64), repeat('3', 64), NULL);
    RAISE EXCEPTION 'P3.2: a non-amends proposal was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal(
      '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021',
      '95320000-0000-4000-8000-000000000033', '95320000-0000-4000-8000-000000000032',
      'amends', 'referenced_amendment_link', 'deterministic_b7_candidate', NULL, NULL, NULL, 3,
      '[{"documentId":"x"}]'::jsonb, 'r', repeat('1', 64), repeat('4', 64), NULL);
    RAISE EXCEPTION 'P3.2: a cross-organization document was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal(
      '95320000-0000-4000-8000-000000000001', '95320000-0000-4000-8000-000000000021',
      '95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000032',
      'amends', 'referenced_amendment_link', 'forgewing_model', NULL, NULL, NULL, 3,
      '[{"documentId":"x"}]'::jsonb, 'r', repeat('1', 64), repeat('5', 64), NULL);
    RAISE EXCEPTION 'P3.2: a model proposal without model identity was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Acceptance must cite the link the reviewer created through the human route.
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal_review(
      '95320000-0000-4000-8000-000000000001', v.proposal_id, 'accepted',
      '95320000-0000-4000-8000-0000000000ff', NULL, '95320000-0000-4000-8000-000000000011', repeat('6', 64));
    RAISE EXCEPTION 'P3.2: an acceptance without the linked relationship was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Rejection needs a reason; another organization's reviewer is refused.
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal_review(
      '95320000-0000-4000-8000-000000000001', v.proposal_id, 'rejected', NULL, NULL,
      '95320000-0000-4000-8000-000000000011', repeat('7', 64));
    RAISE EXCEPTION 'P3.2: a rejection without a reason was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal_review(
      '95320000-0000-4000-8000-000000000001', v.proposal_id, 'deferred', NULL, NULL,
      '95320000-0000-4000-8000-000000000013', repeat('8', 64));
    RAISE EXCEPTION 'P3.2: a cross-organization reviewer was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Deferral is not final and may repeat.
  PERFORM * FROM public.record_forgewing_relationship_proposal_review(
    '95320000-0000-4000-8000-000000000001', v.proposal_id, 'deferred', NULL, 'later',
    '95320000-0000-4000-8000-000000000012', repeat('9', 64));
END $$;
RESET ROLE;

DO $$ BEGIN
  IF (SELECT count(*) FROM public.document_relationships) <> (SELECT n FROM p32_relationship_count) THEN
    RAISE EXCEPTION 'P3.2: recording a proposal created a relationship';
  END IF;
END $$;

-- The operator links the amendment (as the precedence route does, created_by = operator).
INSERT INTO public.document_relationships (id, organization_id, project_id, source_document_id, target_document_id,
  relationship_type, created_by)
VALUES ('95320000-0000-4000-8000-0000000000a1', '95320000-0000-4000-8000-000000000001',
  '95320000-0000-4000-8000-000000000021', '95320000-0000-4000-8000-000000000031',
  '95320000-0000-4000-8000-000000000032', 'amends', '95320000-0000-4000-8000-000000000011');

SET ROLE service_role;
DO $$
DECLARE
  v_proposal uuid := (SELECT id FROM public.forgewing_relationship_proposals
    WHERE organization_id = '95320000-0000-4000-8000-000000000001' AND proposal_digest = repeat('2', 64));
  v record;
BEGIN
  -- Another member cannot accept the link someone else created.
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal_review(
      '95320000-0000-4000-8000-000000000001', v_proposal, 'accepted',
      '95320000-0000-4000-8000-0000000000a1', NULL, '95320000-0000-4000-8000-000000000012', repeat('a', 64));
    RAISE EXCEPTION 'P3.2: acceptance of another reviewer''s link was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT * INTO v FROM public.record_forgewing_relationship_proposal_review(
    '95320000-0000-4000-8000-000000000001', v_proposal, 'accepted',
    '95320000-0000-4000-8000-0000000000a1', 'checked', '95320000-0000-4000-8000-000000000011', repeat('b', 64));
  IF v.review_id IS NULL OR v.inserted IS NOT TRUE THEN RAISE EXCEPTION 'P3.2: acceptance not recorded'; END IF;
  -- One final decision per proposal.
  BEGIN
    PERFORM * FROM public.record_forgewing_relationship_proposal_review(
      '95320000-0000-4000-8000-000000000001', v_proposal, 'rejected', NULL, 'changed my mind',
      '95320000-0000-4000-8000-000000000012', repeat('c', 64));
    RAISE EXCEPTION 'P3.2: a second final review was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
RESET ROLE;
RESET request.jwt.claim.role;

-- Append-only, even for the owner; the proposal never touched precedence.
DO $$ BEGIN
  BEGIN
    UPDATE public.forgewing_relationship_proposals SET rationale = 'x';
    RAISE EXCEPTION 'P3.2: proposal update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.forgewing_relationship_proposal_reviews;
    RAISE EXCEPTION 'P3.2: review delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.documents WHERE id IN ('95320000-0000-4000-8000-000000000031', '95320000-0000-4000-8000-000000000032')
      AND (operator_override_precedence IS TRUE OR precedence_rank IS NOT NULL)) THEN
    RAISE EXCEPTION 'P3.2: precedence was changed';
  END IF;
END $$;

SELECT 'FORGEWING RELATIONSHIP PROPOSALS: PASS' AS result;

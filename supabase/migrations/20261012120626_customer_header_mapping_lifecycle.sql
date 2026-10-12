-- B8.2b: reviewed exact-label mappings. No interpretation/deployment authority.
-- Revisions and lifecycle events are immutable. Only the active lookup changes.
-- Forward-only: disable writer RPCs to roll back; preserve historical evidence.
CREATE TABLE public.customer_header_mapping_revisions (
  revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_boundary text NOT NULL CHECK (interpretation_boundary = 'priced_schedule_assembly_header'),
  document_type text NOT NULL CHECK (length(btrim(document_type)) BETWEEN 1 AND 512),
  source_schema_identity text NOT NULL CHECK (source_schema_identity ~ '^customer-header-schema-v1:[a-f0-9]{64}$'),
  source_label text NOT NULL CHECK (length(btrim(source_label)) BETWEEN 1 AND 512),
  target_role text NOT NULL CHECK (target_role IN ('description','unit','origin_destination','rate')),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  envelope_canonical_json text NOT NULL,
  approved_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL,
  supersedes_revision_id uuid REFERENCES public.customer_header_mapping_revisions(revision_id) ON DELETE RESTRICT,
  UNIQUE(organization_id, digest),
  UNIQUE(supersedes_revision_id),
  CHECK (revision_id IS DISTINCT FROM supersedes_revision_id)
);
CREATE INDEX customer_header_mapping_revision_scope_idx ON public.customer_header_mapping_revisions
  (organization_id, interpretation_boundary, document_type, source_schema_identity, source_label);
CREATE TABLE public.customer_header_mapping_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.customer_header_mapping_revisions(revision_id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('approved','activated','withdrawn','superseded')),
  actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  related_revision_id uuid REFERENCES public.customer_header_mapping_revisions(revision_id) ON DELETE RESTRICT,
  UNIQUE(revision_id, action)
);
CREATE INDEX customer_header_mapping_events_org_idx ON public.customer_header_mapping_events(organization_id, revision_id);
CREATE TABLE public.customer_header_mapping_active (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_boundary text NOT NULL,
  document_type text NOT NULL,
  source_schema_identity text NOT NULL,
  source_label text NOT NULL,
  revision_id uuid NOT NULL UNIQUE REFERENCES public.customer_header_mapping_revisions(revision_id) ON DELETE RESTRICT,
  PRIMARY KEY(organization_id, interpretation_boundary, document_type, source_schema_identity, source_label)
);
CREATE FUNCTION public.reject_customer_header_mapping_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'customer mapping history is immutable' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER customer_header_mapping_revisions_immutable BEFORE UPDATE OR DELETE ON public.customer_header_mapping_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_customer_header_mapping_mutation();
CREATE TRIGGER customer_header_mapping_events_immutable BEFORE UPDATE OR DELETE ON public.customer_header_mapping_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_customer_header_mapping_mutation();
CREATE TRIGGER customer_header_mapping_revisions_no_truncate BEFORE TRUNCATE ON public.customer_header_mapping_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_customer_header_mapping_mutation();
CREATE TRIGGER customer_header_mapping_events_no_truncate BEFORE TRUNCATE ON public.customer_header_mapping_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_customer_header_mapping_mutation();
ALTER TABLE public.customer_header_mapping_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_header_mapping_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_header_mapping_active ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_header_mapping_revisions, public.customer_header_mapping_events,
  public.customer_header_mapping_active FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.customer_header_mapping_revisions, public.customer_header_mapping_events,
  public.customer_header_mapping_active TO service_role;
REVOKE ALL ON FUNCTION public.reject_customer_header_mapping_mutation() FROM PUBLIC, anon, authenticated, service_role;

-- Matches the existing hashCanonical contract: recursive key order, compact
-- separators, ordered arrays. Envelope keys are the fixed ASCII contract.
CREATE FUNCTION public.customer_header_mapping_canonical_json(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result text;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.customer_header_mapping_canonical_json(entry),',' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(value) member(key,entry);
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT '['||coalesce(string_agg(public.customer_header_mapping_canonical_json(entry),',' ORDER BY ordinal),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY member(entry,ordinal);
  ELSE result := value::text; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.customer_header_mapping_canonical_json(jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.approve_customer_header_mapping(
  p_organization_id uuid, p_actor_id uuid, p_revision_envelope_canonical_json text, p_verified_extraction_data jsonb
) RETURNS TABLE(revision_id uuid, digest text, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v jsonb; m jsonb; e jsonb; s jsonb; x jsonb; page jsonb; refs jsonb;
  v_digest text; v_id uuid; v_predecessor uuid; v_head uuid; v_row record; v_doc record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.user_profiles WHERE id=p_actor_id AND organization_id=p_organization_id AND role IN ('owner','admin') FOR SHARE;
  IF NOT FOUND
    THEN RAISE EXCEPTION 'same-organization owner/admin required' USING ERRCODE='42501'; END IF;
  v := p_revision_envelope_canonical_json::jsonb; s := v->'scope';
  IF p_revision_envelope_canonical_json IS DISTINCT FROM public.customer_header_mapping_canonical_json(v)
    THEN RAISE EXCEPTION 'canonical envelope bytes required' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v->>'domain' IS DISTINCT FROM 'eightforge.reviewed-customer-header-mapping'
    OR v->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR v->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v #>> '{humanApproval,actorId}' IS DISTINCT FROM p_actor_id::text
    OR jsonb_typeof(v->'mappings') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'mappings') <> 1
    OR (v - ARRAY['domain','schemaVersion','organizationId','revisionId','scope','mappings','humanApproval','supersedesRevisionId']) <> '{}'::jsonb
    OR jsonb_typeof(v->'humanApproval') IS DISTINCT FROM 'object'
    OR ((v->'humanApproval') - ARRAY['actorId','approvedAt']) <> '{}'::jsonb
    OR s->>'interpretationBoundary' IS DISTINCT FROM 'priced_schedule_assembly_header'
    OR (s - ARRAY['interpretationBoundary','documentType','sourceSchemaIdentity']) <> '{}'::jsonb
    THEN RAISE EXCEPTION 'invalid reviewed mapping envelope' USING ERRCODE='23514'; END IF;
  m := v->'mappings'->0; e := m->'supportingEvidence';
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR jsonb_typeof(e) IS DISTINCT FROM 'object'
    OR (m - ARRAY['sourceLabel','targetRole','supportingEvidence']) <> '{}'::jsonb
    OR NOT (e ?& ARRAY['organizationId','projectId','documentId','extractionId','sourceArtifactId','sourceSha256',
      'physicalPageNumber','pageRepresentationDigest','headerIndex','columnIndex','documentType','observedHeaderLabel',
      'orderedObservationIds','sourceSchemaIdentity'])
    OR (e - ARRAY['organizationId','projectId','documentId','extractionId','sourceArtifactId','sourceSha256',
      'physicalPageNumber','pageRepresentationDigest','headerIndex','columnIndex','documentType','observedHeaderLabel',
      'orderedObservationIds','sourceSchemaIdentity']) <> '{}'::jsonb
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['organizationId','projectId','documentId','extractionId','sourceArtifactId','sourceSha256',
      'pageRepresentationDigest','documentType','observedHeaderLabel','sourceSchemaIdentity']) key WHERE jsonb_typeof(e->key) IS DISTINCT FROM 'string')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['physicalPageNumber','headerIndex','columnIndex']) key WHERE jsonb_typeof(e->key) IS DISTINCT FROM 'number')
    OR e->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR e->>'documentType' IS DISTINCT FROM s->>'documentType'
    OR e->>'sourceSchemaIdentity' IS DISTINCT FROM s->>'sourceSchemaIdentity'
    OR e->>'observedHeaderLabel' IS DISTINCT FROM m->>'sourceLabel'
    OR e->>'sourceSha256' !~ '^[a-f0-9]{64}$'
    OR e->>'pageRepresentationDigest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(e->'orderedObservationIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(e->'orderedObservationIds') NOT BETWEEN 1 AND 200
    THEN RAISE EXCEPTION 'mapping evidence scope mismatch' USING ERRCODE='23514'; END IF;
  v_id := (v->>'revisionId')::uuid; v_predecessor := (v->>'supersedesRevisionId')::uuid;
  v_digest := encode(extensions.digest(convert_to(p_revision_envelope_canonical_json,'UTF8'),'sha256'),'hex');
  -- Serialize the whole exact lookup key; hashes are advisory lock identifiers,
  -- while the full composite PRIMARY KEY remains the uniqueness authority.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_organization_id,
    s->>'interpretationBoundary',s->>'documentType',s->>'sourceSchemaIdentity',m->>'sourceLabel')::text,0));
  SELECT * INTO v_row FROM public.customer_header_mapping_revisions r WHERE r.revision_id=v_id;
  IF FOUND THEN
    IF v_row.organization_id <> p_organization_id OR v_row.envelope_canonical_json IS DISTINCT FROM p_revision_envelope_canonical_json
      THEN RAISE EXCEPTION 'revision identity collision' USING ERRCODE='23505'; END IF;
    RETURN QUERY SELECT v_id,v_digest,false; RETURN;
  END IF;
  -- The application freshly re-runs B8.2a's full geometry/schema verifier.
  -- Holding source rows and comparing that exact verified blob closes the
  -- read/approve gap; no client may submit an extraction snapshot to the API.
  SELECT d.id,d.project_id,d.document_type INTO v_doc FROM public.documents d
    WHERE d.id=(e->>'documentId')::uuid AND d.organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND OR v_doc.project_id IS DISTINCT FROM (e->>'projectId')::uuid
    OR v_doc.document_type IS DISTINCT FROM e->>'documentType'
    THEN RAISE EXCEPTION 'document ownership mismatch' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.projects WHERE id=v_doc.project_id AND organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project ownership mismatch' USING ERRCODE='23514'; END IF;
  SELECT data INTO x FROM public.document_extractions WHERE id=(e->>'extractionId')::uuid
    AND document_id=v_doc.id AND organization_id=p_organization_id AND field_key IS NULL FOR SHARE;
  IF NOT FOUND OR x IS DISTINCT FROM p_verified_extraction_data
    THEN RAISE EXCEPTION 'verified extraction changed' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.extraction_source_artifacts WHERE id=(e->>'sourceArtifactId')::uuid
    AND source_document_id=v_doc.id AND organization_id=p_organization_id AND source_sha256=e->>'sourceSha256' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact ownership mismatch' USING ERRCODE='23514'; END IF;
  x := x #> '{extraction,content_layers_v1,pdf}';
  page := x #> ARRAY['priced_schedule_reconstruction_v1','pages',e->>'headerIndex'];
  refs := page #> ARRAY['columns',e->>'columnIndex','header_source_refs'];
  IF x #>> '{layout_observations_v1,source_artifact_id}' IS DISTINCT FROM e->>'sourceArtifactId'
    OR page->>'physical_page_number' IS DISTINCT FROM e->>'physicalPageNumber'
    OR page #>> ARRAY['columns',e->>'columnIndex','header_text'] IS DISTINCT FROM m->>'sourceLabel'
    OR jsonb_typeof(refs) IS DISTINCT FROM 'array'
    OR (SELECT jsonb_agg(r->'observation_id' ORDER BY n) FROM jsonb_array_elements(refs) WITH ORDINALITY a(r,n))
       IS DISTINCT FROM e->'orderedObservationIds'
    OR (SELECT count(*) FROM jsonb_array_elements(x #> '{page_extraction_coverage_v1,pages}') c
      WHERE c->>'page_number'=e->>'physicalPageNumber' AND c->>'page_representation_digest'=e->>'pageRepresentationDigest') <> 1
    THEN RAISE EXCEPTION 'persisted header evidence mismatch' USING ERRCODE='23514'; END IF;
  SELECT r.revision_id INTO v_head FROM public.customer_header_mapping_revisions r
    WHERE r.organization_id=p_organization_id AND r.interpretation_boundary=s->>'interpretationBoundary'
      AND r.document_type=s->>'documentType' AND r.source_schema_identity=s->>'sourceSchemaIdentity'
      AND r.source_label=m->>'sourceLabel'
      AND NOT EXISTS (SELECT 1 FROM public.customer_header_mapping_revisions child WHERE child.supersedes_revision_id=r.revision_id);
  IF v_predecessor IS DISTINCT FROM v_head THEN RAISE EXCEPTION 'must supersede exact current chain head' USING ERRCODE='40001'; END IF;
  INSERT INTO public.customer_header_mapping_revisions(revision_id,organization_id,interpretation_boundary,document_type,
    source_schema_identity,source_label,target_role,digest,envelope_canonical_json,approved_by,approved_at,supersedes_revision_id)
  VALUES(v_id,p_organization_id,s->>'interpretationBoundary',s->>'documentType',s->>'sourceSchemaIdentity',m->>'sourceLabel',
    m->>'targetRole',v_digest,p_revision_envelope_canonical_json,p_actor_id,(v #>> '{humanApproval,approvedAt}')::timestamptz,v_predecessor);
  INSERT INTO public.customer_header_mapping_events(organization_id,revision_id,action,actor_id,occurred_at)
    VALUES(p_organization_id,v_id,'approved',p_actor_id,(v #>> '{humanApproval,approvedAt}')::timestamptz);
  RETURN QUERY SELECT v_id,v_digest,true;
END $$;

CREATE FUNCTION public.transition_customer_header_mapping(
  p_organization_id uuid,p_actor_id uuid,p_revision_id uuid,p_digest text,p_action text
) RETURNS TABLE(event_id uuid,occurred_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.customer_header_mapping_revisions%ROWTYPE; v_active uuid; v_event uuid; v_at timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.user_profiles WHERE id=p_actor_id AND organization_id=p_organization_id AND role IN ('owner','admin') FOR SHARE;
  IF NOT FOUND
    THEN RAISE EXCEPTION 'same-organization owner/admin required' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.customer_header_mapping_revisions WHERE revision_id=p_revision_id AND organization_id=p_organization_id AND digest=p_digest;
  IF NOT FOUND THEN RAISE EXCEPTION 'exact revision not found' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_organization_id,r.interpretation_boundary,
    r.document_type,r.source_schema_identity,r.source_label)::text,0));
  SELECT a.revision_id INTO v_active FROM public.customer_header_mapping_active a WHERE a.organization_id=p_organization_id
    AND a.interpretation_boundary=r.interpretation_boundary AND a.document_type=r.document_type
    AND a.source_schema_identity=r.source_schema_identity AND a.source_label=r.source_label;
  v_at := clock_timestamp();
  IF p_action='activate' THEN
    IF EXISTS (SELECT 1 FROM public.customer_header_mapping_events e WHERE e.revision_id=p_revision_id AND e.action IN ('activated','withdrawn','superseded'))
      OR EXISTS (SELECT 1 FROM public.customer_header_mapping_revisions child WHERE child.supersedes_revision_id=p_revision_id)
      THEN RAISE EXCEPTION 'only unactivated current approved head may activate' USING ERRCODE='55000'; END IF;
    IF v_active IS NOT NULL AND NOT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT predecessor.* FROM public.customer_header_mapping_revisions predecessor WHERE predecessor.revision_id=r.supersedes_revision_id
        UNION ALL
        SELECT predecessor.* FROM public.customer_header_mapping_revisions predecessor JOIN ancestors child
          ON predecessor.revision_id=child.supersedes_revision_id
      ) SELECT 1 FROM ancestors WHERE revision_id=v_active AND organization_id=p_organization_id
        AND interpretation_boundary=r.interpretation_boundary AND document_type=r.document_type
        AND source_schema_identity=r.source_schema_identity AND source_label=r.source_label)
      THEN RAISE EXCEPTION 'active predecessor changed' USING ERRCODE='40001'; END IF;
    IF v_active IS NOT NULL THEN
      INSERT INTO public.customer_header_mapping_events(organization_id,revision_id,action,actor_id,occurred_at,related_revision_id)
        VALUES(p_organization_id,v_active,'superseded',p_actor_id,v_at,p_revision_id);
      DELETE FROM public.customer_header_mapping_active WHERE revision_id=v_active;
    END IF;
    INSERT INTO public.customer_header_mapping_active VALUES(p_organization_id,r.interpretation_boundary,r.document_type,r.source_schema_identity,r.source_label,p_revision_id);
    INSERT INTO public.customer_header_mapping_events(organization_id,revision_id,action,actor_id,occurred_at)
      VALUES(p_organization_id,p_revision_id,'activated',p_actor_id,v_at) RETURNING customer_header_mapping_events.event_id INTO v_event;
  ELSIF p_action='withdraw' THEN
    IF v_active IS DISTINCT FROM p_revision_id THEN RAISE EXCEPTION 'withdraw requires exact active revision' USING ERRCODE='40001'; END IF;
    DELETE FROM public.customer_header_mapping_active WHERE revision_id=p_revision_id;
    INSERT INTO public.customer_header_mapping_events(organization_id,revision_id,action,actor_id,occurred_at)
      VALUES(p_organization_id,p_revision_id,'withdrawn',p_actor_id,v_at) RETURNING customer_header_mapping_events.event_id INTO v_event;
  ELSE RAISE EXCEPTION 'unknown mapping action' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT v_event,v_at;
END $$;
REVOKE ALL ON FUNCTION public.approve_customer_header_mapping(uuid,uuid,text,jsonb),
  public.transition_customer_header_mapping(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.approve_customer_header_mapping(uuid,uuid,text,jsonb),
  public.transition_customer_header_mapping(uuid,uuid,uuid,text,text) TO service_role;

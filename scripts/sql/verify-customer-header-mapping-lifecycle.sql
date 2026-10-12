\set ON_ERROR_STOP on
-- Generic disposable fixtures. No source document/customer content.
-- Produced independently by Node JSON.stringify + crypto SHA256. Fixed ASCII
-- keys, Unicode labels, quoted/backslash text and ordered scalar arrays verify
-- the SQL canonical representation against the application's exact bytes.
DO $$ DECLARE expected text := $bytes${"a":["Å € 😀","quote \" slash / backslash \\",1,null],"z":{"b":true}}$bytes$; actual text; BEGIN
 actual := public.customer_header_mapping_canonical_json(expected::jsonb);
 IF actual IS DISTINCT FROM expected OR encode(extensions.digest(convert_to(actual,'UTF8'),'sha256'),'hex')
   IS DISTINCT FROM '68dafdcd2628d9ea361ae7e31d31915b3e23d6c68adfcbf78294c37723702155'
 THEN RAISE EXCEPTION 'B8 FAIL: SQL canonical digest differs from TypeScript canonical bytes'; END IF;
END $$;
INSERT INTO public.organizations(id,name) VALUES('b8200000-0000-4000-8000-000000000001','B8 org A'),('b8200000-0000-4000-8000-000000000002','B8 org B');
INSERT INTO auth.users(id) VALUES('b8200000-0000-4000-8000-000000000011'),('b8200000-0000-4000-8000-000000000012'),('b8200000-0000-4000-8000-000000000013');
INSERT INTO public.user_profiles(id,organization_id,role) VALUES
  ('b8200000-0000-4000-8000-000000000011','b8200000-0000-4000-8000-000000000001','owner'),
  ('b8200000-0000-4000-8000-000000000012','b8200000-0000-4000-8000-000000000001','member'),
  ('b8200000-0000-4000-8000-000000000013','b8200000-0000-4000-8000-000000000002','admin');
INSERT INTO public.projects(id,organization_id,name) VALUES('b8200000-0000-4000-8000-000000000021','b8200000-0000-4000-8000-000000000001','B8 project');
INSERT INTO public.documents(id,organization_id,project_id,document_type,name,storage_path)
VALUES('b8200000-0000-4000-8000-000000000031','b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000021','contract','generic.pdf','b8/generic.pdf');
INSERT INTO public.extraction_source_artifacts(id,organization_id,source_document_id,source_sha256,storage_object_version,media_type_sniffed,byte_length)
VALUES('b8200000-0000-4000-8000-000000000051','b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000031',repeat('a',64),'v1','application/pdf',0);
INSERT INTO public.document_extractions(id,organization_id,document_id,data)
VALUES('b8200000-0000-4000-8000-000000000041','b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000031',jsonb_build_object('extraction',jsonb_build_object('content_layers_v1',jsonb_build_object('pdf',jsonb_build_object(
  'layout_observations_v1',jsonb_build_object('source_artifact_id','b8200000-0000-4000-8000-000000000051'),
  'page_extraction_coverage_v1',jsonb_build_object('pages',jsonb_build_array(jsonb_build_object('page_number',1,'page_representation_digest',repeat('b',64)))),
  'priced_schedule_reconstruction_v1',jsonb_build_object('pages',jsonb_build_array(jsonb_build_object('physical_page_number',1,'columns',jsonb_build_array(jsonb_build_object('header_text','Billing Rate','header_source_refs',jsonb_build_array(jsonb_build_object('observation_id','pdf:layout-token:v1:'||repeat('c',64)))))))))))));
CREATE FUNCTION pg_temp.b8_envelope(n integer,predecessor integer DEFAULT NULL) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
 SELECT public.customer_header_mapping_canonical_json(jsonb_build_object(
  'domain','eightforge.reviewed-customer-header-mapping','schemaVersion',2,'organizationId','b8200000-0000-4000-8000-000000000001',
  'revisionId',('b8200000-0000-4000-8000-'||lpad(n::text,12,'0')),
  'scope',jsonb_build_object('interpretationBoundary','priced_schedule_assembly_header','documentType','contract','sourceSchemaIdentity','customer-header-schema-v1:'||repeat('d',64)),
  'mappings',jsonb_build_array(jsonb_build_object('sourceLabel','Billing Rate','targetRole','rate','supportingEvidence',jsonb_build_object(
    'organizationId','b8200000-0000-4000-8000-000000000001','projectId','b8200000-0000-4000-8000-000000000021',
    'documentId','b8200000-0000-4000-8000-000000000031','extractionId','b8200000-0000-4000-8000-000000000041',
    'sourceArtifactId','b8200000-0000-4000-8000-000000000051','sourceSha256',repeat('a',64),'physicalPageNumber',1,
    'pageRepresentationDigest',repeat('b',64),'headerIndex',0,'columnIndex',0,'documentType','contract','observedHeaderLabel','Billing Rate',
    'orderedObservationIds',jsonb_build_array('pdf:layout-token:v1:'||repeat('c',64)),'sourceSchemaIdentity','customer-header-schema-v1:'||repeat('d',64)))),
  'humanApproval',jsonb_build_object('actorId','b8200000-0000-4000-8000-000000000011','approvedAt','2026-10-13T01:00:00Z'),
  'supersedesRevisionId',CASE WHEN predecessor IS NOT NULL THEN 'b8200000-0000-4000-8000-'||lpad(predecessor::text,12,'0') END)) $$;
CREATE FUNCTION pg_temp.b8_approve(n integer,predecessor integer DEFAULT NULL) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
 SELECT public.approve_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',pg_temp.b8_envelope(n,predecessor),
  (SELECT data FROM public.document_extractions WHERE id='b8200000-0000-4000-8000-000000000041')) $$;
CREATE FUNCTION pg_temp.b8_action(n integer, action text) RETURNS void LANGUAGE sql AS $$
 SELECT public.transition_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',
  ('b8200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  (SELECT digest FROM public.customer_header_mapping_revisions WHERE revision_id=('b8200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid),action) $$;
CREATE FUNCTION pg_temp.b8_fail(statement text, expected_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE=expected_state THEN RETURN; END IF; RAISE;
  END;
  RAISE EXCEPTION 'B8 FAIL: unexpectedly accepted %',statement;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role,authenticated;
SET ROLE authenticated;
SELECT pg_temp.b8_fail('SELECT * FROM public.customer_header_mapping_revisions','42501');
SELECT pg_temp.b8_fail('SELECT public.approve_customer_header_mapping(NULL,NULL,NULL,NULL)','42501');
RESET ROLE;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT pg_temp.b8_fail('DELETE FROM public.customer_header_mapping_active','42501');
SELECT pg_temp.b8_fail('TRUNCATE public.customer_header_mapping_revisions','42501');
SELECT pg_temp.b8_fail($$SELECT public.approve_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000012',pg_temp.b8_envelope(101),NULL)$$,'42501');
SELECT pg_temp.b8_fail($$SELECT public.approve_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000013',pg_temp.b8_envelope(101),NULL)$$,'42501');
SELECT pg_temp.b8_fail($$SELECT public.approve_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',pg_temp.b8_envelope(101),'{}')$$,'40001');
SELECT pg_temp.b8_approve(101);
SELECT pg_temp.b8_approve(101); -- exact idempotent approval preserves first event.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.customer_header_mapping_active) THEN RAISE EXCEPTION 'approval activated'; END IF; END $$;
SELECT pg_temp.b8_action(101,'activate');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_action(101,'activate')$$,'55000');
SELECT pg_temp.b8_approve(102,101);
SELECT pg_temp.b8_approve(103,102); -- correction of pending approval remains possible.
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_action(102,'activate')$$,'55000');
SELECT pg_temp.b8_action(103,'activate'); -- active ancestor101 replaced, pending102 skipped.
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_approve(104,101)$$,'40001');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_action(101,'withdraw')$$,'40001');
SELECT pg_temp.b8_action(103,'withdraw');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.customer_header_mapping_active) THEN RAISE EXCEPTION 'withdraw restored predecessor'; END IF;
 IF (SELECT count(*) FROM public.customer_header_mapping_events WHERE action='approved')<>3
   OR NOT EXISTS(SELECT 1 FROM public.customer_header_mapping_events WHERE revision_id='b8200000-0000-4000-8000-000000000101' AND action='superseded') THEN RAISE EXCEPTION 'history lost'; END IF;
END $$;
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_action(103,'activate')$$,'55000');
SELECT pg_temp.b8_approve(104,103);
SELECT pg_temp.b8_action(104,'activate');
RESET ROLE;
SELECT pg_temp.b8_fail($$UPDATE public.customer_header_mapping_revisions SET source_label='x'$$,'55000');
SELECT pg_temp.b8_fail($$DELETE FROM public.customer_header_mapping_events$$,'55000');
SELECT pg_temp.b8_fail($$TRUNCATE public.customer_header_mapping_events$$,'55000');
-- B8.2d: historical pin remains valid after withdrawal, without active lookup.
UPDATE public.document_extractions SET data=jsonb_set(data,'{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages,0,customer_header_mapping_pins}',
 jsonb_build_array(jsonb_build_object('version','customer_header_mapping_pin_v1','organizationId','b8200000-0000-4000-8000-000000000001',
 'documentType','contract','revisionId','b8200000-0000-4000-8000-000000000104',
 'digest',(SELECT digest FROM public.customer_header_mapping_revisions WHERE revision_id='b8200000-0000-4000-8000-000000000104'),
 'sourceSchemaIdentity','customer-header-schema-v1:'||repeat('d',64),'physicalPageNumber',1,'columnIndex',0,'sourceLabel','Billing Rate',
 'orderedObservationIds',jsonb_build_array('pdf:layout-token:v1:'||repeat('c',64)),'pageRepresentationDigest',repeat('b',64))))
 WHERE id='b8200000-0000-4000-8000-000000000041';
UPDATE public.document_extractions SET data=jsonb_set(data,'{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages,0,rows}',
 '[{"cells":[{"source_refs":[{"observation_id":"obs-1"}]}]}]') WHERE id='b8200000-0000-4000-8000-000000000041';
UPDATE public.document_extractions SET data=jsonb_set(data,'{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages,0,columns,0,role}', '"rate"')
 WHERE id='b8200000-0000-4000-8000-000000000041';
CREATE FUNCTION pg_temp.b8_assertion(request text,evidence jsonb, ids text[] DEFAULT ARRAY['obs-1'], artifact uuid DEFAULT 'b8200000-0000-4000-8000-000000000051') RETURNS void LANGUAGE sql AS $$
 SELECT public.record_region_bound_human_fact_assertion('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',
 'b8200000-0000-4000-8000-000000000031','contract_rate_row','{"rate_amount":15}', 'active','reviewed generic source',artifact,1,
 '{"boxes":[{"x_min":1,"x_max":2,"y_min":1,"y_max":2}]}',repeat('b',64),'priced_schedule_reconstruction_v6',ids,
 'generic','b8-anchor','operator_entered',NULL,NULL,request,evidence) $$;
CREATE FUNCTION pg_temp.b8_pins() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
 SELECT jsonb_build_object('extractionSnapshotId','b8200000-0000-4000-8000-000000000041','mappingPins',
 data #> '{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages,0,customer_header_mapping_pins}')
 FROM public.document_extractions WHERE id='b8200000-0000-4000-8000-000000000041' $$;
GRANT EXECUTE ON FUNCTION pg_temp.b8_assertion(text,jsonb,text[],uuid),pg_temp.b8_pins() TO service_role;
SET ROLE service_role;
SELECT pg_temp.b8_action(104,'withdraw');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_assertion(repeat('e',64),jsonb_set(pg_temp.b8_pins(),'{mappingPins,0,digest}',to_jsonb(repeat('f',64))))$$,'23514');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_assertion(repeat('e',64),pg_temp.b8_pins(),ARRAY['other-row-observation'])$$,'23514');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_assertion(repeat('e',64),pg_temp.b8_pins(),ARRAY[]::text[])$$,'23514');
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_assertion(repeat('e',64),pg_temp.b8_pins(),ARRAY['obs-1'],NULL)$$,'23514');
SELECT pg_temp.b8_assertion(repeat('e',64),pg_temp.b8_pins());
SELECT pg_temp.b8_assertion(repeat('e',64),pg_temp.b8_pins());
SELECT pg_temp.b8_fail($$SELECT pg_temp.b8_assertion(repeat('e',64),NULL)$$,'23505');
RESET ROLE;
DO $$ BEGIN
 IF (SELECT customer_mapping_evidence FROM public.human_fact_assertions WHERE request_digest_sha256=repeat('e',64)) IS DISTINCT FROM pg_temp.b8_pins()
 THEN RAISE EXCEPTION 'B8 FAIL: assertion historical provenance missing'; END IF;
END $$;
SELECT 'B8 MAPPING LIFECYCLE / ACL / HISTORY / HISTORICAL PIN: PASS';

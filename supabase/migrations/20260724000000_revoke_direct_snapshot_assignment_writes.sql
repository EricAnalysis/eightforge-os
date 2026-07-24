-- Step 0 publishes assignment changes only through the constrained
-- SECURITY DEFINER RPC. Keep direct service-role access read-only.
REVOKE INSERT, UPDATE
ON TABLE public.document_extraction_snapshot_assignments
FROM service_role;

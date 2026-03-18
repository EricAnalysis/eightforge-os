-- Migration: stuck document detection + processing_error column safety
-- Adds a server-side function to reset documents stuck in 'processing' state.
-- A document is considered stuck if processing_status = 'processing' for more
-- than 15 minutes, which indicates the pipeline crashed mid-run.

-- 1. Ensure processing_error column exists (safe add)
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS processing_error text;

-- 2. Function: mark_stuck_documents_failed
--    Resets any 'processing' document older than the given interval to 'failed'
--    with a processing_error message. Returns the number of rows updated.
CREATE OR REPLACE FUNCTION public.mark_stuck_documents_failed(
  stuck_threshold interval DEFAULT interval '15 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH updated AS (
    UPDATE public.documents
    SET
      processing_status = 'failed',
      processing_error  = 'Processing timed out — document was stuck in processing state for over 15 minutes. Retry using the Reprocess button.',
      updated_at        = now()
    WHERE
      processing_status = 'processing'
      AND updated_at < (now() - stuck_threshold)
    RETURNING id
  )
  SELECT count(*) INTO updated_count FROM updated;

  RETURN updated_count;
END;
$$;

-- Only the service role / postgres can call this (used by admin jobs or API routes)
REVOKE ALL ON FUNCTION public.mark_stuck_documents_failed(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_stuck_documents_failed(interval) TO service_role;

COMMENT ON FUNCTION public.mark_stuck_documents_failed(interval) IS
  'Resets documents stuck in processing state to failed. Call from a scheduled job or admin API. Returns count of rows affected.';

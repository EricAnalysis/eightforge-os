-- Phase 3 Step 2 remains shadow-only. These reason codes distinguish
-- content-quality scheduling decisions from decode/OCR execution failures.
ALTER TABLE public.extraction_processing_gaps
  DROP CONSTRAINT extraction_processing_gaps_reason_check;

ALTER TABLE public.extraction_processing_gaps
  ADD CONSTRAINT extraction_processing_gaps_reason_check CHECK (
    reason IN (
      'timeout', 'engine_failure', 'unsupported_size', 'unprocessed_region',
      'engine_conflict', 'missing_geometry', 'no_source_span', 'ambiguous_parse',
      'content_quality_skip', 'decode_failure', 'ocr_region_failure'
    )
  );

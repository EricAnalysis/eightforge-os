ALTER TABLE public.documents
  ADD CONSTRAINT documents_document_type_known_values_check
  CHECK (
    document_type IS NULL
    OR document_type IN (
      'contract',
      'williamson_contract',
      'price_sheet',
      'invoice',
      'report',
      'policy',
      'procedure',
      'specification',
      'transaction_data',
      'other',
      'payment_rec',
      'payment_recommendation',
      'ticket',
      'debris_ticket',
      'spreadsheet',
      'rate_sheet',
      'rate_schedule',
      'attachment',
      'permit',
      'disposal_checklist',
      'dms_checklist',
      'kickoff',
      'daily_ops',
      'ops_report'
    )
  ) NOT VALID;

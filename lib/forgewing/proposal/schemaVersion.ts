export const FORGEWING_PROPOSAL_SCHEMA_VERSION = 'forgewing-proposal-v1' as const;

/**
 * Table continuation is a distinct task contract. Keeping its version separate
 * preserves the accepted region-classification v1 wire format and lets readers
 * narrow by task before interpreting task-specific proposal fields.
 */
export const FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION =
  'forgewing-table-continuation-proposal-v1' as const;

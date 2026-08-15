export const FORGEWING_PROPOSAL_SCHEMA_VERSION = 'forgewing-proposal-v1' as const;

/**
 * Table continuation is a distinct task contract. Keeping its version separate
 * preserves the accepted region-classification v1 wire format and lets readers
 * narrow by task before interpreting task-specific proposal fields.
 */
export const FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION =
  'forgewing-table-continuation-proposal-v1' as const;

/**
 * Column mapping has its own wire contract so adding nested, partial mappings
 * cannot reinterpret accepted region or continuation artifacts.
 */
export const FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION =
  'forgewing-column-mapping-proposal-v1' as const;

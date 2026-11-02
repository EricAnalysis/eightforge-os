/** Forward deployment's decision hierarchy, lowest first. Move down only as far as necessary. */
export const FDE_LADDER_RUNGS = [
  'existing_capability',
  'customer_configuration',
  'mapping',
  'adapter',
  'reusable_deterministic_rule',
  'extraction_or_validator_improvement',
  'broad_product_change',
] as const;
export type FdeLadderRung = typeof FDE_LADDER_RUNGS[number];

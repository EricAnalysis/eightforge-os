import { hashCanonical } from '@/lib/extraction/domain/hash';

export const STEP0_INTERPRETER_MANIFEST_HASH = hashCanonical({
  name: 'step0-no-interpretation-v1',
  consumes_machine_facts: false,
  reason: 'step0_shadow_only',
});

export const STEP0_ENTITY_RESOLVER_VERSION = 'step0-entity-resolution-disabled';

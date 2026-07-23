import { hashCanonical } from '@/lib/extraction/domain/hash';
import type {
  CanonicalFactId,
  NonEmpty,
  NormalizedPrimitive,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';
import type { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';

const RULES = {
  'identity-primary-v1': {
    version: '1',
    selectPrimary: (fields: NonEmpty<VerifiedFieldHandle>) => fields[0],
  },
} as const;
const canonicalFactConstructorToken: unique symbol = Symbol('canonicalFactConstructorToken');

export type InterpretationRuleId = keyof typeof RULES;

export class CanonicalFact {
  private constructor(
    readonly id: CanonicalFactId,
    readonly provenance_class: 'machine_extraction',
    readonly key: string,
    readonly value: NormalizedPrimitive,
    readonly primary_verified_field_id: VerifiedFieldId,
    readonly supporting_verified_field_ids: readonly VerifiedFieldId[],
    readonly interpretation_rule: {
      readonly id: InterpretationRuleId;
      readonly version: string;
    },
    readonly created_at: string,
  ) {
    Object.freeze(this);
  }

  static createFromVerifiedFields(input: {
    readonly constructorToken: typeof canonicalFactConstructorToken;
    readonly key: string;
    readonly verifiedFields: NonEmpty<VerifiedFieldHandle>;
    readonly interpretationRuleId: InterpretationRuleId;
    readonly createdAt?: string;
  }): CanonicalFact {
    if (input.constructorToken !== canonicalFactConstructorToken) {
      throw new Error('CanonicalFact can only be created by the canonical factory.');
    }
    if (!input.key.trim()) throw new Error('Canonical fact key is required.');
    const rule = RULES[input.interpretationRuleId];
    if (!rule) throw new Error(`Unknown interpretation rule: ${input.interpretationRuleId}`);
    const primary = rule.selectPrimary(input.verifiedFields).field;
    const conflicting = input.verifiedFields.find(
      (handle) => hashCanonical(handle.field.normalized_value) !== hashCanonical(primary.normalized_value),
    );
    if (conflicting) {
      throw new Error('Verified fields disagree; emit an ambiguity record instead of a canonical fact.');
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const supporting = input.verifiedFields
      .slice(1)
      .map((handle) => handle.field.id);
    return new CanonicalFact(
      `cf_${hashCanonical({
        key: input.key,
        primary: primary.id,
        supporting,
        interpretation_rule_id: input.interpretationRuleId,
        interpretation_rule_version: rule.version,
      })}` as CanonicalFactId,
      'machine_extraction',
      input.key,
      primary.normalized_value,
      primary.id,
      supporting,
      {
        id: input.interpretationRuleId,
        version: rule.version,
      },
      createdAt,
    );
  }
}

export function createCanonicalFact(input: {
  readonly key: string;
  readonly verifiedFields: NonEmpty<VerifiedFieldHandle>;
  readonly interpretationRuleId: InterpretationRuleId;
  readonly createdAt?: string;
}): CanonicalFact {
  return CanonicalFact.createFromVerifiedFields({
    ...input,
    constructorToken: canonicalFactConstructorToken,
  });
}

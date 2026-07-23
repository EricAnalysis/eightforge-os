import type {
  CanonicalFactId,
  NonEmpty,
  NormalizedPrimitive,
  TransformationStep,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';

export type TruthDependency =
  | {
      readonly provenance_class: 'machine_extraction';
      readonly canonical_fact_id: CanonicalFactId;
    }
  | {
      readonly provenance_class: 'deterministic_derivation';
      readonly derived_fact_id: string;
    }
  | {
      readonly provenance_class: 'human_assertion';
      readonly human_assertion_id: string;
    };

export interface DerivedFact {
  readonly id: string;
  readonly provenance_class: 'deterministic_derivation';
  readonly key: string;
  readonly value: NormalizedPrimitive;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly input_dependencies: NonEmpty<TruthDependency>;
  readonly calculation_trace: readonly TransformationStep[];
  readonly created_at: string;
}
export interface HumanAssertion {
  readonly id: string;
  readonly provenance_class: 'human_assertion';
  readonly key: string;
  readonly asserted_value: NormalizedPrimitive | null;
  readonly target_machine_fact_id: CanonicalFactId | null;
  readonly target_verified_field_id: VerifiedFieldId | null;
  readonly source_binding: 'source_bound' | 'domain_assertion';
  readonly supersedes_assertion_id: string | null;
  readonly actor_id: string;
  readonly reason: string;
  readonly asserted_at: string;
  readonly status: 'active' | 'superseded' | 'needs_review';
}

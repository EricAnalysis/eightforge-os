import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DIAGNOSTIC_CODES } from '@/lib/diagnostics/failureDiagnostic';
import { UPLOAD_DOCUMENT_TYPES } from '@/lib/documentTypes';
import type { ResolutionCaseKind } from '@/lib/resolution/resolutionCases';
import { ORCHESTRATOR_ROOT_CAUSE_CATEGORIES } from '@/lib/shared/orchestratorTaxonomy';
import { RULE_CATALOGUE_FINGERPRINT_VERSION } from '@/lib/validator/ruleCatalogueFingerprint';
import { VALIDATOR_RULE_EXPLANATIONS, validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

/**
 * The content allowlist for Forgewing friction signals (B8.3a). Server-only.
 *
 * A friction signal is computed inside one organization, but it is the unit
 * that later leaves the tenant: it is persisted for platform triage (B8.3b/c)
 * and, once a person has triaged it, may reach the repository-plan provider
 * (B8.3d). So the platform-facing part of a signal is a structured payload of
 * allowlisted parts only:
 * - the signal kind;
 * - a code from a controlled vocabulary (diagnostic code, reason, case kind,
 *   catalogue rule ID, upload document type, or a fixed key);
 * - the rule catalogue fingerprint;
 * - counts;
 * - at most ten typed record references: a UUID, or a SHA-256 digest when the
 *   identifier is not a UUID (resolution case IDs embed anchors, so they are
 *   always digested);
 * - the root-cause category and, for semantics reviews, `undetermined`.
 *
 * Anything else (customer document-type labels, override reasons, operator
 * notes, source text, names) never enters a payload: a value outside a
 * vocabulary becomes a fixed sentinel, never the value itself. A signal's
 * summary, question and evidence links are rendered from the payload alone
 * (`renderFrictionSignalText`), so they can carry nothing the payload does not.
 */

export const FRICTION_SIGNAL_PAYLOAD_VERSION = 'friction_signal_v1' as const;
export const MAX_SIGNAL_RECORD_REFS = 10;

export const FRICTION_SIGNAL_KINDS = [
  'recurring_deterministic_failure',
  'recurring_manual_correction',
  'forgewing_rejected',
  'qualification_demand',
  'rule_semantics_review',
] as const;
export type FrictionSignalKind = (typeof FRICTION_SIGNAL_KINDS)[number];

const RESOLUTION_CASE_KINDS = [
  'validator_finding', 'unreadable_priced_line', 'reviewed_value_needs_rereview', 'recovery_proposal_pending',
  'withheld_priced_line', 'structure_review', 'review_required_value', 'coverage_gap', 'pricing_withheld',
  'category_review',
] as const satisfies readonly ResolutionCaseKind[];
// Compile-time: every case kind is in the vocabulary.
const caseKindsExhaustive: Exclude<ResolutionCaseKind, (typeof RESOLUTION_CASE_KINDS)[number]> extends never
  ? true : never = true;
void caseKindsExhaustive;

/** Fixed reasons `frictionReason` derives from a case kind. */
const FIXED_REASON_CODES = [
  'scanned_rate_requires_review', 'priced_line_on_unread_page', 'reviewed_value_held', 'recovery_proposal_pending',
  'category_unresolved',
] as const;

export const UNRECOGNIZED_REASON = 'unrecognized_reason' as const;
export const UNRECOGNIZED_RULE = 'unrecognized_rule' as const;
export const UNRECOGNIZED_DOCUMENT_TYPE = 'other' as const;
export const VALUE_READING_SIGNAL_CODE = 'priced_value_reading' as const;

const VALIDATOR_RULE_REASON_PREFIX = 'validator_rule:';

const REASON_CODES: ReadonlySet<string> = new Set<string>([
  ...DIAGNOSTIC_CODES, ...FIXED_REASON_CODES, ...RESOLUTION_CASE_KINDS, UNRECOGNIZED_REASON,
]);
/** Upload document types plus the system types the upload aliases resolve to. */
const SIGNAL_DOCUMENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...UPLOAD_DOCUMENT_TYPES, 'payment_recommendation', 'ticket', 'unknown',
]);

function isCatalogueRuleId(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATOR_RULE_EXPLANATIONS, value);
}

/** A reason in the vocabulary, or the sentinel. A `validator_rule:` reason keeps only catalogue rule IDs. */
export function allowlistReasonCode(reason: string): string {
  if (reason.startsWith(VALIDATOR_RULE_REASON_PREFIX)) {
    const ruleId = reason.slice(VALIDATOR_RULE_REASON_PREFIX.length);
    return isCatalogueRuleId(ruleId) ? reason : UNRECOGNIZED_REASON;
  }
  return REASON_CODES.has(reason) ? reason : UNRECOGNIZED_REASON;
}

/** An upload document type, or `other`. Customer-typed document types never pass. */
export function allowlistDocumentType(documentType: string | null | undefined): string {
  if (!documentType) return 'unknown';
  return SIGNAL_DOCUMENT_TYPES.has(documentType) ? documentType : UNRECOGNIZED_DOCUMENT_TYPE;
}

/** A catalogue rule ID, or the sentinel. */
export function allowlistRuleId(ruleId: string): string {
  return isCatalogueRuleId(ruleId) ? ruleId : UNRECOGNIZED_RULE;
}

export const SIGNAL_RECORD_TYPES = ['execution_item', 'human_fact_assertion', 'forgewing_proposal', 'resolution_case'] as const;
export type SignalRecordType = (typeof SIGNAL_RECORD_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RECORD_REF = new RegExp(
  `^(?:${SIGNAL_RECORD_TYPES.join('|')}):(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64})$`,
  'u',
);

/**
 * A typed record reference: the UUID itself, or `sha256:<digest>` of anything
 * else. Resolution case IDs embed document and anchor keys, so they are always
 * digested.
 */
export function allowlistRecordRef(type: SignalRecordType, id: string): string {
  const normalized = id.trim().toLowerCase();
  if (type !== 'resolution_case' && UUID.test(normalized)) return `${type}:${normalized}`;
  return `${type}:sha256:${createHash('sha256').update(id).digest('hex')}`;
}

const rootCauseKeys = ORCHESTRATOR_ROOT_CAUSE_CATEGORIES.map((category) => category.key) as
  [(typeof ORCHESTRATOR_ROOT_CAUSE_CATEGORIES)[number]['key'], ...(typeof ORCHESTRATOR_ROOT_CAUSE_CATEGORIES)[number]['key'][]];
const count = z.number().int().nonnegative();

function codeAllowedFor(kind: FrictionSignalKind, code: string): boolean {
  switch (kind) {
    case 'recurring_deterministic_failure':
      return allowlistReasonCode(code) === code;
    case 'recurring_manual_correction':
      return SIGNAL_DOCUMENT_TYPES.has(code);
    case 'forgewing_rejected':
    case 'qualification_demand':
      return code === VALUE_READING_SIGNAL_CODE;
    case 'rule_semantics_review':
      return code === UNRECOGNIZED_RULE || isCatalogueRuleId(code);
  }
}

export const AllowlistedFrictionSignalSchema = z.object({
  schemaVersion: z.literal(FRICTION_SIGNAL_PAYLOAD_VERSION),
  signalKind: z.enum(FRICTION_SIGNAL_KINDS),
  code: z.string().min(1).max(160),
  catalogueFingerprint: z.string()
    .regex(new RegExp(`^${RULE_CATALOGUE_FINGERPRINT_VERSION}:sha256:[0-9a-f]{64}$`, 'u')).nullable(),
  counts: z.object({ occurrences: count, documents: count, projects: count }).strict(),
  recordRefs: z.array(z.string().regex(RECORD_REF)).max(MAX_SIGNAL_RECORD_REFS),
  rootCauseCategory: z.enum(rootCauseKeys).nullable(),
  defectClass: z.literal('undetermined').nullable(),
}).strict().superRefine((payload, context) => {
  if (!codeAllowedFor(payload.signalKind, payload.code)) {
    context.addIssue({ code: 'custom', path: ['code'], message: 'code is not in the vocabulary for this signal kind' });
  }
  if ((payload.signalKind === 'rule_semantics_review') !== (payload.defectClass === 'undetermined')) {
    context.addIssue({ code: 'custom', path: ['defectClass'], message: 'only a semantics review carries a defect class' });
  }
  if (payload.signalKind !== 'rule_semantics_review' && payload.catalogueFingerprint !== null) {
    context.addIssue({ code: 'custom', path: ['catalogueFingerprint'], message: 'only a semantics review carries a fingerprint' });
  }
});
export type AllowlistedFrictionSignal = z.infer<typeof AllowlistedFrictionSignalSchema>;

/** Validates and freezes a payload; throws on anything outside the allowlist (a defect, never data). */
export function allowlistedFrictionSignal(payload: AllowlistedFrictionSignal): AllowlistedFrictionSignal {
  return Object.freeze(AllowlistedFrictionSignalSchema.parse(payload));
}

export type RenderedFrictionSignalText = Readonly<{
  summary: string;
  /** Null when the remedy is a policy or qualification decision, not a product change. */
  question: string | null;
  evidenceLinks: string;
}>;

const GENERIC_CLOSING = 'Identify the code path, whether the fix is configuration, mapping, a deterministic rule or a product change, '
  + 'the blast radius, and the smallest safe change with its regression tests. '
  + 'Do not propose document-, page- or customer-specific logic.';

/** Summary, question and evidence links, from the allowlisted payload and product constants only. */
export function renderFrictionSignalText(payload: AllowlistedFrictionSignal): RenderedFrictionSignalText {
  const { occurrences, documents, projects } = payload.counts;
  const seen = `Seen ${occurrences} times on ${documents} documents across ${projects} projects in one organization.`;
  const evidenceLinks = payload.recordRefs.join('\n');
  switch (payload.signalKind) {
    case 'recurring_deterministic_failure':
      return {
        summary: `EightForge could not settle "${payload.code}" on ${documents} documents.`,
        question: [`Forgewing friction signal (recurring_deterministic_failure): ${payload.code}.`,
          'The deterministic Core repeatedly could not settle this evidence and people had to.', seen, GENERIC_CLOSING].join(' '),
        evidenceLinks,
      };
    case 'recurring_manual_correction':
      return {
        summary: `Operators entered rate values by hand on ${documents} ${payload.code} documents.`,
        question: [`Forgewing friction signal (recurring_manual_correction): ${payload.code}.`,
          `Operators repeatedly typed reviewed rate values on ${payload.code} documents that extraction did not publish.`,
          seen, GENERIC_CLOSING].join(' '),
        evidenceLinks,
      };
    case 'forgewing_rejected':
      return {
        summary: `Operators rejected ${occurrences} Forgewing readings on ${documents} documents.`,
        question: [`Forgewing friction signal (forgewing_rejected): ${payload.code}.`,
          'Operators rejected Forgewing value readings; review the reading prompt, region and evidence binding.',
          seen, GENERIC_CLOSING].join(' '),
        evidenceLinks,
      };
    case 'qualification_demand':
      return {
        summary: `Operators asked for ${occurrences} Forgewing readings that deployment policy did not allow.`,
        // A qualification decision (benchmark, policy), never a code change.
        question: null,
        evidenceLinks,
      };
    case 'rule_semantics_review': {
      const title = validatorRuleExplanation(payload.code)?.title ?? 'not in the rule catalogue';
      return {
        summary: `Operators overrode "${payload.code}" findings ${occurrences} times on ${documents} distinct documents.`,
        question: [
          `Forgewing semantics review (rule_semantics_review): Validator rule ${payload.code} ("${title}").`,
          `Catalogue entry: ${payload.catalogueFingerprint ?? 'none'}.`,
          `Deficiency: recurring_override. Operators overrode ${occurrences} findings of this rule on ${documents}`,
          `distinct documents across ${projects} projects in one organization.`,
          'Defect class: undetermined. Classify it as a wording defect (the catalogue explanation or action is incomplete,',
          'stale or misleading) or a rule-logic defect (the rule fires when it should not). Then identify the smallest safe',
          'change and its regression tests. This signal is advisory: it changes no rule, catalogue entry, severity or action;',
          'any change goes through code, tests, PR and CI. Known limitation: execution items do not record which catalogue',
          'entry an operator saw, so overrides recorded before a catalogue change are still counted.',
        ].join(' '),
        evidenceLinks,
      };
    }
  }
}

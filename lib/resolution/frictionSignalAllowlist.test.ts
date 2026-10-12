import { describe, expect, it } from 'vitest';

import { buildFrictionReport, orchestratorPrefillHref } from '@/lib/resolution/frictionReport';
import {
  allowlistDocumentType,
  AllowlistedFrictionSignalSchema,
  allowlistReasonCode,
  allowlistRecordRef,
  allowlistRuleId,
  renderFrictionSignalText,
  UNRECOGNIZED_REASON,
  UNRECOGNIZED_RULE,
  type AllowlistedFrictionSignal,
} from '@/lib/resolution/frictionSignalAllowlist';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { ruleCatalogueFingerprint } from '@/lib/validator/ruleCatalogueFingerprint';

/** B8.3a: only allowlisted parts reach a friction signal. Synthetic records only. */

const ORG = 'org-1';
const SECRET = 'ZZSECRET';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function resolutionCase(overrides: Partial<ResolutionCase> & { code?: string }): ResolutionCase {
  const { code, ...rest } = overrides;
  return {
    caseId: `withheld:${rest.documentId ?? 'd'}:${SECRET} anchor`, kind: 'withheld_priced_line', tier: 'missing_authoritative_value',
    exposureAmount: null, projectId: 'p1', documentId: 'd1', physicalPageNumber: 2, title: `${SECRET} title`,
    problem: `${SECRET} problem`, finding: null, previousReviews: [], deterministicState: `${SECRET} state`,
    originalSourceText: `${SECRET} source text`, rootCauseKey: `${SECRET}`, evidence: [], suggestions: [], actions: [],
    sourceRefs: {},
    ...(code ? { diagnostic: { code: code as never, attention: 'resolution_case', recoverability: 'not_recoverable', recoveryType: null } } : {}),
    ...rest,
  } as ResolutionCase;
}

function assertion(id: string, documentId: string) {
  return { id, organization_id: ORG, source_document_id: documentId, fact_key: 'contract_rate_row',
    asserted_value: { description: SECRET }, source_binding: 'region_bound', supersedes_assertion_id: null, actor_id: 'op',
    reason: `${SECRET} operator reason`, asserted_at: 't', status: 'active', source_artifact_id: null, physical_page_number: 2,
    source_region: null, page_representation_digest: null, parser_version: null, source_observation_ids: [],
    original_source_text: `${SECRET} cell`, anchor_key: `${SECRET} anchor`, review_origin: 'operator_entered',
    forgewing_proposal_id: null } as never;
}

describe('friction signal content allowlist (B8.3a)', () => {
  it('lets no customer-controlled value reach any signal, payload or prefill link', () => {
    // Every customer-controllable input carries the sentinel: document-type labels, case IDs and anchors,
    // diagnostic codes and rule IDs outside the vocabularies, record IDs, reasons, notes and source text.
    const report = buildFrictionReport({
      organizationId: ORG,
      documentTypeById: new Map([['d1', `${SECRET}_billing_packet`], ['d2', `${SECRET}_billing_packet`], ['d3', 'contract']]),
      projects: [{ projectId: 'p1', cases: [
        resolutionCase({ documentId: 'd1', code: `${SECRET}_code` }),
        resolutionCase({ documentId: 'd2', code: `${SECRET}_code` }),
        resolutionCase({ documentId: 'd1', code: 'inconsistent_row_pitch' }),
        resolutionCase({ documentId: 'd2', code: 'inconsistent_row_pitch' }),
        resolutionCase({ documentId: 'd1', kind: 'validator_finding',
          finding: { ruleId: `${SECRET}_RULE` } as never }),
        resolutionCase({ documentId: 'd2', kind: 'validator_finding',
          finding: { ruleId: `${SECRET}_RULE` } as never }),
      ] }],
      assertions: [assertion(`${SECRET}-a1`, 'd1'), assertion(uuid(2), 'd2')],
      telemetry: [
        { outcome: 'forgewing_rejected', documentId: 'd1', anchorKey: SECRET, at: 't', assertionId: null,
          proposalId: `${SECRET}-proposal`, reviewId: null },
        { outcome: 'forgewing_rejected', documentId: 'd2', anchorKey: SECRET, at: 't', assertionId: null,
          proposalId: uuid(7), reviewId: null },
      ] as never,
      outcomes: [{ outcomeCode: 'activation_not_allowed', documentId: 'd1' }],
      overrides: [
        { organizationId: ORG, projectId: 'p1', executionItemId: `${SECRET}-e1`, findingId: 'f1', ruleId: `${SECRET}_RULE`, documentIds: ['d1'] },
        { organizationId: ORG, projectId: 'p1', executionItemId: uuid(9), findingId: 'f2', ruleId: `${SECRET}_RULE`, documentIds: ['d2'] },
      ],
    });

    const kinds = report.signals.map((signal) => signal.signalId).sort();
    expect(kinds).toEqual([
      'forgewing_rejected:priced_value_reading',
      'qualification_demand:priced_value_reading',
      'recurring_deterministic_failure:inconsistent_row_pitch',
      `recurring_deterministic_failure:${UNRECOGNIZED_REASON}`,
      'recurring_manual_correction:other',
      `rule_semantics_review:${UNRECOGNIZED_RULE}`,
    ]);
    const platformFacing = JSON.stringify(report.signals.map((signal) => ({
      ...signal, href: signal.orchestratorPrefill ? orchestratorPrefillHref(signal.orchestratorPrefill) : null,
    })));
    expect(platformFacing.toLowerCase()).not.toContain(SECRET.toLowerCase());
    for (const signal of report.signals) {
      expect(AllowlistedFrictionSignalSchema.safeParse(signal.payload).success, signal.signalId).toBe(true);
      // Text is rendered from the payload alone.
      const text = renderFrictionSignalText(signal.payload);
      expect(signal.summary).toBe(text.summary);
      expect(signal.orchestratorPrefill?.question ?? null).toBe(text.question);
      expect(signal.orchestratorPrefill?.evidenceLinks ?? text.evidenceLinks).toBe(text.evidenceLinks);
    }
    // The tenant-local breakdown keeps the raw label for the organization's own users.
    expect(report.byDocumentType.map((entry) => entry.key)).toContain(`${SECRET}_billing_packet`);
  });

  it('keeps vocabulary codes and maps everything else to a fixed sentinel', () => {
    expect(allowlistReasonCode('inconsistent_row_pitch')).toBe('inconsistent_row_pitch');
    expect(allowlistReasonCode('scanned_rate_requires_review')).toBe('scanned_rate_requires_review');
    expect(allowlistReasonCode('coverage_gap')).toBe('coverage_gap');
    expect(allowlistReasonCode('validator_rule:FINANCIAL_NTE_EXCEEDED')).toBe('validator_rule:FINANCIAL_NTE_EXCEEDED');
    expect(allowlistReasonCode('validator_rule:ACME_RULE')).toBe(UNRECOGNIZED_REASON);
    expect(allowlistReasonCode('Acme billing packet')).toBe(UNRECOGNIZED_REASON);
    expect(allowlistDocumentType('invoice')).toBe('invoice');
    expect(allowlistDocumentType('payment_recommendation')).toBe('payment_recommendation');
    expect(allowlistDocumentType('acme_billing_packet')).toBe('other');
    expect(allowlistDocumentType(null)).toBe('unknown');
    expect(allowlistRuleId('SOURCES_REFERENCED_AMENDMENT_MISSING')).toBe('SOURCES_REFERENCED_AMENDMENT_MISSING');
    expect(allowlistRuleId('ACME_RULE')).toBe(UNRECOGNIZED_RULE);
  });

  it('keeps UUID record references and digests everything else, always digesting case IDs', () => {
    expect(allowlistRecordRef('execution_item', uuid(1))).toBe(`execution_item:${uuid(1)}`);
    expect(allowlistRecordRef('human_fact_assertion', uuid(1).toUpperCase())).toBe(`human_fact_assertion:${uuid(1)}`);
    expect(allowlistRecordRef('execution_item', 'acme-e1')).toMatch(/^execution_item:sha256:[0-9a-f]{64}$/u);
    expect(allowlistRecordRef('resolution_case', uuid(1))).toMatch(/^resolution_case:sha256:[0-9a-f]{64}$/u);
    expect(allowlistRecordRef('resolution_case', 'withheld:d1:Acme anchor'))
      .toBe(allowlistRecordRef('resolution_case', 'withheld:d1:Acme anchor'));
  });

  it('rejects any payload outside the allowlist', () => {
    const valid: AllowlistedFrictionSignal = {
      schemaVersion: 'friction_signal_v1', signalKind: 'rule_semantics_review', code: 'FINANCIAL_NTE_EXCEEDED',
      catalogueFingerprint: ruleCatalogueFingerprint('FINANCIAL_NTE_EXCEEDED'),
      counts: { occurrences: 3, documents: 2, projects: 1 }, recordRefs: [`execution_item:${uuid(1)}`],
      rootCauseCategory: 'validation_rule_issue', defectClass: 'undetermined',
    };
    expect(AllowlistedFrictionSignalSchema.safeParse(valid).success).toBe(true);
    const rejected = (patch: Record<string, unknown>) => AllowlistedFrictionSignalSchema.safeParse({ ...valid, ...patch }).success;
    expect(rejected({ note: 'Acme' })).toBe(false);
    expect(rejected({ code: 'ACME_RULE' })).toBe(false);
    expect(rejected({ signalKind: 'recurring_manual_correction', code: 'acme_billing_packet', catalogueFingerprint: null, defectClass: null })).toBe(false);
    expect(rejected({ recordRefs: ['execution_item:acme-e1'] })).toBe(false);
    expect(rejected({ recordRefs: Array.from({ length: 11 }, (_, n) => `execution_item:${uuid(n)}`) })).toBe(false);
    expect(rejected({ catalogueFingerprint: 'acme' })).toBe(false);
    expect(rejected({ rootCauseCategory: 'acme' })).toBe(false);
    expect(rejected({ signalKind: 'forgewing_rejected', code: 'priced_value_reading', defectClass: 'undetermined',
      catalogueFingerprint: null })).toBe(false);
    expect(rejected({ counts: { occurrences: -1, documents: 2, projects: 1 } })).toBe(false);
  });
});

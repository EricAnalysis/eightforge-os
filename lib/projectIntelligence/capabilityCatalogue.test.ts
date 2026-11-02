import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_CATALOGUE_VERSION,
  capabilityCatalogueIdentity,
  matchCapability,
} from '@/lib/projectIntelligence/capabilityCatalogue';
import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

const matched = (classification: string, text: string) => matchCapability({ classification, text })?.capabilityId ?? null;

describe('the capability catalogue', () => {
  it('has a stable version and identity', () => {
    expect(CAPABILITY_CATALOGUE_VERSION).toBe('fde_capability_catalogue_v1');
    expect(capabilityCatalogueIdentity()).toBe('60678c93fb33f284f92bcd892d4b4dd9409effbe18e38aa06b7fe17b05281bf2');
    expect(capabilityCatalogueIdentity()).toBe(capabilityCatalogueIdentity());
  });

  it('gives every capability a unique id', () => {
    const ids = CAPABILITY_CATALOGUE.map((entry) => entry.capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CAPABILITY_CATALOGUE.map((entry) => [entry.capabilityId, entry] as const))('%s points at code that exists', (_id, entry) => {
    expect(entry.deterministicComponents.length).toBeGreaterThan(0);
    for (const path of entry.deterministicComponents) expect(existsSync(path), path).toBe(true);
    for (const rule of entry.ruleIds) expect(validatorRuleExplanation(rule), rule).not.toBeNull();
  });

  it('claims nothing it cannot be matched to deliberately', () => {
    // An entry that covers a whole kind is only ever advisory: explaining decides nothing.
    for (const entry of CAPABILITY_CATALOGUE.filter((item) => item.matchTerms === null)) {
      expect(entry.stepKinds).toEqual(['ADVISORY']);
    }
    // Anything needing configuration or activation says what.
    for (const entry of CAPABILITY_CATALOGUE.filter((item) => item.status !== 'supported')) {
      expect(entry.configurationRequirements.length).toBeGreaterThan(0);
    }
  });

  it('does not offer the model explanation as supported', () => {
    expect(CAPABILITY_CATALOGUE.find((entry) => entry.capabilityId === 'model_explanation')?.status).toBe('requires_owner_activation');
    expect(CAPABILITY_CATALOGUE.find((entry) => entry.capabilityId === 'project_intelligence_guidance')?.knownLimitations.join(' ')).toContain('not qualified');
  });
});

describe('matching a step', () => {
  it.each([
    ['EXTRACT', 'Read the vendor contract PDF', 'document_text_extraction'],
    ['EXTRACT', 'Pull the rate schedule', 'contract_rate_extraction'],
    ['EXTRACT', 'Load the weekly workbook', 'spreadsheet_transaction_extraction'],
    ['VERIFY', 'Find which document governs after an amendment', 'document_precedence'],
    ['VERIFY', 'Confirm the billed rate is in the contract', 'validator_contract_invoice_rules'],
    ['RULE', 'Flag duplicate tickets', 'transaction_ticket_review'],
    ['RULE', 'Confirm the linked documents', 'relationship_review'],
    ['VERIFY', 'Send it to the review queue', 'operator_review_surfaces'],
    ['ADVISORY', 'Tell the operator what to do next', 'project_intelligence_guidance'],
    ['ADVISORY', 'Offer an AI explanation', 'model_explanation'],
    ['ADVISORY', 'Help someone find a record', 'ask_project'],
    ['EXTRACT', 'Read the custom column names', 'customer_header_mapping'],
  ])('%s "%s" resolves to %s', (classification, text, expected) => {
    expect(matched(classification, text)).toBe(expected);
  });

  it.each([
    ['VERIFY', 'Close the customer support ticket'],
    ['RULE', 'Reconcile the bank statement'],
    ['EXTRACT', 'Read the bank statement'],
    ['EXTRACT', 'Read the payroll system'],
    ['VERIFY', 'Compare the mapdf archive'],
  ])('claims nothing for %s "%s"', (classification, text) => {
    expect(matched(classification, text)).toBeNull();
  });

  it('never offers a capability for a step kind it does not cover', () => {
    expect(matched('HUMAN', 'Approve the billed rate')).toBeNull();
    expect(matched('RECOVER', 'Recover the rate schedule')).toBeNull();
    expect(matched('EXTRACT', 'Check the billed rate')).toBeNull();
  });

  it('takes the lower rung when two capabilities match', () => {
    expect(matched('EXTRACT', 'Read the spreadsheet with custom columns')).toBe('spreadsheet_transaction_extraction');
  });

  it('prefers a named capability over one that covers the whole kind', () => {
    expect(matched('ADVISORY', 'Explain the next step')).toBe('project_intelligence_guidance');
  });
});

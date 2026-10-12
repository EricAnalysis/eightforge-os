import { describe, expect, it } from 'vitest';

import {
  MAX_EVIDENCE_LOCATIONS,
  REFERENCED_AMENDMENT_MISSING_RULE_ID,
  runDocumentReferenceRules,
} from '@/lib/validator/rulePacks/documentReferences';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import type { ProjectValidatorInput } from '@/lib/validator/shared';

/** B7.1 referenced-but-missing amendments. Synthetic documents and text only. */

type Doc = { id: string; title?: string | null; name?: string; role?: string };

function input(params: {
  documents: Doc[];
  contract?: string[];
  invoice?: string[];
  tickets?: string[];
  pages: Record<string, Array<[number, string]>>;
  relationships?: Array<{ source: string; target: string; type: string }>;
  ruleDisabled?: boolean;
}): ProjectValidatorInput {
  return {
    project: { id: 'p1', organization_id: 'o1', name: 'P', code: 'P' },
    documents: params.documents.map((document) => ({
      id: document.id, project_id: 'p1', organization_id: 'o1', title: document.title ?? null,
      name: document.name ?? `${document.id}.pdf`, document_type: null, created_at: '2026-01-01',
    })),
    precedenceFamilies: [{
      family: 'contract', label: 'Contract', governing_document_id: null, governing_reason: null,
      governing_reason_detail: null, has_operator_override: false, considered_document_ids: [],
      documents: params.documents.filter((document) => document.role).map((document) => ({
        id: document.id, resolved_role: document.role, resolved_subtype: document.role === 'contract_amendment' ? 'amendment' : 'base_contract',
      })),
    }],
    documentRelationships: (params.relationships ?? []).map((relationship) => ({
      project_id: 'p1', source_document_id: relationship.source, target_document_id: relationship.target,
      relationship_type: relationship.type,
    })),
    familyDocumentIds: { contract: params.contract ?? [], rate_sheet: [], permit: [], invoice: params.invoice ?? [],
      ticket_support: params.tickets ?? [] },
    governingDocumentIds: { contract: [], rate_sheet: [], permit: [], invoice: [], ticket_support: [] },
    truthCategoryDocumentIds: { contract_identity: [], pricing: [], compliance: [], amendments: [] },
    ruleStateByRuleId: new Map(params.ruleDisabled
      ? [[REFERENCED_AMENDMENT_MISSING_RULE_ID, { enabled: false, muted_until: null }]] : []),
    documentPageText: new Map(Object.entries(params.pages).map(([documentId, pages]) =>
      [documentId, pages.map(([page, text]) => ({ page, text }))])),
  } as unknown as ProjectValidatorInput;
}

const run = (params: Parameters<typeof input>[0]) => runDocumentReferenceRules(input(params));

describe('SOURCES_REFERENCED_AMENDMENT_MISSING (B7.1)', () => {
  it('raises one advisory warning per missing referenced amendment, with deterministic page evidence', () => {
    const findings = run({
      documents: [{ id: 'contract', role: 'base_contract' }, { id: 'invoice' }],
      contract: ['contract'], invoice: ['invoice'],
      pages: {
        invoice: [[2, 'Billed under Amendment No. 3.']],
        contract: [[5, 'as amended by Amendment No. 3'], [1, 'See Amendment #3 and Amendment No. 3 again.']],
      },
    });
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toMatchObject({
      rule_id: REFERENCED_AMENDMENT_MISSING_RULE_ID, category: 'required_sources', severity: 'warning',
      check_key: `${REFERENCED_AMENDMENT_MISSING_RULE_ID}:p1:amendment:3`, action_eligible: true, decision_eligible: false,
    });
    // One location per page, ordered by document then page.
    expect(finding!.evidence.map((entry) => [entry.source_document_id, entry.source_page])).toEqual([
      ['contract', 1], ['contract', 5], ['invoice', 2],
    ]);
    expect(finding!.actual).toBe('not found; referenced on 3 pages in 2 documents');
    // Advisory: never changes the approval gate.
    expect(normalizeValidationFinding(finding!).approval_gate_effect).toBe('informational');
  });

  it('is satisfied only by an amendment document identified with that number, or an amends relationship', () => {
    const pages = { contract: [[1, 'Amendment No. 2 and Amendment No. 3 apply.']] as Array<[number, string]> };
    // Resolved amendment identified by title.
    expect(run({ documents: [{ id: 'contract', role: 'base_contract' }, { id: 'a2', title: 'Amendment No. 2', role: 'contract_amendment' }],
      contract: ['contract'], pages }).map((finding) => finding.subject_id)).toEqual(['p1:amendment:3']);
    // Identified by file name, linked only by an amends relationship.
    expect(run({ documents: [{ id: 'contract', role: 'base_contract' }, { id: 'a3', name: 'Amendment_3.pdf' },
      { id: 'a2', title: 'Second Amendment', role: 'contract_amendment' }],
    contract: ['contract'], pages, relationships: [{ source: 'a3', target: 'contract', type: 'amends' }] })).toEqual([]);
    // A document titled "Amendment No. 3" that is neither an amendment nor amends anything does not satisfy it.
    expect(run({ documents: [{ id: 'contract', role: 'base_contract' }, { id: 'x', title: 'Amendment No. 3 cover letter' },
      { id: 'a2', title: 'Amendment 2', role: 'contract_amendment' }],
    contract: ['contract'], pages }).map((finding) => finding.subject_id)).toEqual(['p1:amendment:3']);
  });

  it('ignores a document\'s references to itself, and catches earlier amendments it cites', () => {
    const findings = run({
      documents: [{ id: 'contract', role: 'base_contract' }, { id: 'a3', title: 'Amendment No. 3', role: 'contract_amendment' }],
      contract: ['contract', 'a3'],
      pages: { a3: [[1, 'This Amendment No. 3 amends the Agreement as amended by Amendment Nos. 1 and 2.']] },
    });
    expect(findings.map((finding) => finding.subject_id)).toEqual(['p1:amendment:1', 'p1:amendment:2']);
  });

  it('scans contract-family documents and invoices only, never tickets', () => {
    expect(run({ documents: [{ id: 'tickets' }], tickets: ['tickets'],
      pages: { tickets: [[1, 'Work under Amendment No. 4']] } })).toEqual([]);
  });

  it('ignores unnumbered boilerplate and caps evidence at ten locations', () => {
    expect(run({ documents: [{ id: 'contract' }], contract: ['contract'],
      pages: { contract: [[1, 'This contract may be amended from time to time, as amended.']] } })).toEqual([]);
    const pages = Array.from({ length: 14 }, (_, index) => [index + 1, 'Per Amendment No. 5.'] as [number, string]);
    const [finding] = run({ documents: [{ id: 'contract' }], contract: ['contract'], pages: { contract: pages } });
    expect(finding!.evidence).toHaveLength(MAX_EVIDENCE_LOCATIONS);
    expect(finding!.evidence.map((entry) => entry.source_page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(finding!.actual).toBe('not found; referenced on 14 pages in 1 document');
  });

  it('respects a disabled rule and an execution with no page text', () => {
    const params = { documents: [{ id: 'contract' }], contract: ['contract'],
      pages: { contract: [[1, 'Amendment No. 6']] as Array<[number, string]> } };
    expect(run({ ...params, ruleDisabled: true })).toEqual([]);
    expect(run({ ...params, pages: {} })).toEqual([]);
  });
});

describe('buildDocumentPageText (B7.1)', () => {
  it('reads persisted evidence_v1 page text, skipping unpaged or empty pages', async () => {
    const { buildDocumentPageText } = await import('@/lib/validator/projectValidator');
    const pageText = buildDocumentPageText(new Map([
      ['d1', { document_id: 'd1', data: { extraction: { evidence_v1: { page_text: [
        { page_number: 1, text: 'Amendment No. 2' }, { page_number: null, text: 'unpaged' }, { page_number: 2, text: '   ' },
      ] } } } }],
      ['d2', { document_id: 'd2', data: { extraction: {} } }],
    ]));
    expect([...pageText.entries()]).toEqual([['d1', [{ page: 1, text: 'Amendment No. 2' }]]]);
  });
});

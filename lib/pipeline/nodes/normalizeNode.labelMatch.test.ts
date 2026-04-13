import { describe, expect, it } from 'vitest';

import type { EvidenceObject } from '@/lib/extraction/types';
import { __test__ } from '@/lib/pipeline/nodes/normalizeNode';

function makeEvidence(label: string): EvidenceObject {
  return {
    id: `ev:${label}`,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: 'doc-1',
    description: label,
    text: label,
    location: { page: 1, label },
    confidence: 0.9,
    weak: false,
  };
}

function makeDocument(evidence: EvidenceObject[]): Parameters<typeof __test__.findEvidenceByLabel>[0] {
  return {
    evidence,
  } as Parameters<typeof __test__.findEvidenceByLabel>[0];
}

describe('normalizeNode label evidence matching', () => {
  it('does not match loose inner-word substrings such as rate inside moderate', () => {
    const matches = __test__.findEvidenceByLabel(
      makeDocument([makeEvidence('Moderate debris response level')]),
      ['rate'],
    );

    expect(matches).toEqual([]);
    expect(__test__.labelMatchesCandidate('Moderate debris response level', 'rate')).toBe(false);
  });

  it('still matches exact and near-exact tokenized labels', () => {
    const document = makeDocument([
      makeEvidence('Unit Rate'),
      makeEvidence('Invoice #: 4451'),
      makeEvidence('Scope narrative'),
    ]);

    expect(__test__.findEvidenceByLabel(document, ['rate']).map((evidence) => evidence.id)).toEqual([
      'ev:Unit Rate',
    ]);
    expect(
      __test__.findEvidenceByLabel(document, ['invoice', 'invoice #', 'invoice number'])
        .map((evidence) => evidence.id),
    ).toEqual(['ev:Invoice #: 4451']);
    expect(__test__.labelMatchesCandidate('Contractor Name', 'contractor')).toBe(true);
  });
});

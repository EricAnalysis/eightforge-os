import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  collectValueNeedles,
  findEvidenceByValueMatch,
  hasInspectableValue,
} from './evidenceValueMatch';
import type { EvidenceObject } from '@/lib/extraction/types';

function textEvidence(
  id: string,
  documentId: string,
  page: number,
  text: string,
): EvidenceObject {
  return {
    id,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: documentId,
    description: text,
    text,
    location: { page },
    confidence: 0.9,
    weak: false,
  };
}

describe('evidenceValueMatch', () => {
  it('collects needles for currency and plain numbers', () => {
    const needles = collectValueNeedles(2500000);
    assert.ok(needles.some((n) => n.includes('2,500,000') || n.includes('2500000')));
  });

  it('finds evidence by substring of string value', () => {
    const ev = textEvidence('e1', 'doc', 1, 'Contractor: Acme Debris LLC for storm work');
    const hits = findEvidenceByValueMatch([ev], 'Acme Debris LLC');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, 'e1');
  });

  it('skips boolean values', () => {
    const ev = textEvidence('e1', 'doc', 1, 'false alarm');
    assert.equal(findEvidenceByValueMatch([ev], false).length, 0);
  });

  it('reports inspectable string and number, not bare boolean', () => {
    assert.equal(hasInspectableValue('x'), true);
    assert.equal(hasInspectableValue(12), true);
    assert.equal(hasInspectableValue(false), false);
  });
});

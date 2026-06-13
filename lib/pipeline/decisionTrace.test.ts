import { describe, expect, it } from 'vitest';
import type { PipelineDecision } from '@/lib/pipeline/types';
import { finalizePipelineDecision } from '@/lib/pipeline/nodes/decisionNode';

describe('decision trace integrity', () => {
  it('fills source_refs from evidence_objects when missing', () => {
    const out = finalizePipelineDecision({
      id: 'd1',
      family: 'missing',
      severity: 'warning',
      title: 'Test',
      detail: 'Detail line.',
      confidence: 0.7,
      fact_refs: [],
      evidence_objects: [
        {
          id: 'cell:a:1',
          kind: 'sheet_cell',
          source_type: 'xlsx',
          source_document_id: 'x',
          description: 'd',
          location: { sheet: 'S', row: 1 },
          confidence: 0.9,
          weak: false,
        },
      ],
      missing_source_context: ['Gap one'],
      source_refs: [],
    });
    expect(out.source_refs).toEqual(['cell:a:1']);
    expect(out.reason).toContain('cell:a:1');
    expect(out.reason).toContain('Gap one');
  });

  it('preserves explicit reason while syncing source_refs', () => {
    const base: PipelineDecision = {
      id: 'd2',
      family: 'risk',
      severity: 'warning',
      title: 'R',
      detail: 'D',
      reason: 'Custom operator-facing rationale.',
      confidence: 0.5,
      fact_refs: [],
      evidence_objects: [
        {
          id: 'e1',
          kind: 'text',
          source_type: 'pdf',
          source_document_id: 'x',
          description: '',
          location: {},
          confidence: 1,
          weak: false,
        },
      ],
      missing_source_context: [],
      source_refs: [],
    };
    const out = finalizePipelineDecision(base);
    expect(out.reason).toBe('Custom operator-facing rationale.');
    expect(out.source_refs).toEqual(['e1']);
  });
});

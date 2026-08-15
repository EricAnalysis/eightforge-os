import { describe, expect, it } from 'vitest';

import { parseColumnMappingModelOutput } from '@/lib/forgewing/runtime/structuredOutput';

const mapped = (columnId: string, columnIndex: number, role: 'description' | 'rate') => ({
  columnId,
  columnIndex,
  state: 'inferred',
  proposedRole: role,
  confidence: 0.75,
  rationaleCodes: ['header_semantics'],
  evidenceIds: [`cell-${columnIndex}`],
});

describe('Forgewing column-mapping structured output', () => {
  it('accepts bounded partial resolved and insufficient mappings', () => {
    const parsed = parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [
        mapped('mapping-0', 0, 'description'),
        mapped('mapping-1', 1, 'rate'),
        {
          columnId: 'mapping-2',
          columnIndex: 2,
          state: 'insufficient_evidence',
          confidence: null,
          rationaleCodes: ['insufficient_structure'],
          evidenceIds: [],
          missingEvidence: ['missing_column_context'],
        },
      ],
    }));
    expect(parsed.columnMappings).toHaveLength(3);
  });

  it('accepts ambiguity without forcing a winner', () => {
    expect(parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [{
        columnId: 'mapping-1',
        columnIndex: 1,
        state: 'ambiguous',
        candidateRoles: ['rate', 'extension'],
        confidence: null,
        rationaleCodes: ['mixed_evidence'],
        evidenceIds: ['cell-a', 'cell-b'],
      }],
    })).columnMappings[0]?.state).toBe('ambiguous');
  });

  it('rejects other as a confident role, duplicate identity, and state leakage', () => {
    expect(() => parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [{ ...mapped('mapping-0', 0, 'rate'), proposedRole: 'other' }],
    }))).toThrow('model_schema_rejected');
    expect(() => parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [
        mapped('mapping-0', 0, 'rate'),
        mapped('mapping-0', 1, 'description'),
      ],
    }))).toThrow('model_schema_rejected');
    expect(() => parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [{
        ...mapped('mapping-0', 0, 'rate'),
        candidateRoles: ['extension'],
      }],
    }))).toThrow('model_schema_rejected');
  });

  it('rejects unknown evidence shape and raw prose', () => {
    expect(() => parseColumnMappingModelOutput(JSON.stringify({
      columnMappings: [{
        ...mapped('mapping-0', 0, 'rate'),
        evidenceIds: ['cell-0', 'cell-0'],
      }],
    }))).toThrow('model_schema_rejected');
    expect(() => parseColumnMappingModelOutput('```json\n{}\n```'))
      .toThrow('invalid_model_json');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildTableCellGeometry,
  geometryDiagnostics,
  groupCellsByPageAndRow,
  hasHorizontalGeometry,
  hasVerticalGeometry,
  samePageRowCandidate,
  type GeometryCellRef,
} from './tableGeometry';

describe('table geometry provenance helpers', () => {
  it('builds cell geometry with horizontal bounds and explicit missing y diagnostics', () => {
    const geometry = buildTableCellGeometry({
      page_number: 2,
      table_id: 'pdf:table:p2:t3',
      row_id: 'pdf:table:p2:t3:r1',
      row_index: 1,
      cell_index: 3,
      text: '$27.00',
      x_min: 620,
      x_max: 690,
      source_type: 'ocr_fallback',
    });

    assert.equal(hasHorizontalGeometry(geometry), true);
    assert.equal(hasVerticalGeometry(geometry), false);
    assert.equal(geometry.width, 70);
    assert.deepEqual(geometry.diagnostics, [
      'missing_y_bounds',
      'insufficient_geometry_for_same_cell',
    ]);
  });

  it('does not overclaim same-cell certainty without vertical bounds', () => {
    const left = buildTableCellGeometry({
      page_number: 2,
      table_id: 'pdf:table:p2:t3',
      row_index: 1,
      cell_index: 0,
      x_min: 100,
      x_max: 220,
    });
    const right = buildTableCellGeometry({
      page_number: 2,
      table_id: 'pdf:table:p2:t3',
      row_index: 1,
      cell_index: 0,
      x_min: 110,
      x_max: 230,
    });

    const result = samePageRowCandidate(left, right);
    assert.equal(result.candidate, true);
    assert.equal(result.confidence, 0.45);
    assert.ok(result.diagnostics.includes('missing_y_bounds'));
    assert.ok(result.diagnostics.includes('row_index_only_match'));
  });

  it('groups synthetic cells by page, table, and row identity', () => {
    const cells: GeometryCellRef[] = [
      { text: 'CY', geometry: buildTableCellGeometry({ page_number: 2, table_id: 't1', row_index: 1, cell_index: 1, x_min: 300, x_max: 340 }) },
      { text: '$27.00', geometry: buildTableCellGeometry({ page_number: 2, table_id: 't1', row_index: 1, cell_index: 3, x_min: 620, x_max: 690 }) },
      { text: 'Loading and Hauling Vegetative Debris', geometry: buildTableCellGeometry({ page_number: 2, table_id: 't1', row_index: 1, cell_index: 0, x_min: 80, x_max: 260 }) },
      { text: 'ROW to DMS', geometry: buildTableCellGeometry({ page_number: 2, table_id: 't1', row_index: 1, cell_index: 2, x_min: 390, x_max: 530 }) },
    ];

    const [candidate] = groupCellsByPageAndRow(cells);
    assert.equal(candidate?.page_number, 2);
    assert.equal(candidate?.row_index, 1);
    assert.deepEqual(candidate?.cells.map((cell) => cell.text), [
      'Loading and Hauling Vegetative Debris',
      'CY',
      'ROW to DMS',
      '$27.00',
    ]);
    assert.ok(candidate?.diagnostics.includes('missing_y_bounds'));
  });

  it('represents a Goodlettsville-style row with partial geometry diagnostics', () => {
    const row = ['Loading and Hauling Vegetative Debris', 'CY', 'ROW to DMS', '$27.00']
      .map((text, index): GeometryCellRef => ({
        text,
        geometry: buildTableCellGeometry({
          page_number: 2,
          table_id: 'pdf:table:p2:t3',
          row_id: 'pdf:table:p2:t3:r1',
          row_index: 1,
          cell_index: index,
          text,
          x_min: 100 + index * 160,
          x_max: 220 + index * 160,
          source_type: 'ocr_fallback',
        }),
      }));

    const [candidate] = groupCellsByPageAndRow(row);
    assert.equal(candidate?.cells.length, 4);
    assert.equal(candidate?.confidence, 0.45);
    assert.deepEqual(geometryDiagnostics(row[0]!.geometry), [
      'missing_y_bounds',
      'insufficient_geometry_for_same_cell',
    ]);
  });
});

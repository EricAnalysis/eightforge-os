import { describe, expect, it } from 'vitest';

import {
  acceptSelectedSuggestions,
  acceptSuggestion,
  addManualLabel,
  createLabelToolState,
  deleteLastDraft,
  editSuggestion,
  exportConfirmedLabels,
  finalizeSection,
  rejectSuggestion,
  visibleSuggestions,
} from '@/lib/evaluation/benchmark/workspace/labelToolState.mjs';

const box = (x: number) => ({
  coordinate_space: 'canonical_v1', x_min: x, y_min: 1, x_max: x + 2, y_max: 3,
});

const labels = () => ({
  labelSetVersion: 'extraction-benchmark-labels-v1',
  authority: 'human_ground_truth',
  pageKey: 'golden-p8',
  source: { documentKey: 'golden', sha256: 'a'.repeat(64), byteLength: 100, physicalPageNumber: 8 },
  frame: {
    frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
    view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
  },
  words: { status: 'unlabeled', items: [] },
  cells: { status: 'unlabeled', items: [] },
  rows: { status: 'unlabeled', items: [] },
  coverage: { status: 'unlabeled', truth: null, note: null },
  labeledBy: null,
  labeledAt: null,
});

const suggestions = () => ({
  words: [
    { suggestionId: 'sw1', text: 'Exhibit', box: box(1) },
    { suggestionId: 'sw2', text: 'A', box: box(4) },
  ],
  cells: [
    { suggestionId: 'sc1', text: 'Description', box: box(10), isHeader: true, columnName: 'Description' },
    { suggestionId: 'sc2', text: 'Rate', box: box(20), isHeader: false, columnName: 'Rate' },
  ],
  rows: [{ suggestionId: 'sr1', orderedCellSuggestionIds: ['sc1', 'sc2'] }],
});

describe('label tool suggestion state', () => {
  it('keeps loaded suggestions separate from exported benchmark truth', () => {
    const original = labels();
    const state = createLabelToolState(original, suggestions());
    expect(exportConfirmedLabels(state)).toEqual(original);
    expect(JSON.stringify(exportConfirmedLabels(state))).not.toMatch(/suggestion|Exhibit|Description/);
    expect(original).toEqual(labels());
  });

  it('accepts exactly the selected suggestion without finalizing its section', () => {
    const state = acceptSuggestion(createLabelToolState(labels(), suggestions()), 'words', 'sw1');
    expect(state.labels.words.status).toBe('unlabeled');
    expect(state.drafts.words).toEqual([{
      labelId: 'w1', text: 'Exhibit', box: box(1),
      provenance: { method: 'accepted_suggestion', sourceSuggestionId: 'sw1' },
    }]);
    expect(visibleSuggestions(state, 'words').map((item: { suggestionId: string }) => item.suggestionId))
      .toEqual(['sw2']);
    expect(() => exportConfirmedLabels(state)).toThrow(/confirmed drafts but is still unlabeled/);
  });

  it('exports the edited human value rather than the original suggestion', () => {
    let state = editSuggestion(createLabelToolState(labels(), suggestions()), 'words', 'sw1', {
      text: 'EXHIBIT', box: box(30),
    });
    state = finalizeSection(state, 'words');
    const exported = exportConfirmedLabels(state);
    expect(exported.words.items).toEqual([{
      labelId: 'w1', text: 'EXHIBIT', box: box(30),
      provenance: { method: 'edited_suggestion', sourceSuggestionId: 'sw1' },
    }]);
    expect(JSON.stringify(exported)).not.toContain('"text":"Exhibit"');
  });

  it('rejects without adding anything to export', () => {
    const state = rejectSuggestion(createLabelToolState(labels(), suggestions()), 'words', 'sw1');
    expect(state.dispositions.words.sw1).toBe('rejected');
    expect(exportConfirmedLabels(state).words).toEqual({ status: 'unlabeled', items: [] });
  });

  it('batch accepts only ids supplied by the explicit action', () => {
    const initial = createLabelToolState(labels(), suggestions());
    expect(initial.drafts.words).toEqual([]);
    const state = acceptSelectedSuggestions(initial, 'words', ['sw2']);
    expect(state.drafts.words.map((item: { text: string }) => item.text)).toEqual(['A']);
    expect(initial.drafts.words).toEqual([]);
  });

  it('never mutates or appends to an existing finalized section', () => {
    const existing = {
      ...labels(),
      words: {
        status: 'labeled',
        items: [{ labelId: 'w7', text: 'Human', box: box(40) }],
      },
    };
    const state = createLabelToolState(existing, suggestions());
    expect(visibleSuggestions(state, 'words')).toEqual([]);
    expect(() => acceptSuggestion(state, 'words', 'sw1')).toThrow(/already finalized/);
    expect(exportConfirmedLabels(state).words).toEqual(existing.words);
  });

  it('keeps manual provenance and requires explicit section finalization', () => {
    let state = addManualLabel(createLabelToolState(labels(), suggestions()), 'words', {
      text: 'Manual', box: box(50),
    });
    expect(state.labels.words.status).toBe('unlabeled');
    expect(state.drafts.words[0].provenance).toEqual({ method: 'entered_manually' });
    state = finalizeSection(state, 'words');
    expect(exportConfirmedLabels(state).words).toMatchObject({
      status: 'labeled', items: [{ text: 'Manual' }],
    });
  });

  it('deletes drafts without touching confirmed labels and restores their suggestion', () => {
    let state = acceptSuggestion(createLabelToolState(labels(), suggestions()), 'cells', 'sc1');
    state = deleteLastDraft(state, 'cells');
    expect(state.drafts.cells).toEqual([]);
    expect(state.cellSuggestionToLabelId).toEqual({});
    expect(visibleSuggestions(state, 'cells').map((item: { suggestionId: string }) => item.suggestionId))
      .toEqual(['sc1', 'sc2']);
  });

  it('refuses the exact stale-row cell-deletion repro without mutating state', () => {
    let state = createLabelToolState(labels(), suggestions());
    state = acceptSelectedSuggestions(state, 'cells', ['sc1', 'sc2']);
    state = acceptSuggestion(state, 'rows', 'sr1');
    const beforeDeletion = structuredClone(state);

    expect(() => deleteLastDraft(state, 'cells')).toThrow(
      /cannot delete cell c2; referenced by row\(s\) r1/,
    );
    expect(state).toEqual(beforeDeletion);
    expect((state.drafts.rows as Array<{ orderedCellLabelIds: string[] }>)[0].orderedCellLabelIds)
      .toEqual(['c1', 'c2']);
    expect(state.drafts.cells.map((cell: { labelId: string }) => cell.labelId)).toEqual(['c1', 'c2']);
  });

  it('never reuses a deleted label id within the session', () => {
    let state = createLabelToolState(labels(), suggestions());
    state = addManualLabel(state, 'cells', {
      text: 'First', box: box(10), isHeader: false, columnName: null,
    });
    state = addManualLabel(state, 'cells', {
      text: 'Discarded', box: box(20), isHeader: false, columnName: null,
    });
    state = deleteLastDraft(state, 'cells');
    state = addManualLabel(state, 'cells', {
      text: 'Replacement', box: box(30), isHeader: false, columnName: null,
    });

    expect(state.drafts.cells.map((cell: { labelId: string }) => cell.labelId)).toEqual(['c1', 'c3']);
  });

  it('preserves exact row lineage through explicitly accepted cells', () => {
    let state = createLabelToolState(labels(), suggestions());
    expect(() => acceptSuggestion(state, 'rows', 'sr1')).toThrow(/explicit acceptance of cell suggestion sc1/);
    state = acceptSelectedSuggestions(state, 'cells', ['sc1', 'sc2']);
    state = acceptSuggestion(state, 'rows', 'sr1');
    expect(state.drafts.rows[0]).toEqual({
      rowKey: 'r1', orderedCellLabelIds: ['c1', 'c2'],
      provenance: { method: 'accepted_suggestion', sourceSuggestionId: 'sr1' },
    });
    expect(() => finalizeSection(state, 'rows')).toThrow(/requires finalized cells/);
    state = finalizeSection(state, 'cells');
    state = finalizeSection(state, 'rows');
    expect(exportConfirmedLabels(state).rows.items[0].orderedCellLabelIds).toEqual(['c1', 'c2']);
  });

  it('fails row finalization when any membership reference is missing', () => {
    let state = createLabelToolState(labels(), suggestions());
    state = acceptSelectedSuggestions(state, 'cells', ['sc1', 'sc2']);
    state = acceptSuggestion(state, 'rows', 'sr1');
    state = finalizeSection(state, 'cells');
    const corrupted = structuredClone(state);
    corrupted.labels.cells.items = corrupted.labels.cells.items.filter(
      (cell: { labelId: string }) => cell.labelId !== 'c2',
    );

    expect(() => finalizeSection(corrupted, 'rows')).toThrow(
      /row r1 cites cell c2, which resolves 0 times in finalized cells/,
    );
  });

  it('lets a human edit row membership only to existing confirmed cells', () => {
    let state = createLabelToolState(labels(), suggestions());
    state = acceptSelectedSuggestions(state, 'cells', ['sc1', 'sc2']);
    expect(() => editSuggestion(state, 'rows', 'sr1', { orderedCellLabelIds: ['missing'] }))
      .toThrow(/unknown confirmed cell/);
    state = editSuggestion(state, 'rows', 'sr1', { orderedCellLabelIds: ['c2'] });
    expect(state.drafts.rows[0]).toMatchObject({
      orderedCellLabelIds: ['c2'],
      provenance: { method: 'edited_suggestion', sourceSuggestionId: 'sr1' },
    });
  });
});

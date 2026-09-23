const SECTIONS = ['words', 'cells', 'rows'];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(`LABEL_TOOL_STATE: ${message}`);
}

function section(state, name) {
  if (!SECTIONS.includes(name)) fail(`unknown section ${name}`);
  return state.labels[name];
}

function suggestion(state, name, suggestionId) {
  const item = state.suggestions[name].find((candidate) => candidate.suggestionId === suggestionId);
  if (!item) fail(`unknown ${name} suggestion ${suggestionId}`);
  return item;
}

function assertOpen(state, name, suggestionId) {
  if (section(state, name).status === 'labeled') {
    fail(`${name} is already finalized`);
  }
  const disposition = state.dispositions[name][suggestionId];
  if (disposition) fail(`${name} suggestion ${suggestionId} is already ${disposition}`);
}

const ID_FIELDS = {
  words: { prefix: 'w', key: 'labelId' },
  cells: { prefix: 'c', key: 'labelId' },
  rows: { prefix: 'r', key: 'rowKey' },
};

function initialIdCounter(items, prefix, key) {
  return items.reduce((maximum, item) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(item[key]);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
}

function allocateId(state, name) {
  const { prefix, key } = ID_FIELDS[name];
  const used = new Set(
    [...state.labels[name].items, ...state.drafts[name]].map((item) => item[key]),
  );
  const next = copy(state);
  let counter = next.idCounters[name] + 1;
  while (used.has(`${prefix}${counter}`)) counter += 1;
  next.idCounters[name] = counter;
  return { state: next, id: `${prefix}${counter}` };
}

function allCells(state) {
  return [...state.labels.cells.items, ...state.drafts.cells];
}

function claimedCellIds(state) {
  return new Set(
    [...state.labels.rows.items, ...state.drafts.rows]
      .flatMap((row) => row.orderedCellLabelIds),
  );
}

function validateRowMembership(state, orderedCellLabelIds) {
  if (!Array.isArray(orderedCellLabelIds) || orderedCellLabelIds.length === 0) {
    fail('a row requires at least one confirmed cell');
  }
  if (new Set(orderedCellLabelIds).size !== orderedCellLabelIds.length) {
    fail('a row may not repeat a cell');
  }
  const available = new Set(allCells(state).map((cell) => cell.labelId));
  const claimed = claimedCellIds(state);
  for (const labelId of orderedCellLabelIds) {
    if (!available.has(labelId)) fail(`row cites unknown confirmed cell ${labelId}`);
    if (claimed.has(labelId)) fail(`confirmed cell ${labelId} already belongs to a row`);
  }
}

function appendDraft(state, name, item, disposition, suggestionId) {
  const next = copy(state);
  next.drafts[name].push(item);
  if (suggestionId) next.dispositions[name][suggestionId] = disposition;
  if (name === 'cells' && suggestionId) {
    next.cellSuggestionToLabelId[suggestionId] = item.labelId;
  }
  return next;
}

function promotedItem(state, name, candidate, method, editedValue) {
  const provenance = { method, sourceSuggestionId: candidate.suggestionId };
  const allocated = allocateId(state, name);
  if (name === 'words') {
    const value = editedValue ?? candidate;
    return {
      state: allocated.state,
      item: {
        labelId: allocated.id,
        text: value.text,
        box: copy(value.box),
        provenance,
      },
    };
  }
  if (name === 'cells') {
    const value = editedValue ?? candidate;
    return {
      state: allocated.state,
      item: {
        labelId: allocated.id,
        text: value.text,
        box: copy(value.box),
        isHeader: value.isHeader,
        columnName: value.columnName ?? null,
        provenance,
      },
    };
  }
  fail(`cannot promote ${name} with this helper`);
}

/**
 * Creates isolated local review state. Suggestions never share an object graph
 * with confirmed labels, so merely loading them cannot change benchmark truth.
 */
export function createLabelToolState(labels, suggestions = {}) {
  const confirmed = copy(labels);
  for (const name of SECTIONS) {
    if (!confirmed[name] || !Array.isArray(confirmed[name].items)) {
      fail(`labels has no valid ${name} section`);
    }
  }
  return {
    labels: confirmed,
    suggestions: {
      words: copy(suggestions.words ?? []),
      cells: copy(suggestions.cells ?? []),
      rows: copy(suggestions.rows ?? []),
    },
    drafts: { words: [], cells: [], rows: [] },
    dispositions: { words: {}, cells: {}, rows: {} },
    cellSuggestionToLabelId: {},
    idCounters: Object.fromEntries(
      SECTIONS.map((name) => {
        const { prefix, key } = ID_FIELDS[name];
        return [name, initialIdCounter(confirmed[name].items, prefix, key)];
      }),
    ),
  };
}

export function visibleSuggestions(state, name) {
  if (section(state, name).status === 'labeled') return [];
  return state.suggestions[name]
    .filter((candidate) => !state.dispositions[name][candidate.suggestionId])
    .map(copy);
}

export function acceptSuggestion(state, name, suggestionId) {
  assertOpen(state, name, suggestionId);
  const candidate = suggestion(state, name, suggestionId);
  if (name === 'rows') {
    const cellIds = candidate.orderedCellSuggestionIds.map((cellSuggestionId) => {
      const labelId = state.cellSuggestionToLabelId[cellSuggestionId];
      if (!labelId) fail(`row suggestion ${suggestionId} requires explicit acceptance of cell suggestion ${cellSuggestionId}`);
      return labelId;
    });
    validateRowMembership(state, cellIds);
    const allocated = allocateId(state, name);
    const row = {
      rowKey: allocated.id,
      orderedCellLabelIds: cellIds,
      provenance: { method: 'accepted_suggestion', sourceSuggestionId: suggestionId },
    };
    return appendDraft(allocated.state, name, row, 'accepted', suggestionId);
  }
  const promoted = promotedItem(state, name, candidate, 'accepted_suggestion');
  return appendDraft(
    promoted.state,
    name,
    promoted.item,
    'accepted',
    suggestionId,
  );
}

export function editSuggestion(state, name, suggestionId, editedValue) {
  assertOpen(state, name, suggestionId);
  const candidate = suggestion(state, name, suggestionId);
  if (name === 'rows') {
    validateRowMembership(state, editedValue.orderedCellLabelIds);
    const allocated = allocateId(state, name);
    const row = {
      rowKey: allocated.id,
      orderedCellLabelIds: copy(editedValue.orderedCellLabelIds),
      provenance: { method: 'edited_suggestion', sourceSuggestionId: suggestionId },
    };
    return appendDraft(allocated.state, name, row, 'edited', suggestionId);
  }
  const promoted = promotedItem(state, name, candidate, 'edited_suggestion', editedValue);
  return appendDraft(
    promoted.state,
    name,
    promoted.item,
    'edited',
    suggestionId,
  );
}

export function rejectSuggestion(state, name, suggestionId) {
  assertOpen(state, name, suggestionId);
  suggestion(state, name, suggestionId);
  const next = copy(state);
  next.dispositions[name][suggestionId] = 'rejected';
  return next;
}

/** The caller invokes this only from an explicit human batch action. */
export function acceptSelectedSuggestions(state, name, suggestionIds) {
  return suggestionIds.reduce(
    (current, suggestionId) => acceptSuggestion(current, name, suggestionId),
    state,
  );
}

export function addManualLabel(state, name, value) {
  if (section(state, name).status === 'labeled') fail(`${name} is already finalized`);
  if (name === 'rows') {
    validateRowMembership(state, value.orderedCellLabelIds);
    const allocated = allocateId(state, name);
    return appendDraft(allocated.state, name, {
      rowKey: allocated.id,
      orderedCellLabelIds: copy(value.orderedCellLabelIds),
      provenance: { method: 'entered_manually' },
    });
  }
  const key = name === 'words' ? 'w' : name === 'cells' ? 'c' : null;
  if (!key) fail(`cannot add a manual ${name} label`);
  const allocated = allocateId(state, name);
  const item = {
    labelId: allocated.id,
    ...copy(value),
    provenance: { method: 'entered_manually' },
  };
  return appendDraft(allocated.state, name, item);
}

/** Removes only the latest unfinalized draft; confirmed loaded labels are immutable. */
export function deleteLastDraft(state, name) {
  if (!SECTIONS.includes(name)) fail(`unknown section ${name}`);
  if (state.drafts[name].length === 0) return state;
  const candidate = state.drafts[name][state.drafts[name].length - 1];
  if (name === 'cells') {
    const referencingRows = [...state.labels.rows.items, ...state.drafts.rows]
      .filter((row) => row.orderedCellLabelIds.includes(candidate.labelId))
      .map((row) => row.rowKey)
      .sort();
    if (referencingRows.length > 0) {
      fail(`cannot delete cell ${candidate.labelId}; referenced by row(s) ${referencingRows.join(', ')}`);
    }
  }
  const next = copy(state);
  const removed = next.drafts[name].pop();
  const suggestionId = removed?.provenance?.sourceSuggestionId;
  if (suggestionId) {
    delete next.dispositions[name][suggestionId];
    if (name === 'cells') delete next.cellSuggestionToLabelId[suggestionId];
  }
  return next;
}

/** Explicit section-completion action; suggestion acceptance never calls this. */
export function finalizeSection(state, name) {
  const target = section(state, name);
  if (target.status === 'labeled') fail(`${name} is already finalized`);
  if (state.drafts[name].length === 0) fail(`${name} has no confirmed draft items`);
  if (name === 'rows' && state.labels.cells.status !== 'labeled') {
    fail('row membership requires finalized cells');
  }
  if (name === 'rows') {
    const cellCounts = new Map();
    for (const cell of state.labels.cells.items) {
      cellCounts.set(cell.labelId, (cellCounts.get(cell.labelId) ?? 0) + 1);
    }
    for (const row of [...state.labels.rows.items, ...state.drafts.rows]) {
      for (const labelId of row.orderedCellLabelIds) {
        const matches = cellCounts.get(labelId) ?? 0;
        if (matches !== 1) {
          fail(`row ${row.rowKey} cites cell ${labelId}, which resolves ${matches} times in finalized cells`);
        }
      }
    }
  }
  const next = copy(state);
  next.labels[name] = {
    status: 'labeled',
    items: [...next.labels[name].items, ...next.drafts[name]],
  };
  next.drafts[name] = [];
  return next;
}

/**
 * Returns the benchmark artifact only. It intentionally has no suggestion or
 * disposition fields and refuses to discard confirmed in-progress work.
 */
export function exportConfirmedLabels(state) {
  for (const name of SECTIONS) {
    if (state.labels[name].status === 'unlabeled' && state.drafts[name].length > 0) {
      fail(`${name} has confirmed drafts but is still unlabeled`);
    }
  }
  return copy(state.labels);
}

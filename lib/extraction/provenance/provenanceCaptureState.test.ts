import { describe, expect, it } from 'vitest';

import { resolveProvenanceCaptureState } from './provenanceCaptureState';

describe('provenance capture-state resolution', () => {
  it('reserves unknown for a genuinely absent declaration container', () => {
    expect(resolveProvenanceCaptureState(undefined)).toBe('unknown');
  });

  it.each([
    null,
    'captured',
    1,
    false,
    [],
    {},
    { capture_state: null },
    { capture_state: 'future_state' },
  ])('fails closed for a present malformed container %#', (container) => {
    expect(resolveProvenanceCaptureState(container)).toBe('capture_failed');
  });

  it.each([
    'captured',
    'not_applicable_non_paginated',
    'capture_failed',
    'legacy_pre_provenance',
  ] as const)('preserves the declared %s state', (captureState) => {
    expect(resolveProvenanceCaptureState({ capture_state: captureState })).toBe(captureState);
  });
});

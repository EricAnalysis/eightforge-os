import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';

import { ForgeSurfaceState } from '@/components/forge/ForgeSurfaceState';

describe('ForgeSurfaceState', () => {
  it('renders loading state copy', () => {
    const html = renderToStaticMarkup(createElement(ForgeSurfaceState, {
      state: 'loading',
      title: 'Loading Documents',
      message: 'Loading document intake state.',
    }));

    assert.match(html, /Loading Documents/);
    assert.match(html, /Loading document intake state/);
    assert.match(html, /animate-spin/);
  });

  it('renders empty state copy', () => {
    const html = renderToStaticMarkup(createElement(ForgeSurfaceState, {
      state: 'empty',
      title: 'Document Intake',
      message: 'No documents have been uploaded.',
    }));

    assert.match(html, /Document Intake/);
    assert.match(html, /No documents have been uploaded/);
  });

  it('renders error state with retry action', () => {
    const html = renderToStaticMarkup(createElement(ForgeSurfaceState, {
      state: 'error',
      title: 'Load Failed',
      message: 'Documents could not be loaded.',
      actionLabel: 'Retry',
      onAction: () => undefined,
    }));

    assert.match(html, /Load Failed/);
    assert.match(html, /Documents could not be loaded/);
    assert.match(html, /Retry/);
  });
});

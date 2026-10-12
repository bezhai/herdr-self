import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { runThemeScript } from './fixtures.js';

// jsdom has no modal dialog support. These stubs only toggle the open attribute so dialogs render;
// keyboard and focus behavior is verified in a real browser.
HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };

// As on the real pages, the theme script has run before anything renders.
beforeEach(runThemeScript);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

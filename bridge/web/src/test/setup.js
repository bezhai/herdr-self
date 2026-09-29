import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no modal dialog support. These stubs only toggle the open attribute so dialogs render;
// keyboard and focus behavior is verified in a real browser.
HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

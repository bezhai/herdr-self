import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { runThemeScript } from '../test/fixtures.js';
import { ThemeToggle } from './ThemeToggle.jsx';

const key = 'herdr-bridge-theme';
const root = document.documentElement;
const toggle = () => screen.getByRole('button', { name: /^主题：/ });
// The button's accessible name, title and icon.
const shown = () => [toggle().getAttribute('aria-label'), toggle().title, toggle().querySelector('use').getAttribute('href')];

// Like a browser that blocks site data: reading window.localStorage throws.
const blockStorage = () => vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
  throw new DOMException('Access is denied for this document.', 'SecurityError');
});

test('the theme script applies a stored light or dark choice to <html> and follows the system otherwise', () => {
  for (const [stored, applied] of [['light', 'light'], ['dark', 'dark'], ['system', null], ['sepia', null], [null, null]]) {
    localStorage.clear();
    if (stored) localStorage.setItem(key, stored);
    root.setAttribute('data-theme', 'stale');
    runThemeScript();
    expect(root.getAttribute('data-theme'), String(stored)).toBe(applied);
  }
});

test('the theme button cycles 跟随系统, 浅色, 深色, applies each choice to <html> and stores it', async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);
  expect(shown()).toEqual(['主题：跟随系统', '主题：跟随系统', '#i-auto']);
  expect(root.hasAttribute('data-theme')).toBe(false);

  await user.click(toggle());
  expect(shown()).toEqual(['主题：浅色', '主题：浅色', '#i-sun']);
  expect(root.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem(key)).toBe('light');

  await user.click(toggle());
  expect(shown()).toEqual(['主题：深色', '主题：深色', '#i-moon']);
  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(localStorage.getItem(key)).toBe('dark');

  await user.click(toggle());
  expect(shown()).toEqual(['主题：跟随系统', '主题：跟随系统', '#i-auto']);
  expect(root.hasAttribute('data-theme')).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
});

test('the theme button starts from the choice the script applied before first paint', async () => {
  localStorage.setItem(key, 'dark');
  runThemeScript();
  const user = userEvent.setup();
  render(<ThemeToggle />);
  expect(shown()[0]).toBe('主题：深色');
  await user.click(toggle());
  expect(shown()[0]).toBe('主题：跟随系统');
  expect(root.hasAttribute('data-theme')).toBe(false);
});

test('without storage the console follows the system, and the button still switches the open page', async () => {
  localStorage.setItem(key, 'dark');
  blockStorage();
  expect(runThemeScript).not.toThrow();
  expect(root.hasAttribute('data-theme')).toBe(false);

  const user = userEvent.setup();
  render(<ThemeToggle />);
  expect(shown()[0]).toBe('主题：跟随系统');
  await user.click(toggle());
  expect(shown()[0]).toBe('主题：浅色');
  expect(root.getAttribute('data-theme')).toBe('light');
  await user.click(toggle());
  await user.click(toggle());
  expect(root.hasAttribute('data-theme')).toBe(false);
});

test('a storage that refuses writes keeps the choice for the open page', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  const user = userEvent.setup();
  render(<ThemeToggle />);
  await user.click(toggle());
  expect(shown()[0]).toBe('主题：浅色');
  expect(root.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem(key)).toBeNull();
});

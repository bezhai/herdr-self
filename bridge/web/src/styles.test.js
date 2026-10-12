import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Read from disk: Vitest turns CSS imports, ?raw included, into empty strings.
const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

// Declarations of the first rule with exactly this selector, as { property: value }.
function rule(selector) {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const colon = d.indexOf(':');
    return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
  }));
}

const dark = rule(':root');
const light = rule(':root[data-theme="light"]');

test('the light palette is the same whether the OS asks for it or data-theme="light" does', () => {
  expect(css).toContain('@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {');
  expect(rule(':root:not([data-theme="dark"])')).toEqual(light);
});

test('the light palette redefines every colour token of the dark one and switches color-scheme', () => {
  const themeless = ['--sans', '--mono', '--radius', '--ease'];
  expect(Object.keys(light).sort()).toEqual(Object.keys(dark).filter((k) => !themeless.includes(k)).sort());
  expect([dark['color-scheme'], light['color-scheme']]).toEqual(['dark', 'light']);
});

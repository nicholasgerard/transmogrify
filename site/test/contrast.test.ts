/**
 * Colour-contrast regression guard.
 *
 * A rendered axe pass (see site/README.md) is the real check, but it needs a
 * browser. This reads the tokens straight out of `global.css` and asserts the
 * foreground/background pairings the design actually uses, so a palette edit
 * cannot quietly drop below AA between browser audits.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '..', 'src/styles/global.css'), 'utf8');

/** Pull the token block that follows a selector, as a name→hex map. */
function tokensAfter(selector: string): Record<string, string> {
  const index = css.indexOf(selector);
  assert.ok(index !== -1, `selector ${selector} not found in global.css`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    tokens[match[1]!] = match[2]!;
  }
  return tokens;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = ['--bg', '--bg-raised', '--bg-sunken', '--bg-inset'] as const;

/** WCAG 2.2 AA: 4.5:1 for normal text, 3:1 for large text and UI boundaries. */
const foregrounds: Array<{ token: string; min: number; why: string }> = [
  { token: '--text', min: 4.5, why: 'body and heading text' },
  { token: '--muted', min: 4.5, why: 'secondary prose' },
  { token: '--faint', min: 4.5, why: 'labels and eyebrows — small, so still normal text' },
  { token: '--accent', min: 4.5, why: 'links, section numbers, the focus ring' },
  { token: '--accent-dim', min: 4.5, why: 'lifecycle numerals' },
  { token: '--warn', min: 4.5, why: 'the "not claimed yet" panel heading' },
];

describe('dark theme (:root)', () => {
  const t = tokensAfter(':root {\n  color-scheme: dark;');

  for (const { token, min, why } of foregrounds) {
    for (const surface of surfaces) {
      test(`${token} on ${surface} ≥ ${min}:1 (${why})`, () => {
        const ratio = contrast(t[token]!, t[surface]!);
        assert.ok(ratio >= min, `${ratio.toFixed(2)}:1 for ${t[token]} on ${t[surface]}`);
      });
    }
  }

  test('--accent-ink on --accent ≥ 4.5:1 (the copy button)', () => {
    assert.ok(contrast(t['--accent-ink']!, t['--accent']!) >= 4.5);
  });

  // `--line-strong` is a decorative hairline and carries no contrast
  // requirement. `--border-control` is what identifies an actual control, so it
  // is the one held to WCAG 2.2 SC 1.4.11.
  for (const surface of ['--bg', '--bg-raised', '--bg-inset'] as const) {
    test(`--border-control on ${surface} ≥ 3:1 (SC 1.4.11)`, () => {
      const ratio = contrast(t['--border-control']!, t[surface]!);
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1`);
    });
  }
});

describe('light theme ([data-theme="light"])', () => {
  const t = tokensAfter(":root[data-theme='light']");

  test('defines the full palette', () => {
    for (const { token } of foregrounds) assert.ok(t[token], `missing ${token}`);
    for (const surface of surfaces) assert.ok(t[surface], `missing ${surface}`);
  });

  for (const { token, min, why } of foregrounds) {
    for (const surface of surfaces) {
      test(`${token} on ${surface} ≥ ${min}:1 (${why})`, () => {
        const ratio = contrast(t[token]!, t[surface]!);
        assert.ok(ratio >= min, `${ratio.toFixed(2)}:1 for ${t[token]} on ${t[surface]}`);
      });
    }
  }

  test('--accent-ink on --accent ≥ 4.5:1 (the copy button)', () => {
    assert.ok(contrast(t['--accent-ink']!, t['--accent']!) >= 4.5);
  });

  // `--line-strong` is a decorative hairline and carries no contrast
  // requirement. `--border-control` is what identifies an actual control, so it
  // is the one held to WCAG 2.2 SC 1.4.11.
  for (const surface of ['--bg', '--bg-raised', '--bg-inset'] as const) {
    test(`--border-control on ${surface} ≥ 3:1 (SC 1.4.11)`, () => {
      const ratio = contrast(t['--border-control']!, t[surface]!);
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1`);
    });
  }
});

describe('the two light palettes stay identical', () => {
  // The light tokens are declared twice — once for `prefers-color-scheme` with
  // no explicit choice, once for the explicit choice. They must not diverge.
  const media = tokensAfter(":root:not([data-theme='dark'])");
  const explicit = tokensAfter(":root[data-theme='light']");

  test('the media-query and explicit light blocks agree', () => {
    assert.deepEqual(media, explicit);
  });
});

describe('contrast helper', () => {
  test('matches known reference ratios', () => {
    assert.equal(Number(contrast('#ffffff', '#000000').toFixed(0)), 21);
    assert.equal(Number(contrast('#ffffff', '#ffffff').toFixed(0)), 1);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// The build-output scripts are plain JS on purpose — they must run against
// `dist/` with no compile step — but `allowJs` still types them here.
import { inlineScriptBodies, renderHeaders, sha256Source } from '../scripts/build-headers.mjs';
import { pngToIco } from '../scripts/make-images.mjs';

describe('inlineScriptBodies', () => {
  test('finds inline scripts and ignores external ones', () => {
    const html = `
      <script src="/_astro/app.js" type="module"></script>
      <script>var a = 1;</script>
      <script type="application/ld+json">{"a":1}</script>
    `;
    assert.deepEqual(inlineScriptBodies(html), ['var a = 1;', '{"a":1}']);
  });

  test('is not fooled by a src attribute later in the tag', () => {
    const html = '<script type="module" src="/x.js"></script>';
    assert.deepEqual(inlineScriptBodies(html), []);
  });

  test('handles a script body containing angle brackets', () => {
    const html = '<script>if (a < b) { c(); }</script>';
    assert.deepEqual(inlineScriptBodies(html), ['if (a < b) { c(); }']);
  });
});

describe('sha256Source', () => {
  test('emits the CSP hash form browsers expect', () => {
    const body = 'var a = 1;';
    const expected = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    assert.equal(sha256Source(body), expected);
  });
});

describe('renderHeaders', () => {
  const rendered = renderHeaders(["'sha256-AAA'", "'sha256-BBB'"]);

  test('includes every supplied hash in script-src', () => {
    assert.match(rendered, /script-src [^;]*'sha256-AAA'/);
    assert.match(rendered, /script-src [^;]*'sha256-BBB'/);
  });

  test('locks down the directives that matter on a static site', () => {
    assert.match(rendered, /object-src 'none'/);
    assert.match(rendered, /frame-ancestors 'none'/);
    assert.match(rendered, /base-uri 'self'/);
    assert.doesNotMatch(rendered, /unsafe-eval/);
  });

  test('applies immutable caching only to the fingerprinted asset path', () => {
    const immutableBlocks = rendered
      .split(/\n(?=\/)/)
      .filter((block) => block.includes('immutable'));
    assert.equal(immutableBlocks.length, 1);
    assert.ok(immutableBlocks[0]!.startsWith('/_astro/*'));
  });

  test('keeps HTML revalidatable by never giving /* a Cache-Control', () => {
    const globalBlock = rendered.split(/\n(?=\/)/).find((block) => block.startsWith('/*'));
    assert.ok(globalBlock);
    assert.doesNotMatch(globalBlock!, /Cache-Control/);
  });

  test('carries the baseline security headers', () => {
    for (const header of [
      'X-Content-Type-Options: nosniff',
      'X-Frame-Options: DENY',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'Strict-Transport-Security: max-age=31536000',
    ]) {
      assert.ok(rendered.includes(header), `missing ${header}`);
    }
  });

  test('serves the remote start prompt as Markdown', () => {
    assert.match(rendered, /\/start\n\s+Content-Type: text\/markdown; charset=utf-8/);
    assert.match(rendered, /\/start[\s\S]*?X-Robots-Tag: noindex/);
  });

  test('keeps Cloudflare version-preview hosts out of search indexes', () => {
    assert.match(
      rendered,
      /https:\/\/:version\.:subdomain\.workers\.dev\/\*[\s\S]*?X-Robots-Tag: noindex, nofollow/,
    );
  });

  test('mentions no Google endpoint in a no-analytics build', () => {
    assert.doesNotMatch(rendered, /google-analytics|googletagmanager|analytics\.google/);
  });

  test('allows the consent-gated endpoints only in an analytics build', () => {
    const analytics = renderHeaders(["'sha256-AAA'"], true);
    assert.match(analytics, /https:\/\/www\.googletagmanager\.com/);
    assert.match(analytics, /https:\/\/www\.google-analytics\.com/);
  });

  test('no line exceeds Cloudflare Static Assets\' 2000-character limit', () => {
    for (const line of rendered.split('\n')) {
      assert.ok(line.length <= 2000, `line of ${line.length} chars`);
    }
  });
});

describe('pngToIco', () => {
  test('wraps a PNG in a valid single-image ICO header', () => {
    const png = Buffer.from('not-really-a-png');
    const ico = pngToIco(png, 32);
    assert.equal(ico.readUInt16LE(0), 0, 'reserved');
    assert.equal(ico.readUInt16LE(2), 1, 'type = icon');
    assert.equal(ico.readUInt16LE(4), 1, 'one image');
    assert.equal(ico.readUInt8(6), 32, 'width');
    assert.equal(ico.readUInt8(7), 32, 'height');
    assert.equal(ico.readUInt32LE(14), png.length, 'payload length');
    assert.equal(ico.readUInt32LE(18), 22, 'payload offset');
    assert.deepEqual(ico.subarray(22), png);
  });

  test('encodes 256 as 0, per the ICO format', () => {
    const ico = pngToIco(Buffer.alloc(4), 256);
    assert.equal(ico.readUInt8(6), 0);
  });
});

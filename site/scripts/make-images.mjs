/**
 * Regenerates the committed raster assets: the social card, the touch icon, the
 * maskable icon, and favicon.ico.
 *
 * These are rendered once and committed, so the site ships no image toolchain
 * and CI installs no browser. Playwright is therefore NOT a dependency of this
 * package — install it temporarily to run this script:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/make-images.mjs
 *
 * Or point at an existing installation:
 *
 *   node scripts/make-images.mjs --playwright /abs/path/to/node_modules/playwright
 *   node scripts/make-images.mjs --channel chrome     # use installed Chrome
 *
 * The source of truth for the design is the markup below, not the PNGs.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const playwrightSpecifier = flag('playwright', 'playwright');
const channel = flag('channel', undefined);

const BG = '#07100c';
const RAISED = '#0c1712';
const LINE = '#1b2c23';
const TEXT = '#e6f0e9';
const MUTED = '#9bb0a4';
const FAINT = '#6e8478';
const ACCENT = '#57e08f';
const INK = '#04170d';

const MONO =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const glyph = (size) => `
  <svg viewBox="0 0 32 32" width="${size}" height="${size}">
    <rect width="32" height="32" rx="7" fill="${ACCENT}"/>
    <circle cx="16" cy="16" r="8.1" fill="none" stroke="${INK}" stroke-width="2.6"/>
    <path d="M16 6.6a9.4 9.4 0 0 0 0 18.8Z" fill="${INK}"/>
  </svg>`;

function ogHtml(pins) {
  return `<!doctype html><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; background: ${BG}; color: ${TEXT};
    font-family: ${MONO}; -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 66px 72px; position: relative; overflow: hidden;
  }
  body::before {
    content: ''; position: absolute; inset: -30% -10% auto;
    height: 130%;
    background:
      radial-gradient(52% 46% at 24% 8%, rgba(87,224,143,.13), transparent 66%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 46%, transparent 92%);
  }
  .row { position: relative; display: flex; align-items: center; gap: 16px; }
  .mark { font-size: 30px; font-weight: 600; letter-spacing: -.03em; }
  h1 {
    position: relative; font-size: 66px; line-height: 1.1; font-weight: 600;
    letter-spacing: -.045em; max-width: 19ch;
  }
  h1 em { font-style: normal; color: ${ACCENT}; }
  .sub { position: relative; color: ${MUTED}; font-size: 24px; line-height: 1.5; max-width: 44ch; margin-top: 22px; }
  .pins { position: relative; display: flex; gap: 10px; flex-wrap: wrap; }
  .pin {
    border: 1px solid ${LINE}; background: ${RAISED}; border-radius: 8px;
    padding: 9px 15px; font-size: 18px; color: ${FAINT}; letter-spacing: .02em;
  }
  .pin b { color: ${TEXT}; font-weight: 600; }
  .url { position: relative; color: ${ACCENT}; font-size: 20px; letter-spacing: .1em; }
</style>
<div class="row">${glyph(34)}<span class="mark">transmogrify</span></div>
<div>
  <h1>Your coding agents, working as a <em>team</em>.</h1>
  <p class="sub">Open-source agent orchestration built directly into the ChatGPT and Claude apps.</p>
</div>
<div class="row" style="justify-content:space-between;align-items:flex-end">
  <div class="pins">${pins.map((p) => `<span class="pin">${p[0]} <b>${p[1]}</b></span>`).join('')}</div>
  <span class="url">transmogrify.sh</span>
</div>`;
}

function iconHtml(size) {
  return `<!doctype html><meta charset="utf-8">
<style>*{margin:0}html,body{width:${size}px;height:${size}px;background:${ACCENT}}
svg{display:block}</style>
<svg viewBox="0 0 32 32" width="${size}" height="${size}">
  <rect width="32" height="32" fill="${ACCENT}"/>
  <circle cx="16" cy="16" r="8.1" fill="none" stroke="${INK}" stroke-width="2.6"/>
  <path d="M16 6.6a9.4 9.4 0 0 0 0 18.8Z" fill="${INK}"/>
</svg>`;
}

/** Wrap a PNG in a single-image ICO container. */
export function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import(playwrightSpecifier));
  } catch (error) {
    console.error(
      `Could not import "${playwrightSpecifier}". Install it temporarily:\n` +
        '  npm i --no-save playwright && npx playwright install chromium\n' +
        'or pass --playwright /abs/path/to/node_modules/playwright\n\n' +
        String(error),
    );
    process.exit(1);
  }

  const pins = [
    ['hosts', 'claude code + codex'],
    ['seats', 'a worktree per job'],
    ['deps', '1'],
  ];

  await mkdir(publicDir, { recursive: true });
  const browser = await chromium.launch(channel ? { channel } : {});

  const shots = [
    { name: 'og.png', html: ogHtml(pins), width: 1200, height: 630, scale: 1 },
    { name: 'apple-touch-icon.png', html: iconHtml(180), width: 180, height: 180, scale: 1 },
    { name: 'icon-512.png', html: iconHtml(512), width: 512, height: 512, scale: 1 },
    { name: 'favicon-32.png', html: iconHtml(32), width: 32, height: 32, scale: 1 },
  ];

  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: shot.scale,
    });
    const page = await context.newPage();
    await page.setContent(shot.html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const buffer = await page.screenshot({ type: 'png' });
    await writeFile(resolve(publicDir, shot.name), buffer);
    console.log(
      `${shot.name.padEnd(24)} ${String(buffer.length).padStart(7)} bytes  ` +
        createHash('sha256').update(buffer).digest('hex').slice(0, 12),
    );
    await context.close();
  }

  await browser.close();

  const favicon32 = await readFile(resolve(publicDir, 'favicon-32.png'));
  await writeFile(resolve(publicDir, 'favicon.ico'), pngToIco(favicon32, 32));
  console.log('favicon.ico              wrapped from favicon-32.png');
}

if (import.meta.filename === process.argv[1]) {
  await main();
}

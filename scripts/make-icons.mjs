#!/usr/bin/env node
/**
 * Renders the app icons with headless Chromium (no image libraries needed).
 *
 * The mark is the dashboard's own language: a diverging ladder, long above in
 * blue, short below in red, on the app's dark surface. Maskable variants keep
 * the glyph inside the 80% safe zone so Android/iOS cropping cannot clip it.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/icons');
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const SURFACE = '#1a1a19';
const LONG = '#3987e5';
const SHORT = '#d03b3b';
const AXIS = '#57565180';

/** @param {number} inset fraction of the canvas kept clear for mask cropping */
const svg = (size, inset) => {
  const pad = size * inset;
  const w = size - pad * 2;
  const rows = [
    { y: 0.10, len: 0.40, c: SHORT },
    { y: 0.26, len: 0.68, c: SHORT },
    { y: 0.42, len: 0.24, c: SHORT },
    { y: 0.64, len: 0.52, c: LONG },
    { y: 0.80, len: 0.88, c: LONG },
  ];
  const h = size * 0.085;
  const r = h / 2.6;
  const bars = rows.map((b) => {
    const bw = Math.max(w * b.len, h);
    return `<rect x="${pad}" y="${pad + w * b.y}" width="${bw}" height="${h}" rx="${r}" fill="${b.c}"/>`;
  }).join('');
  const midY = pad + w * 0.56;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${SURFACE}"/>
    ${bars}
    <rect x="${pad}" y="${midY}" width="${w}" height="${Math.max(size * 0.012, 1)}" fill="${AXIS}"/>
  </svg>`;
};

const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0.14 },
  { file: 'icon-512.png', size: 512, inset: 0.14 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.14 },
];

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
await mkdir(OUT, { recursive: true });
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:${SURFACE}">${svg(t.size, t.inset)}</body>`,
    { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/${t.file}`, omitBackground: false });
  await page.close();
  console.log(`  ${t.file}  ${t.size}x${t.size}`);
}
await browser.close();
console.log('icons written to docs/icons');

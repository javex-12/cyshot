/**
 * Renders the PWA icons from one SVG source using the Chromium that ships with
 * Playwright, so there is no image toolchain to install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { prepareBrowserEnv } from '../server/browser-env.mjs';

const root = process.cwd();
const outDir = path.join(root, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

prepareBrowserEnv(root);

/** safe = true leaves the 10% margin required by maskable icons. */
const icon = (safe) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9bf8c0"/>
      <stop offset="1" stop-color="#31cf8c"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="${safe ? 0 : 23}" fill="url(#g)"/>
  <g transform="translate(50 50) scale(${safe ? 0.78 : 1}) translate(-50 -50)">
    <rect x="35" y="18" width="30" height="64" rx="6" fill="#05170d" opacity="0.9"/>
    <rect x="40" y="27" width="20" height="3" rx="1.5" fill="#8df7b6"/>
    <rect x="40" y="34" width="14" height="3" rx="1.5" fill="#8df7b6" opacity="0.75"/>
    <rect x="40" y="41" width="18" height="3" rx="1.5" fill="#8df7b6" opacity="0.75"/>
    <rect x="40" y="48" width="11" height="3" rx="1.5" fill="#8df7b6" opacity="0.75"/>
    <rect x="28" y="60" width="44" height="3" rx="1.5" fill="#05170d"/>
    <circle cx="30" cy="61.5" r="4.5" fill="#05170d"/>
    <circle cx="70" cy="61.5" r="4.5" fill="#05170d"/>
  </g>
</svg>`;

const targets = [
  { file: 'icon-180.png', size: 180, safe: false },
  { file: 'icon-192.png', size: 192, safe: false },
  { file: 'icon-512.png', size: 512, safe: false },
  { file: 'icon-maskable-512.png', size: 512, safe: true },
];

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
for (const target of targets) {
  const page = await browser.newPage({
    viewport: { width: target.size, height: target.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${target.size}px;height:${target.size}px}</style>${icon(target.safe)}`,
  );
  await page.screenshot({
    path: path.join(outDir, target.file),
    omitBackground: true,
    clip: { x: 0, y: 0, width: target.size, height: target.size },
  });
  await page.close();
  console.log(`wrote public/icons/${target.file}`);
}
await browser.close();

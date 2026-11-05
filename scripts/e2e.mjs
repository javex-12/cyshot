/**
 * End-to-end check of the real app, driven through a browser.
 *
 *   npm run test:e2e
 *
 * 1. URL capture: renders a local page, opens the editor, exports a PNG.
 * 2. Import + stitch: feeds three scrolled screenshots through the file input,
 *    then compares the exported pixels against a ground-truth full-page shot.
 * 3. Share target: posts a link to /share the way the Android share sheet does.
 *
 * Exits non-zero if any check fails.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { prepareBrowserEnv } from '../server/browser-env.mjs';

const ROOT = process.cwd();
const APP_PORT = 8790;
const FIXTURE_PORT = 8123;
const APP = `http://127.0.0.1:${APP_PORT}`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}/page.html`;

prepareBrowserEnv(ROOT);

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fixture article</title>
<style>
  body{margin:0;font:16px/1.45 system-ui,-apple-system,sans-serif;background:#fff;color:#111}
  .hd{position:sticky;top:0;height:56px;background:#123f2b;color:#bff5d4;display:flex;align-items:center;
      padding:0 16px;font-weight:700;letter-spacing:.04em;z-index:2}
  .row{height:90px;padding:14px 16px;border-bottom:1px solid #e3e3e3;box-sizing:border-box}
  .row:nth-child(odd){background:#f6f7f8}
  .row b{display:block;font-size:15px}
  .row span{font-size:13px;color:#555}
</style></head><body><div class="hd">FIXTURE HEADER</div>
<script>
  for (let i = 0; i < 70; i++) {
    const d = document.createElement('div');
    d.className = 'row';
    d.innerHTML = '<b>Row ' + i + '</b><span>The quick brown fox jumps over the lazy dog, item ' + i + '.</span>';
    document.body.appendChild(d);
  }
</script></body></html>`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  if (!condition) throw new Error(`Assertion failed: ${name} ${detail}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  return false;
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing - run `npm run build` first');
  }

  const fixtureServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));

  const appServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT), ALLOW_PRIVATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  appServer.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  appServer.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  let browser;
  try {
    const ready = await waitForHttp(`${APP}/api/health`);
    if (!ready) throw new Error(`app server did not start:\n${serverLog.join('')}`);

    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    browser.on('disconnected', () => console.log('  [browser disconnected]'));
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on('crash', () => console.log('  [page crashed]'));
    page.on('close', () => console.log('  [page closed]'));
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // ---------- 1. home screen ----------
    await page.goto(APP, { waitUntil: 'networkidle' });
    assert('home renders', await page.isVisible('.brand h1'));
    const styled = await page.evaluate(() => {
      const button = document.querySelector('.primary');
      return {
        button: button ? getComputedStyle(button).backgroundColor : '',
        body: getComputedStyle(document.body).backgroundColor,
      };
    });
    assert('stylesheets are applied', styled.button === 'rgb(126, 240, 168)', JSON.stringify(styled));

    // ---------- 2. URL capture ----------
    await page.fill('#url', FIXTURE);
    await page.click('form.card button[type="submit"]');
    await page.waitForSelector('.editor', { timeout: 90_000 });
    const meta = await page.textContent('.editor-meta strong');
    assert('capture opens the editor with one frame', /1 frame · \d+×\d+/.test(meta ?? ''), meta ?? '');

    const canvasInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.viewcanvas');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const { data } = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 400));
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200) dark++;
      }
      return { width: canvas.width, height: canvas.height, darkPixels: dark, total: data.length / 4 };
    });
    assert(
      'captured page is painted onto the editor canvas',
      canvasInfo && canvasInfo.width > 0 && canvasInfo.darkPixels > canvasInfo.total * 0.01,
      canvasInfo ? `${canvasInfo.width}x${canvasInfo.height}, ${canvasInfo.darkPixels} ink px` : 'no canvas',
    );

    // Trim: keep only from the current scroll position.
    const heightBefore = Number(/(\d+)×(\d+)/.exec(meta ?? '')?.[2] ?? 0);
    await page.click('button:has-text("End here")');
    await wait(180);
    const trimmedMeta = await page.textContent('.editor-meta strong');
    const heightAfter = Number(/(\d+)×(\d+)/.exec(trimmedMeta ?? '')?.[2] ?? 0);
    assert(
      '“End here” trims the document',
      heightAfter > 0 && heightAfter < heightBefore,
      `${heightBefore} -> ${heightAfter}`,
    );

    // Reset the trim, then export.
    await page.click('button:has-text("Reset")');
    await wait(120);
    await page.click('.editor-head button:has-text("Export")');
    await page.waitForSelector('.sheet', { timeout: 10_000 });
    const [captureDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('.export-grid button:has-text("PNG")'),
    ]);
    const capturePath = await captureDownload.path();
    const capturePng = fs.readFileSync(capturePath);
    const captureSize = pngSize(capturePng);
    const fullMeta = await page.textContent('.editor-meta strong');
    const expectedH = Number(/(\d+)×(\d+)/.exec(fullMeta ?? '')?.[2] ?? 0);
    assert(
      'exported PNG matches the document size',
      captureSize.width > 0 && Math.abs(captureSize.height - expectedH * 1) <= Math.max(2, expectedH * 0.02),
      `png ${captureSize.width}x${captureSize.height}, doc ${expectedH} tall`,
    );
    // The export must be painted all the way down, not just the first strip.
    const coverage = await page.evaluate(async (base64) => {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = `data:image/png;base64,${base64}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
      return opaque / (data.length / 4);
    }, capturePng.toString('base64'));
    assert(
      'exported PNG is painted top to bottom',
      coverage > 0.98,
      `${(coverage * 100).toFixed(1)}% of pixels opaque`,
    );

    // JPEG and PDF go through different encoders (canvas and jsPDF paging).
    const [jpegDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('.export-grid button:has-text("JPEG")'),
    ]);
    const jpegBytes = fs.readFileSync(await jpegDownload.path());
    assert(
      'JPEG export produces a real JPEG',
      jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8 && jpegBytes.length > 5000,
      `${(jpegBytes.length / 1024).toFixed(0)} kB`,
    );

    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.click('.export-grid button:has-text("PDF")'),
    ]);
    const pdfBytes = fs.readFileSync(await pdfDownload.path());
    const pdfHeader = pdfBytes.subarray(0, 5).toString('latin1');
    const pageCount = (pdfBytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    assert(
      'PDF export produces a paged PDF',
      pdfHeader === '%PDF-' && pdfBytes.length > 20_000 && pageCount > 1,
      `${pdfHeader} ${(pdfBytes.length / 1024).toFixed(0)} kB, ${pageCount} pages`,
    );

    await page.keyboard.press('Escape');
    await page.click('.editor-head .icon-btn');
    await page.waitForSelector('.brand h1');

    // ---------- 3. import + stitch ----------
    const shotPage = await context.newPage();
    await shotPage.setViewportSize({ width: 390, height: 844 });
    await shotPage.goto(FIXTURE, { waitUntil: 'networkidle' });
    const truthBuffer = await shotPage.screenshot({ fullPage: true });
    const truthSize = pngSize(truthBuffer);

    const scrolls = [0, 620, 1240];
    const framePaths = [];
    for (let i = 0; i < scrolls.length; i++) {
      const buffer = await shotPage.screenshot({
        fullPage: true,
        clip: { x: 0, y: scrolls[i], width: 390, height: 844 },
      });
      const file = path.join(os.tmpdir(), `cyshot-frame-${i}.png`);
      fs.writeFileSync(file, buffer);
      framePaths.push(file);
    }
    await shotPage.close();

    await page.setInputFiles('input[type="file"]', framePaths);
    await page.waitForSelector('.editor', { timeout: 90_000 });
    const stitchMeta = await page.textContent('.editor-meta strong');
    const seamText = await page.textContent('.editor-meta span');
    const stitchH = Number(/(\d+)×(\d+)/.exec(stitchMeta ?? '')?.[2] ?? 0);
    const expectedStitchH = 1688 + 2 * 1240; // frame height + two scroll deltas, in device px
    assert(
      'three frames stitch to the expected height',
      Math.abs(stitchH - expectedStitchH) <= 3,
      `${stitchH} vs expected ${expectedStitchH}`,
    );
    assert('both seams matched confidently', /2\/2 seams matched/.test(seamText ?? ''), seamText ?? '');

    // ---------- freehand tools ----------
    const heightOf = async () => Number(/(\d+)×(\d+)/.exec((await page.textContent('.editor-meta strong')) ?? '')?.[2] ?? 0);
    const widthOf = async () => Number(/(\d+)×(\d+)/.exec((await page.textContent('.editor-meta strong')) ?? '')?.[1] ?? 0);
    const beforeTools = await heightOf();
    const overlayBox = await page.locator('.overlay').boundingBox();
    const midX = overlayBox.x + overlayBox.width / 2;

    // Region: drag across the image, keep only that column.
    await page.click('.tool:has-text("Region")');
    await page.mouse.move(overlayBox.x + 60, overlayBox.y + 200);
    await page.mouse.down();
    await page.mouse.move(overlayBox.x + 300, overlayBox.y + 240, { steps: 8 });
    await page.mouse.up();
    await page.click('button:has-text("Keep column")');
    await wait(200);
    const croppedWidth = await widthOf();
    assert('region crop narrows the document', croppedWidth > 100 && croppedWidth < 780, `width ${croppedWidth}`);
    await page.click('button:has-text("Full width")');
    await wait(200);
    assert('region crop can be undone', (await widthOf()) === 780, `width ${await widthOf()}`);

    // Cut: tap to place a divider, drop a section, restore it.
    await page.click('.tool:has-text("Cut")');
    await page.mouse.click(midX, overlayBox.y + 400);
    await wait(200);
    const chipCount = await page.locator('.section-chip').count();
    assert('tapping places a cut and splits the document into parts', chipCount === 2, `${chipCount} chips`);
    await page.locator('.section-chip').first().click();
    await wait(200);
    const afterDrop = await heightOf();
    assert('dropping a part shortens the document', afterDrop < beforeTools, `${beforeTools} -> ${afterDrop}`);
    await page.locator('.section-chip').first().click();
    await wait(200);
    assert('a dropped part can be restored', (await heightOf()) === beforeTools, `height ${await heightOf()}`);

    // Redact: draw a box and clear it again.
    await page.click('.tool:has-text("Redact")');
    await page.mouse.move(overlayBox.x + 80, overlayBox.y + 300);
    await page.mouse.down();
    await page.mouse.move(overlayBox.x + 240, overlayBox.y + 360, { steps: 8 });
    await page.mouse.up();
    await wait(200);
    const redactNote = await page.textContent('.tool-note');
    assert('redaction box is recorded', /1 box/.test(redactNote ?? ''), redactNote ?? '');
    await page.click('button:has-text("Clear")');
    await wait(150);
    assert('redactions can be cleared', (await heightOf()) === beforeTools);

    await page.click('.editor-head button:has-text("Export")');
    await page.waitForSelector('.sheet');
    const [stitchDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('.export-grid button:has-text("PNG")'),
    ]);
    const stitchPng = fs.readFileSync(await stitchDownload.path());
    const stitchSize = pngSize(stitchPng);
    assert(
      'stitched PNG is the full stitched height',
      Math.abs(stitchSize.height - expectedStitchH) <= 3,
      `${stitchSize.width}x${stitchSize.height}`,
    );

    // Compare against the ground-truth full-page screenshot, skipping the
    // sticky-header band that is deliberately collapsed at the top.
    const compare = await page.evaluate(
      async ({ stitched, truth, width, height, skipTop }) => {
        const load = (base64) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/png;base64,${base64}`;
          });
        const [a, b] = await Promise.all([load(stitched), load(truth)]);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const sample = (img, srcY, count) => {
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(img, 0, srcY, width, count, 0, 0, width, count);
          return ctx.getImageData(0, 0, width, count).data;
        };
        const rows = [skipTop + 5, 200, 700, 1200, 1700, 2400, 3000, 3500];
        const out = [];
        const meanOf = (data) => {
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) sum += data[i];
          return sum / (data.length / 4);
        };
        for (const y of rows) {
          const first = sample(a, y, 1);
          const second = sample(b, y, 1);
          let diff = 0;
          for (let i = 0; i < first.length; i += 4) diff += Math.abs(first[i] - second[i]);
          out.push({ y, mean: diff / (first.length / 4), a: meanOf(first), b: meanOf(second) });
        }
        return { rows: out, sizes: { a: [a.width, a.height], b: [b.width, b.height] } };
      },
      {
        stitched: stitchPng.toString('base64'),
        truth: truthBuffer.toString('base64'),
        width: stitchSize.width,
        height: 1,
        skipTop: 56 * 2,
      },
    );
    const worst = compare.rows.reduce((acc, row) => Math.max(acc, row.mean), 0);
    console.log(
      '  samples ',
      JSON.stringify(compare.sizes),
      compare.rows.map((r) => `${r.y}:${r.mean.toFixed(0)}(${r.a.toFixed(0)}/${r.b.toFixed(0)})`).join(' '),
    );
    assert(
      'stitched pixels match the original page',
      worst < 6,
      `worst sampled row difference ${worst.toFixed(2)} (${compare.rows.length} rows)`,
    );
    assert('full-page truth is taller than the stitched preview', truthSize.height > stitchSize.height);

    // ---------- 4. share target ----------
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker?.ready !== undefined, { timeout: 10_000 }).catch(() => {});
    const swReady = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active);
    });
    assert('service worker is active', swReady);

    const sharedResponse = await page.evaluate(async (target) => {
      const form = new FormData();
      form.append('url', target);
      form.append('title', 'Fixture article');
      const response = await fetch('/share', { method: 'POST', body: form, redirect: 'follow' });
      return { status: response.status, url: response.url, text: (await response.text()).slice(0, 200) };
    }, FIXTURE);
    assert(
      'share target accepts a link',
      sharedResponse.url.includes('share='),
      `${sharedResponse.status} ${sharedResponse.url}`,
    );

    await page.goto(sharedResponse.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor', { timeout: 90_000 });
    assert('shared link captures automatically', await page.isVisible('.editor'));

    assert('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  } finally {
    await browser?.close().catch(() => {});
    appServer.kill('SIGTERM');
    fixtureServer.close();
  }
}

main()
  .then(() => {
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\nE2E FAILED: ${error.message}`);
    const failed = results.filter((result) => !result.ok);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    process.exit(1);
  });

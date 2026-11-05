/**
 * Regression test for full-page capture at the page edges.
 *
 *   npm run test:capture
 *
 * Every fixture page ends in a blue <footer> and, where relevant, has the chrome
 * that breaks naive full-page shots layered on top:
 *   plain       - nothing special
 *   fixedheader - position:fixed top nav (most mobile sites)
 *   fixedbar    - position:fixed bottom bar (cookie banner / mobile nav)
 *   stickybar   - position:sticky bottom bar
 *   vhhero      - a 100vh hero
 *   tall        - ~18k CSS px, past the old single-shot cap
 *
 * The assertions are pixel-level: the blue footer must sit at the last rows of
 * the image, and a pinned bar must sit at the bottom rather than floating in the
 * middle. Sampling only the top and bottom bands keeps this under a minute.
 */
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createCaptureHandler } from '../server/capture-core.mjs';
import { launchChromium } from '../server/launch-chromium.mjs';
import { prepareBrowserEnv } from '../server/browser-env.mjs';

prepareBrowserEnv(process.cwd());

const GREEN = [0, 128, 0];
const BLUE = [0, 0, 255];
const RED = [255, 0, 0];

const fixture = ({ fixedHeader = false, fixedBar = false, stickyBar = false, vhHero = false, rows = 26 }) => `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>chrome fixture</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#fff;color:#111}
  ${fixedHeader ? 'body{padding-top:64px}' : ''}
  header{${fixedHeader ? 'position:fixed;top:0;left:0;right:0;' : ''}height:64px;background:rgb(0,128,0);color:#fff;z-index:50}
  .hero{${vhHero ? 'min-height:100vh;' : 'height:300px;'}background:#eef;padding:24px}
  .row{height:90px;padding:14px;border-bottom:1px solid #ddd}
  footer{background:rgb(0,0,255);color:#fff;height:220px;padding:24px;font-weight:700}
  footer h2{margin:0 0 8px}
  .bar{height:80px;background:rgb(255,0,0);color:#fff;display:flex;align-items:center;justify-content:center;
    ${fixedBar ? 'position:fixed;left:0;right:0;bottom:0;' : ''}
    ${stickyBar ? 'position:sticky;bottom:0;' : ''}
    ${!fixedBar && !stickyBar ? 'display:none;' : ''}}
</style></head><body>
<div class="hero"><h1>Hero</h1></div>
<div id="content"></div>
<footer><h2>THE REAL FOOTER</h2><p>Copyright notice and links live here.</p></footer>
<script>
  if (${fixedHeader}) {
    const h = document.createElement('header');
    h.textContent = 'SITE HEADER';
    document.body.appendChild(h);
  }
  for (let i = 0; i < ${rows}; i++) {
    const d = document.createElement('div');
    d.className = 'row';
    d.textContent = 'Content row ' + i + ' - the quick brown fox jumps over the lazy dog.';
    document.getElementById('content').appendChild(d);
  }
  if (${fixedBar} || ${stickyBar}) {
    const b = document.createElement('div');
    b.className = 'bar';
    b.textContent = 'BOTTOM BAR';
    document.body.appendChild(b);
  }
</script></body></html>`;

const scenarios = {
  plain: fixture({}),
  fixedheader: fixture({ fixedHeader: true }),
  fixedbar: fixture({ fixedBar: true }),
  stickybar: fixture({ stickyBar: true }),
  vhhero: fixture({ vhHero: true }),
  tall: fixture({ rows: 200 }),
};

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

const server = http.createServer((req, res) => {
  const key = new URL(req.url, 'http://x').pathname.replace(/\//g, '') || 'plain';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(scenarios[key] ?? scenarios.plain);
});

const handler = createCaptureHandler({ launch: launchChromium, budgetBytes: 40_000_000 });
const apiServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      req.body = {};
    }
    handler(req, res);
  });
});

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

/**
 * Finds rows painted in each chrome colour. Only the first and last bands of
 * the image are sampled: a 50k px capture is too slow to scan row by row, and
 * the bug this guards against is always at an edge.
 */
async function analyse(browser, buffer, mime) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  const result = await page.evaluate(
    async ({ src, targets }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('decode failed'));
        img.src = src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const near = (data, i, rgb) =>
        Math.abs(data[i] - rgb[0]) < 40 && Math.abs(data[i + 1] - rgb[1]) < 40 && Math.abs(data[i + 2] - rgb[2]) < 40;

      const rows = new Set();
      for (let y = 0; y < Math.min(400, canvas.height); y += 2) rows.add(y);
      for (let y = Math.max(0, canvas.height - 500); y < canvas.height; y += 2) rows.add(y);

      const bands = targets.map(() => []);
      for (const y of rows) {
        const data = ctx.getImageData(0, y, Math.min(canvas.width, 200), 1).data;
        targets.forEach((rgb, index) => {
          let hits = 0;
          for (let i = 0; i < data.length; i += 4) if (near(data, i, rgb)) hits++;
          if (hits > 100) bands[index].push(y);
        });
      }
      const ranges = bands.map((hits) => {
        const out = [];
        for (const y of hits.sort((a, b) => a - b)) {
          const last = out[out.length - 1];
          if (last && y - last[1] <= 4) last[1] = y;
          else out.push([y, y]);
        }
        return out;
      });
      return { width: canvas.width, height: canvas.height, ranges };
    },
    { src: dataUrl, targets: [GREEN, BLUE, RED] },
  );
  await context.close();
  return result;
}

const main = async () => {
  process.env.ALLOW_PRIVATE = '1';
  const fixturePort = await listen(server);
  const apiPort = await listen(apiServer);
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  const only = process.argv[2];

  for (const [name, html] of Object.entries(scenarios)) {
    if (only && name !== only) continue;

    const truthCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const truthPage = await truthCtx.newPage();
    await truthPage.setContent(html);
    const docHeight = await truthPage.evaluate(() => document.documentElement.scrollHeight);
    await truthCtx.close();

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${fixturePort}/${name}`, preset: 'iphone' }),
      signal: AbortSignal.timeout(180_000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200) {
      check(`${name}: capture succeeded`, false, `${response.status} ${buffer.toString().slice(0, 160)}`);
      continue;
    }

    const scale = Number(response.headers.get('x-cyshot-scale')) || 3;
    const cssHeight = Number(response.headers.get('x-cyshot-css-height'));
    const truncated = response.headers.get('x-cyshot-truncated') === '1';
    const shot = await analyse(browser, buffer, response.headers.get('content-type'));
    const toCss = (px) => px / scale;

    const [green, blue, red] = shot.ranges;
    const blueEnd = blue.length ? blue[blue.length - 1][1] : 0;
    const blueStart = blue.length ? blue[0][0] : Infinity;
    const redEnd = red.length ? red[red.length - 1][1] : 0;
    const redStart = red.length ? red[0][0] : Infinity;

    console.log(
      `\n=== ${name} === doc ${docHeight} css, capture ${shot.width}x${shot.height}px ` +
        `(${cssHeight} css @${scale}x), ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    console.log(
      `  green ${JSON.stringify(green.map(([a, b]) => [Math.round(toCss(a)), Math.round(toCss(b))]))} ` +
        `blue ${JSON.stringify(blue.map(([a, b]) => [Math.round(toCss(a)), Math.round(toCss(b))]))} ` +
        `red ${JSON.stringify(red.map(([a, b]) => [Math.round(toCss(a)), Math.round(toCss(b))]))}`,
    );

    check(`${name}: nothing truncated`, truncated === false, `truncated=${truncated}`);
    check(
      `${name}: image reaches the document bottom`,
      Math.abs(shot.height / scale - docHeight) <= 4,
      `${(shot.height / scale).toFixed(0)} vs ${docHeight} css`,
    );
    // A docked bar legitimately overlays the last strip of the footer, so the
    // footer must end where the bar starts, not at the image edge.
    const contentEnd = name === 'fixedbar' || name === 'stickybar' ? redStart : shot.height;
    check(
      `${name}: blue footer reaches the end of the page content`,
      blue.length > 0 && Math.abs(blueEnd / scale - contentEnd / scale) <= 10,
      `footer ends at ${Math.round(blueEnd / scale)} of ${Math.round(contentEnd / scale)} css`,
    );

    if (name === 'fixedheader') {
      check(
        'fixedheader: green nav pinned to the very top, once',
        green.length > 0 && toCss(green[0][0]) <= 4 && toCss(green[0][1]) <= 70,
        JSON.stringify(green.map(([a, b]) => [Math.round(toCss(a)), Math.round(toCss(b))])),
      );
    }
    if (name === 'fixedbar' || name === 'stickybar') {
      check(
        `${name}: bar pinned to the page bottom, not the first viewport`,
        red.length > 0 && Math.abs(redEnd / scale - shot.height / scale) <= 10,
        `bar ${Math.round(redStart / scale)}..${Math.round(redEnd / scale)} css`,
      );
      check(
        `${name}: only one bar band`,
        red.length === 1,
        `${red.length} bands`,
      );
    }
    if (name === 'plain') {
      check(
        'plain: footer covers the last 200 css px',
        shot.height / scale - blueStart / scale > 150,
        `${Math.round((shot.height - blueStart) / scale)} css`,
      );
    }
  }

  await browser.close();
  server.closeAllConnections?.();
  apiServer.closeAllConnections?.();
  server.close();
  apiServer.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error('capture test crashed:', error);
  process.exit(1);
});

import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { prepareBrowserEnv } from '../server/browser-env.mjs';

prepareBrowserEnv(process.cwd());

const APP = 'http://127.0.0.1:8791';
const fixture = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:0;font:16px/1.4 system-ui} .row{height:90px;border-bottom:1px solid #ddd}</style></head>
  <body><script>for(let i=0;i<70;i++){const d=document.createElement('div');d.className='row';d.textContent='Row '+i;document.body.appendChild(d)}</script></body></html>`);
});
await new Promise((r) => fixture.listen(8124, '127.0.0.1', r));

void spawn;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: Number(process.env.VW ?? 390), height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => console.log(`CONSOLE[${m.type()}]`, m.text().slice(0, 300)));
page.on('crash', () => console.log('PAGE CRASH'));
page.on('close', () => console.log('PAGE CLOSED'));

await wait(1500);
await page.goto(APP, { waitUntil: 'networkidle' });
await page.fill('#url', 'http://127.0.0.1:8124/');
await page.click('form.card button[type="submit"]');
await page.waitForSelector('.editor', { timeout: 90_000 });
console.log('editor open', await page.textContent('.editor-meta strong'));

await page.click('.tool:has-text("Region")');
console.log('region tool clicked');
const overlayBox = await page.locator('.overlay').boundingBox();
console.log('overlay', overlayBox);
await page.mouse.move(overlayBox.x + 60, overlayBox.y + 200);
await page.mouse.down();
console.log('mouse down, closed?', page.isClosed());
await page.mouse.move(overlayBox.x + 300, overlayBox.y + 240, { steps: 8 });
console.log('mouse moved, closed?', page.isClosed());
await page.mouse.up();
await wait(300);
console.log('mouse up, closed?', page.isClosed());

if (!page.isClosed()) {
  console.log('rect count', await page.locator('.region-rect').count());
  console.log('keep disabled', await page.locator('button:has-text("Keep column")').isDisabled());
}

await page.click('.tool:has-text("Redact")');
await page.evaluate(() => {
  document.querySelector('.scroller').scrollTop = 0;
});
await wait(150);
const scrollerBox = await page.locator('.scroller').boundingBox();
const overlayBox2 = await page.locator('.overlay').boundingBox();
console.log('scroller', scrollerBox, 'overlay', overlayBox2);
await page.evaluate(() => {
  window.__ptr = [];
  const overlay = document.querySelector('.overlay');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
    overlay.addEventListener(type, (event) => {
      window.__ptr.push(`${type}@${Math.round(event.clientY)} b=${event.buttons} type=${event.pointerType} id=${event.pointerId}`);
    }, true);
  }
  window.__touchAction = getComputedStyle(overlay).touchAction;
});
console.log('touch-action', await page.evaluate(() => window.__touchAction));
await page.mouse.move(120, overlayBox2.y + 100);
await page.mouse.down();
await page.mouse.move(320, scrollerBox.y + scrollerBox.height - 12, { steps: 4 });
console.log('events', JSON.stringify(await page.evaluate(() => window.__ptr)));
for (let i = 0; i < 6; i++) {
  await wait(150);
  const state = await page.evaluate(() => {
    const scroller = document.querySelector('.scroller');
    const rect = document.querySelector('.redact-rect');
    return { scroll: scroller?.scrollTop ?? -1, box: rect ? rect.getBoundingClientRect().height : -1 };
  });
  console.log('tick', i, JSON.stringify(state));
}
await page.mouse.up();
await wait(200);
console.log('after up note', await page.textContent('.tool-note').catch(() => 'none'));

await browser.close().catch(() => {});
fixture.close();
process.exit(0);

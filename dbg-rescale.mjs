import { chromium } from 'playwright-core';
import { prepareBrowserEnv } from './server/browser-env.mjs';
prepareBrowserEnv(process.cwd());
const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true });
const page = await ctx.newPage();
await page.setContent('<div style="height:3000px;background:linear-gradient(red,blue)">hi</div>');
try {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1.5, mobile: true });
  console.log('CDP override ok');
} catch (e) {
  console.log('CDP failed:', e.message);
}
const shot = await page.screenshot({ fullPage: true });
const w = shot.readUInt32BE(16), h = shot.readUInt32BE(20);
console.log('screenshot', w, 'x', h, '(expect 585 wide if dsf=1.5 took effect, 1170 if not)');
await b.close();

/**
 * GET /api/health            - liveness, no browser boot
 * GET /api/health?chromium=1 - actually launches the browser, to prove a deploy works
 */
import { isServerless, launchChromium } from '../server/launch-chromium.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const deep = url.searchParams.get('chromium') === '1';

  const payload = {
    ok: true,
    runtime: process.env.VERCEL ? 'vercel' : 'node',
    serverlessChromium: isServerless(),
    privateUrlsAllowed: process.env.ALLOW_PRIVATE === '1',
  };

  if (deep) {
    try {
      const browser = await launchChromium();
      const version = browser.version();
      payload.chromium = browser.isConnected() ? 'ok' : 'disconnected';
      payload.chromiumVersion = version;
      await browser.close().catch(() => {});
    } catch (error) {
      payload.ok = false;
      payload.chromium = 'failed';
      payload.chromiumError = String(error?.message || error).split('\n')[0].slice(0, 400);
    }
  }

  res.statusCode = payload.ok ? 200 : 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

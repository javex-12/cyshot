/**
 * Capture core: the page work, minus any opinion about where it runs.
 *
 * Used by two hosts:
 *   - server/index.mjs  (self-hosted Express)
 *   - api/capture.mjs   (Vercel function)
 *
 * The response is a binary image with metadata in headers rather than base64
 * JSON, because Vercel caps response bodies at 4.5 MB. When the encoded image
 * would exceed the budget the encoding degrades in steps:
 *   lossless PNG  ->  JPEG  ->  half-resolution JPEG  ->  a clear error.
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Chromium renders 45k px in ~20s and times out near 120k, so cap the CSS height. */
export const MAX_CAPTURE_CSS_PX = 15_000;

export const PRESETS = {
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  android: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  desktop: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

const clampInt = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const clampNum = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

export function isPrivateAddress(ip) {
  if (!ip) return false;
  if (ip.includes('.')) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return false;
}

/**
 * Refuses anything but a public http(s) URL, so the service cannot be pointed
 * at a private network. ALLOW_PRIVATE=1 relaxes it for local development.
 */
export async function assertSafeUrl(raw, { allowPrivate = false, lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new HttpError(400, 'That does not look like a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https URLs can be captured.');
  }
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new HttpError(400, 'Local addresses are blocked.');
  }
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
  if (isIp) {
    if (isPrivateAddress(host)) throw new HttpError(400, 'Local addresses are blocked.');
    return url;
  }

  const resolve = lookup ?? (await import('node:dns/promises')).lookup;
  let addresses;
  try {
    addresses = await resolve(host, { all: true });
  } catch {
    throw new HttpError(400, `Could not resolve ${host}.`);
  }
  if (!addresses?.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new HttpError(400, 'Local addresses are blocked.');
  }
  return url;
}

/** Scroll the document once so lazy content renders, then come back to the top. */
async function preparePage(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.round(window.innerHeight * 0.85));
    const limit = Math.min(document.documentElement.scrollHeight, 60_000);
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  await page
    .evaluate(async () => {
      const pending = Array.from(document.images).filter((img) => !img.complete);
      await Promise.all(pending.map((img) => img.decode().catch(() => {})));
    })
    .catch(() => {});

  await page
    .addStyleTag({
      content: `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}
      html{scroll-behavior:auto!important}`,
    })
    .catch(() => {});
}

async function captureOnce(browser, url, options, budgetBytes) {
  const preset = PRESETS[options.preset] ?? PRESETS.iphone;
  const viewportWidth = clampInt(options.width, 200, 2400, preset.width);
  const viewportHeight = clampInt(options.height, 200, 3000, preset.height);
  const dsf = clampNum(options.deviceScaleFactor, 1, 4, preset.deviceScaleFactor);
  const cssLimit = clampInt(options.maxHeight, 1000, MAX_CAPTURE_CSS_PX, MAX_CAPTURE_CSS_PX);
  const waitMs = clampInt(options.waitMs, 0, 5000, 350);

  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: dsf,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
    userAgent: preset.userAgent,
    colorScheme: options.darkMode ? 'dark' : 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    let response;
    try {
      response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      throw new HttpError(502, `Could not load that page (${String(error.message || error).split('\n')[0]}).`);
    }

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await preparePage(page);
    await page.waitForTimeout(waitMs);

    const dims = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        width: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth),
        height: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight),
      };
    });

    const cssWidth = Math.max(1, Math.round(dims.width));
    const cssHeight = Math.max(1, Math.round(Math.min(dims.height, cssLimit)));
    const truncated = dims.height > cssHeight;
    const clip = { x: 0, y: 0, width: cssWidth, height: cssHeight };
    const shot = { fullPage: true, clip, animations: 'disabled', caret: 'hide', timeout: 60_000 };

    let buffer = await page.screenshot({ ...shot, type: 'png' });
    let contentType = 'image/png';
    let downscaled = false;

    if (buffer.length > budgetBytes) {
      const jpeg = await page.screenshot({ ...shot, type: 'jpeg', quality: 84 });
      if (jpeg.length <= budgetBytes) {
        buffer = jpeg;
        contentType = 'image/jpeg';
      } else {
        const half = await page.screenshot({ ...shot, type: 'jpeg', quality: 78, scale: 'css' });
        if (half.length > budgetBytes) {
          throw new HttpError(
            413,
            'That page is too large to return as a single image. Try a shorter page, a smaller device preset, or lower maxHeight.',
          );
        }
        buffer = half;
        contentType = 'image/jpeg';
        downscaled = true;
      }
    }

    const title = await page.title().catch(() => '');
    return {
      buffer,
      contentType,
      width: Math.round(cssWidth * (downscaled ? 1 : dsf)),
      height: Math.round(cssHeight * (downscaled ? 1 : dsf)),
      cssWidth,
      cssHeight,
      truncated,
      downscaled,
      status: response ? response.status() : null,
      title,
      finalUrl: page.url(),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Builds an HTTP handler. `launch` must return a Playwright-compatible browser.
 */
export function createCaptureHandler({ launch, budgetBytes = 4_400_000, maxActive = 2 } = {}) {
  let browserPromise = null;
  let active = 0;
  const waiting = [];

  async function getBrowser() {
    if (browserPromise) {
      const existing = await browserPromise.catch(() => null);
      if (existing && existing.isConnected()) return existing;
      browserPromise = null;
    }
    browserPromise = Promise.resolve(launch()).catch((error) => {
      browserPromise = null;
      throw error;
    });
    return browserPromise;
  }

  async function acquire() {
    if (active < maxActive) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  }

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return async function handler(req, res) {
    const sendJson = (status, payload) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(payload));
    };

    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new HttpError(405, 'Send a POST request with a JSON body.');
      }

      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          throw new HttpError(400, 'The request body was not valid JSON.');
        }
      }
      body = body ?? {};

      const url = await assertSafeUrl(body.url, {
        allowPrivate: process.env.ALLOW_PRIVATE === '1',
      });

      await acquire();
      try {
        const browser = await getBrowser();
        const result = await captureOnce(browser, url, body, budgetBytes);

        res.statusCode = 200;
        res.setHeader('content-type', result.contentType);
        res.setHeader('content-length', String(result.buffer.length));
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-cyshot-width', String(result.width));
        res.setHeader('x-cyshot-height', String(result.height));
        res.setHeader('x-cyshot-css-width', String(result.cssWidth));
        res.setHeader('x-cyshot-css-height', String(result.cssHeight));
        res.setHeader('x-cyshot-truncated', result.truncated ? '1' : '0');
        res.setHeader('x-cyshot-downscaled', result.downscaled ? '1' : '0');
        res.setHeader('x-cyshot-title', encodeURIComponent(result.title ?? ''));
        res.setHeader('x-cyshot-url', encodeURIComponent(result.finalUrl ?? ''));
        res.end(result.buffer);
      } finally {
        release();
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : `Capture failed: ${String(error?.message || error).split('\n')[0]}`;
      if (status >= 500) console.error('[capture]', error);
      sendJson(status, { ok: false, error: message });
    }
  };
}

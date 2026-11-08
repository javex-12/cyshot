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

/**
 * Limits. A single shot past ~66k device px starts timing out, so the capture
 * spends a budget of device px instead of a fixed CSS height: tall pages are
 * shot at a lower device scale factor so the WHOLE page - footer included -
 * still fits in one image. Only past the CSS ceiling is anything cut off.
 */
export const MAX_CAPTURE_CSS_PX = 30_000;
export const MAX_DEVICE_PX = 80_000;
export const MIN_SCALE = 0.5;

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

/**
 * Pin `position: fixed` chrome where the reader would actually find it.
 *
 * A fixed header or cookie bar is painted once, against the viewport, so on a
 * full-page shot a bottom bar lands in the middle of the image and any bar
 * disappears from the end of the page. Converting those boxes to absolute puts
 * a top bar at the top of the image and a bottom bar at the bottom, which is
 * what the page looks like when you reach either end.
 *
 * Sticky boxes keep their normal-flow space, so they are simply unstuck
 * (`position: static`). That leaves a sticky header at the document top and a
 * sticky bottom bar in flow at the end of the page, instead of both being
 * painted against a viewport that no longer matches the image.
 *
 * Fixed boxes take their size and position from a dock, so they are converted
 * to absolute at the matching page edge. They are already out of flow, so this
 * cannot change the document height.
 */
async function pinChrome(page, { bottom, viewportHeight }) {
  await page
    .evaluate(
      ({ bottom, viewportHeight }) => {
        const pinned = [];
        const unstuck = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 4) continue;

          const atTop = rect.top <= 8;
          const atBottom = rect.bottom >= viewportHeight - 8;
          if (!atTop && !atBottom) continue;

          if (cs.position === 'sticky') {
            unstuck.push({ el, atTop });
            continue;
          }

          const docX = rect.left + window.scrollX;
          const docY = atBottom && !atTop ? bottom - rect.height : rect.top + window.scrollY;
          pinned.push({ el, docX, docY, width: rect.width, height: rect.height });
        }
        for (const { el, docX, docY, width, height } of pinned) {
          el.style.setProperty('position', 'absolute', 'important');
          el.style.setProperty('top', `${docY}px`, 'important');
          el.style.setProperty('left', `${docX}px`, 'important');
          el.style.setProperty('right', 'auto', 'important');
          el.style.setProperty('bottom', 'auto', 'important');
          el.style.setProperty('width', `${width}px`, 'important');
          el.style.setProperty('height', `${height}px`, 'important');
          el.style.setProperty('transform', 'none', 'important');
        }
        // Sticky bars are in flow: drop back to static so they stay in place.
        for (const { el } of unstuck) {
          el.style.setProperty('position', 'static', 'important');
        }
        return pinned.length + unstuck.length;
      },
      { bottom, viewportHeight },
    )
    .catch(() => 0);
}

async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      width: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth),
      height: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight),
    };
  });
}

/**
 * Cookies for a signed-in capture.
 *
 * Accepts the shapes people actually have: a `Cookie:` request header copied
 * from DevTools, a bare `a=1; b=2` string, a JSON array exported by a cookie
 * extension, or `{a: '1'}`. Anything without a domain is scoped to the target
 * URL, so a paste can never leak to another site.
 */
export function normaliseCookies(raw, url) {
  const origin = url.origin;
  const out = [];
  const push = (name, value, extra = {}) => {
    if (!name || typeof value !== 'string') return;
    const cookie = { name: String(name).trim(), value };
    if (extra.domain) {
      cookie.domain = String(extra.domain);
      cookie.path = extra.path || '/';
    } else {
      cookie.url = origin;
    }
    out.push(cookie);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') push(item.name, item.value, item);
    }
    return out.slice(0, 300);
  }

  if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) push(name, String(value));
    return out.slice(0, 300);
  }

  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim().replace(/^cookie:\s*/i, '');
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        return normaliseCookies(JSON.parse(text), url);
      } catch {
        // Fall through: treat it as a plain cookie string.
      }
    }
    for (const part of text.split(';')) {
      const index = part.indexOf('=');
      if (index < 1) continue;
      push(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
  return out.slice(0, 300);
}

export function normaliseHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (out && Object.keys(out).length >= 20) break;
    out[String(name).trim()] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
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
  const defaultDsf = options.quality === 'best'
    ? (options.preset === 'desktop' ? 2 : preset.deviceScaleFactor)
    : options.quality === 'high'
      ? Math.min(2, preset.deviceScaleFactor)
      : options.quality === 'standard'
        ? 1
        : preset.deviceScaleFactor;
  const dsf = clampNum(options.deviceScaleFactor, 1, 4, defaultDsf);
  const cssLimit = clampInt(options.maxHeight, 1000, MAX_CAPTURE_CSS_PX, MAX_CAPTURE_CSS_PX);
  const waitMs = clampInt(options.waitMs, 0, 5000, 350);

  const cookies = normaliseCookies(options.cookies, url);
  const headers = normaliseHeaders(options.headers);

  const open = async (scale) => {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: scale,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      userAgent: preset.userAgent,
      colorScheme: options.darkMode ? 'dark' : 'light',
      reducedMotion: 'reduce',
      locale: 'en-US',
    });

    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);

      if (cookies.length > 0) {
        try {
          await context.addCookies(cookies);
        } catch (error) {
          throw new HttpError(
            400,
            `Those cookies could not be used (${String(error.message || error).split('\n')[0]}). Copy the Cookie header again.`,
          );
        }
      }
      if (headers) await page.setExtraHTTPHeaders(headers).catch(() => {});

      let response;
      try {
        response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (error) {
        throw new HttpError(502, `Could not load that page (${String(error.message || error).split('\n')[0]}).`);
      }

      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await preparePage(page);
      await page.waitForTimeout(waitMs);

      return { context, page, response, dims: await measure(page) };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  };

  let session = await open(dsf);
  let { page, response, dims } = session;
  let scale = dsf;

  try {
    let cssWidth = Math.max(1, Math.round(dims.width));
    let cssHeight = Math.max(1, Math.round(Math.min(dims.height, cssLimit)));
    let truncated = dims.height > cssHeight;

    // Spend a device-pixel budget rather than a fixed height. When the whole
    // page would not fit in one shot, reload at a smaller scale so the bottom
    // of the page - footer included - is still captured.
    if (cssHeight * dsf > MAX_DEVICE_PX) {
      const smaller = Math.max(MIN_SCALE, Math.round((MAX_DEVICE_PX / cssHeight) * 100) / 100);
      if (smaller < dsf - 0.02) {
        await session.context.close().catch(() => {});
        session = await open(smaller);
        ({ page, response, dims } = session);
        scale = smaller;
        cssWidth = Math.max(1, Math.round(dims.width));
        cssHeight = Math.max(1, Math.round(Math.min(dims.height, cssLimit)));
        truncated = dims.height > cssHeight;
      }
    }

    await pinChrome(page, { bottom: cssHeight, viewportHeight });

    const clip = { x: 0, y: 0, width: cssWidth, height: cssHeight };
    const shot = { fullPage: true, clip, animations: 'disabled', caret: 'hide', timeout: 60_000 };

    let buffer = await page.screenshot({ ...shot, type: 'png' });
    let contentType = 'image/png';
    let downscaled = false;

    if (buffer.length > budgetBytes) {
      const jpeg90 = await page.screenshot({ ...shot, type: 'jpeg', quality: 90 });
      if (jpeg90.length <= budgetBytes) {
        buffer = jpeg90;
        contentType = 'image/jpeg';
      } else {
        const jpeg82 = await page.screenshot({ ...shot, type: 'jpeg', quality: 82 });
        if (jpeg82.length <= budgetBytes) {
          buffer = jpeg82;
          contentType = 'image/jpeg';
        } else {
          const smaller = await page.screenshot({ ...shot, type: 'jpeg', quality: 78, scale: 'css' });
          if (smaller.length > budgetBytes) {
            throw new HttpError(
              413,
              'That page is too large to return as a single image. Try a shorter page or a smaller device preset.',
            );
          }
          buffer = smaller;
          contentType = 'image/jpeg';
          downscaled = true;
        }
      }
    }

    const outputScale = downscaled ? 1 : scale;
    const title = await page.title().catch(() => '');
    return {
      buffer,
      contentType,
      width: Math.round(cssWidth * outputScale),
      height: Math.round(cssHeight * outputScale),
      cssWidth,
      cssHeight,
      scale: outputScale,
      truncated,
      downscaled,
      status: response ? response.status() : null,
      title,
      finalUrl: page.url(),
    };
  } finally {
    await session.context.close().catch(() => {});
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
        res.setHeader('x-cyshot-scale', String(result.scale));
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

/**
 * Client for POST /api/capture.
 *
 * The API answers with a binary image and metadata in headers (Vercel caps
 * response bodies at 4.5 MB, so base64 JSON was not an option). Errors are JSON.
 */

export type Preset = 'iphone' | 'android' | 'desktop';

export interface CaptureRequest {
  url: string;
  preset: Preset;
  darkMode: boolean;
  maxHeight?: number;
  /** Cookie header text, or a JSON cookie export, for signed-in pages. */
  cookies?: string;
  /** Extra request headers, e.g. Authorization. */
  headers?: Record<string, string>;
}

export interface CaptureResult {
  blob: Blob;
  /** Pixel size of the returned image. */
  width: number;
  height: number;
  /** Size of the page in CSS px. */
  cssWidth: number;
  cssHeight: number;
  /** Raster scale actually used (below 1 means the page was very tall). */
  scale: number;
  /** The page was taller than the capture limit. */
  truncated: boolean;
  /** The image was returned at CSS resolution to fit the response budget. */
  downscaled: boolean;
  title: string;
  url: string;
}

/** The server spends a device-pixel budget; 30k CSS px is its ceiling. */
export const MAX_CAPTURE_HEIGHT = 30_000;

export function withScheme(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Parses pasted request headers, one `Name: value` per line, so a signed-in
 * capture can carry an Authorization token without a bespoke field for it.
 */
export function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf(':');
    if (index < 1) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function headerNumber(headers: Headers, name: string): number {
  const value = Number(headers.get(name) ?? '');
  return Number.isFinite(value) ? value : 0;
}

function headerText(headers: Headers, name: string): string {
  const raw = headers.get(name);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function capturePage(request: CaptureRequest): Promise<CaptureResult> {
  let response: Response;
  try {
    response = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: withScheme(request.url),
        preset: request.preset,
        darkMode: request.darkMode,
        maxHeight: request.maxHeight ?? MAX_CAPTURE_HEIGHT,
        cookies: request.cookies?.trim() || undefined,
        headers: request.headers,
      }),
    });
  } catch {
    throw new Error('The capture service is not reachable. Is the server running?');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Capture failed (${response.status}).`);
  }

  const blob = await response.blob();
  const scale = Number(response.headers.get('x-cyshot-scale') ?? '');
  return {
    blob,
    width: headerNumber(response.headers, 'x-cyshot-width'),
    height: headerNumber(response.headers, 'x-cyshot-height'),
    cssWidth: headerNumber(response.headers, 'x-cyshot-css-width'),
    cssHeight: headerNumber(response.headers, 'x-cyshot-css-height'),
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    truncated: response.headers.get('x-cyshot-truncated') === '1',
    downscaled: response.headers.get('x-cyshot-downscaled') === '1',
    title: headerText(response.headers, 'x-cyshot-title'),
    url: headerText(response.headers, 'x-cyshot-url'),
  };
}

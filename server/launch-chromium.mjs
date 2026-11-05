/**
 * One place that decides which Chromium to launch.
 *
 * - On Vercel / Lambda: @sparticuz/chromium (headless shell built for Lambda; its
 *   pack also carries the fonts a bare Lambda lacks, unpacked into /tmp).
 * - Everywhere else: the Playwright Chromium installed by `npm run setup`.
 *
 * Same launch flags and the same compatible Playwright API either way, so the
 * capture code never knows the difference.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { prepareBrowserEnv } from './browser-env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const LOCAL_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
];

let localEnvReady = false;

export function isServerless() {
  return Boolean(process.env.VERCEL) || process.env.CYSHOT_SERVERLESS_CHROMIUM === '1';
}

export async function launchChromium() {
  if (!isServerless()) {
    if (!localEnvReady) {
      prepareBrowserEnv(ROOT);
      localEnvReady = true;
    }
    return chromium.launch({ args: LOCAL_ARGS });
  }

  const sparticuz = (await import('@sparticuz/chromium')).default;
  const executablePath = await sparticuz.executablePath();
  // executablePath() unpacks chromium, fonts and swiftshader into /tmp.
  process.env.FONTCONFIG_PATH ??= '/tmp/fonts';
  process.env.HOME ??= '/tmp';
  return chromium.launch({ executablePath, args: sparticuz.args, headless: true });
}

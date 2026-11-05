/**
 * Vercel function: POST /api/capture
 *
 * The page work lives in server/capture-core.mjs and is shared with the
 * self-hosted Express server. This file only supplies a browser.
 */
import { createCaptureHandler } from '../server/capture-core.mjs';
import { launchChromium } from '../server/launch-chromium.mjs';

export default createCaptureHandler({ launch: launchChromium });

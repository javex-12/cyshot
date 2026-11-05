/**
 * Prepares the environment the bundled Chromium needs on a bare Linux host.
 *
 * Two things bite on minimal machines (containers, WSL without a desktop):
 *   1. Chromium's shared libraries are missing when there is no root to install
 *      them. scripts/vendor-browser-libs.py parks them in vendor/browser-libs.
 *   2. There are no fonts and no fontconfig, so Skia aborts the renderer the
 *      moment a page draws text. scripts/vendor-fonts.mjs parks TTFs in
 *      vendor/fonts; this module writes a fontconfig pointing at them.
 *
 * Both are no-ops on a normal desktop, where the directories do not exist.
 */
import fs from 'node:fs';
import path from 'node:path';

export function prepareBrowserEnv(root) {
  const libs = path.join(root, 'vendor', 'browser-libs');
  if (fs.existsSync(libs)) {
    process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }

  const fonts = path.join(root, 'vendor', 'fonts');
  if (!fs.existsSync(fonts)) return;

  const hasFonts = fs.readdirSync(fonts).some((name) => /\.(ttf|otf)$/i.test(name));
  if (!hasFonts) return;

  const confPath = path.join(fonts, 'fonts.conf');
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fonts}</dir>
  <cachedir>${path.join(fonts, '.cache')}</cachedir>
</fontconfig>
`;
  try {
    fs.writeFileSync(confPath, conf);
    process.env.FONTCONFIG_FILE = confPath;
    process.env.FONTCONFIG_PATH = fonts;
  } catch {
    // Read-only checkout: fall back to whatever the system provides.
  }
}

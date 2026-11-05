/**
 * Installs the fonts Chromium needs on a host without any.
 *
 * Minimal Linux images (and WSL installs without a desktop) ship no fonts, which
 * makes Chromium's renderer abort with
 * "SkFontMgr_FontConfigInterface: Not implemented" as soon as a page draws text.
 * The npm registry is used as the source because it is the one host that is
 * reliably reachable from a locked-down build machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const outDir = path.join(process.cwd(), 'vendor', 'fonts');
fs.mkdirSync(outDir, { recursive: true });

const WANTED = [
  '400Regular/Inter_400Regular.ttf',
  '600SemiBold/Inter_600SemiBold.ttf',
  '700Bold/Inter_700Bold.ttf',
];

const already = WANTED.every((entry) => fs.existsSync(path.join(outDir, path.basename(entry))));
if (!already) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyshot-fonts-'));
  try {
    const packed = execFileSync('npm', ['pack', '@expo-google-fonts/inter', '--pack-destination', work], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .pop();
    const tarball = path.join(work, packed);
    execFileSync('tar', [
      'xzf',
      tarball,
      '-C',
      work,
      '--strip-components=1',
      ...WANTED.map((entry) => `package/${entry}`),
    ]);
    for (const entry of WANTED) {
      const source = path.join(work, entry);
      const target = path.join(outDir, path.basename(entry));
      fs.copyFileSync(source, target);
      console.log(`wrote vendor/fonts/${path.basename(entry)}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
} else {
  console.log('fonts already present');
}

const count = fs.readdirSync(outDir).filter((name) => /\.(ttf|otf)$/i.test(name)).length;
if (count === 0) {
  console.error('no fonts available; Chromium will crash on pages that draw text');
  process.exit(1);
}
console.log(`${count} font file(s) ready`);

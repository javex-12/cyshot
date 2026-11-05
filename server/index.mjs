/**
 * Self-hosted server: the same capture handler the Vercel function uses, plus
 * static hosting for the built PWA.
 *
 *   npm run build && npm start
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareBrowserEnv } from './browser-env.mjs';
import captureHandler from '../api/capture.mjs';
import healthHandler from '../api/health.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 8787);

// Chromium needs libraries and fonts a bare host may not have.
prepareBrowserEnv(ROOT);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', healthHandler);
app.post('/api/capture', captureHandler);
app.all('/api/*splat', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Unknown endpoint.' });
});

if (IS_PROD) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/ is missing. Run `npm run build` first.');
    process.exit(1);
  }
  app.use(
    express.static(DIST, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  const mode = IS_PROD ? 'production' : 'api only (run vite for the UI)';
  console.log(`cyshot server on http://127.0.0.1:${PORT} - ${mode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

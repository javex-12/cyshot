# cyshot

Full-page screenshots on a phone: capture a whole web page, or stitch the screenshots
you already took into one long image, then trim it exactly where you want it to stop.

Runs as an installable PWA in any mobile browser, with a small Node service that does the
page capture. No account, and your own screenshots never leave the device — stitching and
editing happen in the browser.

## What it does

- **Capture a URL at Best Resolution.** Rendered in headless Chromium at an iPhone/Android/desktop
  viewport with Ultra HD (3x Retina), High (2x), and Standard (1x) options.
- **Capture ANY App or Website from Screen Recordings.** Turn a quick 3-second screen recording
  (.mp4, .mov, or live screen record) of any app (WhatsApp, Instagram, Twitter, Settings) or
  authorized web page into a pixel-perfect long screenshot.
- **Simple Authorized Web Capture.** Capture paywalled or logged-in pages on mobile easily via
  screen recording or a 1-tap Safari/Chrome Bookmarklet — no DevTools or cookie copying required.
- **High-Precision Stitching with Auto-Ordering.** Pick screenshots in any order (even reverse
  chronological from mobile photo pickers). Automatically removes sticky headers, status bars, and
  bottom navigation bars while preserving 100% full original resolution.
- **Freehand finishing.** Trim from the top or bottom at the scroll position you choose, place
  cuts and drop the parts you don't want, keep only a column, black out private details.
- **Export in Full Resolution.** 100% original quality PNG/JPEG, paged PDF, or directly to the OS share sheet.
- **Works seamlessly on iOS & Android.** Installable PWA with Android Web Share Target support and
  iOS Safari Bookmarklet & Home Screen guidance.

## Quick start

```bash
npm install
npm run setup      # vendored browser libs + fonts, and Playwright's Chromium
npm run dev        # vite on :5173, capture API on :8787
```

Open http://localhost:5173. To try it on your phone over the LAN, `HOST=0.0.0.0 npm run dev`.

Production:

```bash
npm run build
npm start          # serves dist/ and /api on :8787
```

### `npm run setup` on a bare Linux box

Chromium needs two things a minimal host (container, WSL without a desktop) does not have, and
both fail with unhelpful errors:

| Missing | Symptom | Fix |
| --- | --- | --- |
| Shared libraries (`libnss3`, `libgbm`, …) | `error while loading shared libraries` | `scripts/vendor-browser-libs.py` extracts the distro packages into `vendor/browser-libs` (no root needed) |
| Fonts / fontconfig | renderer dies with `SkFontMgr_FontConfigInterface: Not implemented` | `scripts/vendor-fonts.mjs` puts TTFs in `vendor/fonts` and writes a fontconfig for them |

`server/browser-env.mjs` points `LD_LIBRARY_PATH` and `FONTCONFIG_FILE` at those directories
when they exist. On a normal desktop it is a no-op.

## Deploy to Vercel

```bash
npm i -g vercel
vercel link          # create/link the project
vercel --prod        # build + deploy
```

`vercel.json` builds with Vite, serves `dist/`, and gives `api/capture.mjs` 2 GB / 300 s with
the Chromium binaries included. Vercel has no Chromium of its own, so the function swaps in
`@sparticuz/chromium` — a headless shell built for Lambda, which also carries the fonts a bare
Lambda lacks — while local runs use the Playwright Chromium from `npm run setup`. One capture
core, `server/capture-core.mjs`, drives both.

Verify a deployment with two calls:

```bash
curl https://your-app.vercel.app/api/health                 # liveness
curl 'https://your-app.vercel.app/api/health?chromium=1'    # actually boots the browser
curl -X POST https://your-app.vercel.app/api/capture \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","preset":"iphone"}' --output shot.png
```

Two Vercel constraints shaped the API:

- **Responses cap at 4.5 MB.** So the endpoint returns a binary image with metadata in headers
  (not base64 JSON), and degrades when needed: lossless PNG → JPEG q84 → half-resolution JPEG →
  a clear 413. The `x-cyshot-downscaled` header tells the UI to explain it.
- **Cold starts.** A warm instance keeps one browser for reuse; each request gets a fresh
  context and page. A cold capture takes a few seconds longer while Chromium unpacks to `/tmp`.

`ALLOW_PRIVATE=1` is only for local development — it disables the SSRF guard. Never set it on a
public deployment.

## API

`POST /api/capture`

```json
{ "url": "https://example.com", "preset": "iphone|android|desktop",
  "width": 390, "height": 844, "deviceScaleFactor": 3,
  "darkMode": false, "maxHeight": 15000, "waitMs": 350 }
```

Success: `200` with `image/png` or `image/jpeg` body, plus headers `x-cyshot-width`,
`x-cyshot-height`, `x-cyshot-css-width`, `x-cyshot-css-height`, `x-cyshot-truncated`,
`x-cyshot-downscaled`, `x-cyshot-title`, `x-cyshot-url`.

Failure: `4xx`/`5xx` with `{ "ok": false, "error": "…" }`.

`GET /api/health` and `GET /api/health?chromium=1`.

## How it works

```
browser (PWA)                          server / function
┌───────────────────────────┐          ┌──────────────────────────┐
│ Home: URL / file picker   │  POST    │ /api/capture             │
│        │                  │ ───────► │  headless Chromium       │
│        ▼                  │  image   │  phone viewport          │
│ stitch (pure TS)          │ ◄─────── │  autoscroll + full page  │
│        ▼                  │          └──────────────────────────┘
│ editor: virtual canvas    │
│        ▼                  │
│ export: PNG / JPEG / PDF  │
└───────────────────────────┘
```

**Stitching** (`src/lib/stitcher.ts`) is dependency-free pixel maths:

1. Each row is reduced to a luminance signature (16 column buckets).
2. A coarse-to-fine search finds the scroll offset that minimises the mean absolute error
   between the previous frame and the new one, weighting rows that actually contain content.
3. Bands that are identical in both frames at the same position are the sticky header/footer;
   they are excluded from the match and skipped when compositing, so they appear once.
4. No confident overlap → the frames are joined edge to edge and a warning is surfaced.

**Editing** (`src/lib/document.ts`) never mutates pixels. Trim, cuts, column crop and redactions
are ranges and rects in *virtual* document space, compiled into kept segments by `buildLayout`.

**Rendering** (`src/lib/render.ts`) paints one slice at a time — the visible viewport while
editing, one strip while exporting. A 40,000px document never needs a 40,000px canvas, which is
what keeps this usable on a phone where a canvas over ~16M pixels is refused.

## Limits worth knowing

- **Canvas ceilings.** PNG/JPEG go through a canvas, so there is a cap (16M px / 16384 per side
  on iOS, 64M px / 32767 elsewhere). Past it the export is scaled down and the sheet says so; PDF
  is always full resolution because it is paged.
- **Capture height.** Pages are captured up to 15,000 CSS px. Chromium needs ~20s for a 45k px
  image and times out near 120k, so this is a deliberate cap; the UI reports when a page was cut.
- **What this build does not do.** It cannot auto-scroll another app and screenshot it — that
  needs MediaProjection + AccessibilityService on Android and a ReplayKit broadcast extension on
  iOS, i.e. native shells that cannot run in a browser. On iOS that means no in-app long
  screenshots; the supported path is "take your normal screenshots, then stitch them". Stitched
  output from DRM/secure surfaces (banking apps, Netflix) will be blank — unavoidable.
- **Blocked URLs.** Localhost and private address ranges are refused by the capture API unless
  `ALLOW_PRIVATE=1` is set.

## Tests

```bash
npm test           # unit tests: stitching and layout maths
npm run test:api   # the deployable function: contract, errors, SSRF, size budget
npm run test:e2e   # real browser: capture, stitch, edit, export, share target
```

The e2e run captures a local fixture, imports three scrolled screenshots, and compares the
exported pixels against a ground-truth full-page screenshot — that is what proves the stitching,
not just the plumbing.

## Layout

```
api/capture.mjs         Vercel function (thin: supplies a browser)
api/health.mjs          liveness, plus ?chromium=1 deep check
server/index.mjs        self-hosted Express: same handler + static hosting
server/capture-core.mjs page work, SSRF guard, size budget, HTTP contract
server/launch-chromium.mjs picks sparticuz on Vercel, Playwright locally
server/browser-env.mjs  libs/fonts for headless Chromium on bare hosts
src/lib/stitcher.ts     overlap detection, sticky bands, compositing
src/lib/document.ts     trim/cut/crop/redaction ranges -> kept segments
src/lib/render.ts       sliced canvas painting
src/lib/frames.ts       decode, normalise, stitch decoded frames
src/lib/export.ts       PNG / JPEG / PDF / share, canvas allocation probing
src/lib/capture.ts      client for the capture API
src/components/         Home, Editor, ExportSheet, shared UI
public/sw.js            offline shell + Android share-target inbox
scripts/                setup, icons, dev runner, api test, e2e
```

## Next

The editor already speaks the same contract a native shell would produce (`placements` +
`EditOps`), so the capture side can be swapped in without touching it:

1. Android shell: Quick Settings tile → MediaProjection (one consent per session) →
   AccessibilityService autoscroll → feed frames to the same stitcher.
2. iOS shell: share extension + ReplayKit broadcast upload, stitching frames as the user scrolls,
   since gesture injection into other apps is not possible.
3. Safari web extension for capture that stays inside the browser.

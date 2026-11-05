/**
 * Tests the deployable function (api/capture.mjs) exactly as Vercel would call
 * it: a Node request/response handler with a pre-parsed JSON body.
 *
 * This covers the contract that the Vercel deployment relies on - binary image
 * response, metadata headers, error shapes, SSRF refusal and the response-size
 * budget - without needing a Vercel account.
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import handler from '../api/capture.mjs';
import { prepareBrowserEnv } from '../server/browser-env.mjs';

prepareBrowserEnv(process.cwd());

let FIXTURE_PORT = 0;
let API_PORT = 0;

const page = (rows) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API fixture</title>
<style>
  body{margin:0;font:16px/1.45 system-ui,sans-serif;background:#fff;color:#111}
  .hd{position:sticky;top:0;height:56px;background:#123f2b;color:#bff5d4;display:flex;align-items:center;padding:0 16px;font-weight:700}
  .row{height:90px;padding:14px 16px;border-bottom:1px solid #e3e3e3;box-sizing:border-box}
  .row:nth-child(odd){background:#f6f7f8}
</style></head><body><div class="hd">API FIXTURE</div>
<script>
  for (let i = 0; i < ${rows}; i++) {
    const d = document.createElement('div');
    d.className = 'row';
    d.textContent = 'Row ' + i + ' — the quick brown fox jumps over the lazy dog.';
    document.body.appendChild(d);
  }
</script></body></html>`;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} - ${error.message}`);
  }
}

const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // /private reports, in its <title>, whether the request arrived signed in.
  if (new URL(req.url, 'http://x').pathname === '/private') {
    const cookie = req.headers.cookie ?? '';
    const token = req.headers.authorization === 'Bearer test-token';
    const signedIn = /session=ok/.test(cookie) || token;
    const title = signedIn ? (token ? 'Signed in with token' : 'Signed in with cookie') : 'Signed out';
    res.end(page(20).replace('<title>API fixture</title>', `<title>${title}</title>`));
    return;
  }
  res.end(page(70)); // ~6.4k CSS px
});
const tallServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(150)); // ~13.6k CSS px, close to the capture cap
});

/** Mimics what @vercel/node hands a function: parsed JSON body, Node res. */
const apiServer = http.createServer((req, res) => {
  if (req.url !== '/api/capture') {
    res.statusCode = 404;
    res.end('nope');
    return;
  }
  if (req.method !== 'POST') {
    handler(req, res);
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      req.body = raw;
    }
    handler(req, res);
  });
});

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );

async function post(body) {
  const response = await fetch(`http://127.0.0.1:${API_PORT}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const main = async () => {
  FIXTURE_PORT = await listen(fixtureServer);
  const TALL_PORT = await listen(tallServer);
  API_PORT = await listen(apiServer);
  process.env.ALLOW_PRIVATE = '1';

  // 1. normal capture
  const first = await post({ url: `http://127.0.0.1:${FIXTURE_PORT}/`, preset: 'iphone' });
  check('POST /api/capture returns 200 with an image content-type', () => {
    assert.equal(first.response.status, 200);
    assert.match(first.response.headers.get('content-type') ?? '', /^image\/(png|jpeg)$/);
  });
  check('response is a real PNG and matches its metadata headers', () => {
    assert.equal(first.buffer.subarray(1, 4).toString(), 'PNG');
    const size = pngSize(first.buffer);
    assert.equal(size.width, Number(first.response.headers.get('x-cyshot-width')));
    assert.equal(size.height, Number(first.response.headers.get('x-cyshot-height')));
    assert.equal(first.response.headers.get('x-cyshot-truncated'), '0');
    assert.equal(decodeURIComponent(first.response.headers.get('x-cyshot-title') ?? ''), 'API fixture');
  });
  check('capture is well under the 4.5MB Vercel response limit', () => {
    assert.ok(first.buffer.length < 4_400_000, `${first.buffer.length} bytes`);
    console.log(`      ${(first.buffer.length / 1024).toFixed(0)} kB, ${first.response.headers.get('x-cyshot-width')}x${first.response.headers.get('x-cyshot-height')}`);
  });

  // 2. tall page: must still answer inside the budget
  const tall = await post({ url: `http://127.0.0.1:${TALL_PORT}/`, preset: 'iphone' });
  check('a very tall page still fits the response budget', () => {
    assert.equal(tall.response.status, 200);
    assert.ok(tall.buffer.length <= 4_400_000, `${tall.buffer.length} bytes`);
    console.log(
      `      ${(tall.buffer.length / 1024).toFixed(0)} kB, ${tall.response.headers.get('content-type')}, downscaled=${tall.response.headers.get('x-cyshot-downscaled')}`,
    );
  });

  // 3. error shapes
  const wrongMethod = await fetch(`http://127.0.0.1:${API_PORT}/api/capture`);
  check('GET is rejected with 405 and an allow header', async () => {
    assert.equal(wrongMethod.status, 405);
  });

  const badUrl = await post({ url: 'not a url' });
  check('a malformed url returns 400 JSON', () => {
    assert.equal(badUrl.response.status, 400);
    assert.match(badUrl.response.headers.get('content-type') ?? '', /application\/json/);
    const payload = JSON.parse(badUrl.buffer.toString());
    assert.equal(payload.ok, false);
    assert.ok(payload.error.length > 0);
  });

  const noUrl = await post({});
  check('a missing url returns 400', () => {
    assert.equal(noUrl.response.status, 400);
  });

  // 4. signed-in captures
  const privateUrl = `http://127.0.0.1:${FIXTURE_PORT}/private`;
  const anon = await post({ url: privateUrl, preset: 'iphone' });
  check('a private page is captured signed out without credentials', () => {
    assert.equal(decodeURIComponent(anon.response.headers.get('x-cyshot-title') ?? ''), 'Signed out');
  });

  const withCookie = await post({ url: privateUrl, preset: 'iphone', cookies: 'session=ok; theme=dark' });
  check('a pasted cookie header signs the capture in', () => {
    assert.equal(
      decodeURIComponent(withCookie.response.headers.get('x-cyshot-title') ?? ''),
      'Signed in with cookie',
    );
  });

  const copiedHeader = await post({ url: privateUrl, preset: 'iphone', cookies: 'Cookie: session=ok' });
  check('a cookie string copied with its "Cookie:" prefix also works', () => {
    assert.equal(
      decodeURIComponent(copiedHeader.response.headers.get('x-cyshot-title') ?? ''),
      'Signed in with cookie',
    );
  });

  const withToken = await post({ url: privateUrl, preset: 'iphone', headers: { authorization: 'Bearer test-token' } });
  check('extra request headers reach the page', () => {
    assert.equal(
      decodeURIComponent(withToken.response.headers.get('x-cyshot-title') ?? ''),
      'Signed in with token',
    );
  });

  // 5. SSRF guard
  delete process.env.ALLOW_PRIVATE;
  const blocked = await post({ url: `http://127.0.0.1:${FIXTURE_PORT}/` });
  check('private addresses are refused when ALLOW_PRIVATE is unset', () => {
    assert.equal(blocked.response.status, 400);
    assert.match(JSON.parse(blocked.buffer.toString()).error, /Local addresses are blocked/);
  });
  process.env.ALLOW_PRIVATE = '1';

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fixtureServer.close();
  tallServer.close();
  apiServer.close();
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error('API test crashed:', error);
  process.exit(1);
});

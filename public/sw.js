/**
 * Service worker.
 *
 * Three jobs:
 *   1. Receive Android share-target POSTs (/share) and park the files in the
 *      Cache API, because a form POST cannot be read by the page after redirect.
 *   2. Keep the app shell available so importing and stitching work offline.
 *   3. Serve the built assets cache-first, refreshing them in the background.
 */

const VERSION = 'v2';
const SHELL = `cyshot-shell-${VERSION}`;
// Cached one by one: addAll() rejects the whole set if a single URL 404s.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const INBOX = 'cyshot-inbox';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== SHELL && name !== INBOX).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__inbox/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached =
          (await caches.match(event.request)) ||
          (await caches.match('/')) ||
          (await caches.match('/index.html'));
        return cached || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  const response = hit || (await network);
  if (response) return response;
  return new Response('', { status: 504, statusText: 'Offline' });
}

async function handleShare(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect('/?share-error=form', 303);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cache = await caches.open(INBOX);

  const meta = { url: '', title: '', files: [] };
  const title = form.get('title');
  const url = form.get('url');
  const text = form.get('text');
  if (typeof title === 'string') meta.title = title;
  if (typeof url === 'string') meta.url = url;
  if (!meta.url && typeof text === 'string' && /^https?:\/\//i.test(text.trim())) {
    meta.url = text.trim();
  }
  // Some apps share only text that contains a link.
  if (!meta.url && typeof title === 'string' && /^https?:\/\//i.test(title.trim())) {
    meta.url = title.trim();
  }

  const files = form
    .getAll('files')
    .filter((file) => typeof File !== 'undefined' && file instanceof File && file.type.startsWith('image/'));

  let index = 0;
  for (const file of files) {
    const key = `/__inbox/${id}/${index++}`;
    await cache.put(
      new Request(key),
      new Response(file, { headers: { 'content-type': file.type || 'image/png' } }),
    );
    meta.files.push({ key, name: file.name, type: file.type });
  }

  await cache.put(
    new Request(`/__inbox/${id}/meta`),
    new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }),
  );

  return Response.redirect(`/?share=${id}`, 303);
}

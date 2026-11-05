/**
 * Service worker.
 *
 * Two jobs:
 *   1. Receive Android share-target POSTs (/share) and park the files in the
 *      Cache API, because a form POST cannot be read by the page after redirect.
 *   2. Keep the app shell available so importing and stitching works offline.
 */

const SHELL = 'cyshot-shell-v1';
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];
const INBOX = 'cyshot-inbox';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = (await caches.match('/')) || (await caches.match('/index.html'));
        return cached || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function handleShare(request) {
  const form = await request.formData();
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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Register right away rather than on `load`: an installed app must have the
  // worker active as early as possible, or the Android share sheet lands on a
  // page that never sees the shared files.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A newer build took over; reload once so the page and the cached shell match.
    // Skipped on the very first install to avoid a reload straight after load.
    if (hadController) window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Sharing targets and offline support need the worker; the app still works without it.
  });
}

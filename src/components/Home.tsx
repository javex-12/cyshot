import { useEffect, useMemo, useState } from 'react';
import { Switch } from './ui';
import { parseHeaders, type CaptureRequest, type Preset } from '../lib/capture';
import { detectPlatform, supportsShareTarget, type Platform } from '../lib/platform';
import { useInstallPrompt } from '../lib/install';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'iphone', label: 'iPhone' },
  { id: 'android', label: 'Android' },
  { id: 'desktop', label: 'Desktop' },
];

function installHint(platform: Platform): string {
  switch (platform.os) {
    case 'ios':
      return 'Open this page in Safari, tap Share, then “Add to Home Screen”. Chrome and Firefox on iOS cannot install web apps.';
    case 'android':
      return 'Open the browser menu and choose “Install app” (or “Add to Home screen”).';
    case 'macos':
      return 'In Safari choose File → Add to Dock, or in Chrome/Edge use the install icon in the address bar.';
    default:
      return 'Use the install icon in your browser’s address bar to pin cyshot like an app.';
  }
}

function shareHint(platform: Platform, installed: boolean): string {
  if (supportsShareTarget(platform)) {
    return 'You can share screenshots or a link to cyshot from any app — it appears in your share sheet.';
  }
  if (platform.os === 'android') {
    return installed
      ? 'Open cyshot in Chrome rather than another browser to get share-sheet support.'
      : 'Install cyshot first, then it appears in your Android share sheet for images and links.';
  }
  if (platform.os === 'ios') {
    return 'iOS does not let web apps into the share sheet. Take normal screenshots, then tap “Choose screenshots”, or paste a link above.';
  }
  return 'Paste a link above, or drag screenshots in — the browser share target is Android-only.';
}

export function Home({
  onCapture,
  onPickFiles,
  initialUrl,
  autoCapture,
  busy,
  error,
}: {
  onCapture: (request: CaptureRequest) => void;
  onPickFiles: () => void;
  initialUrl?: string;
  autoCapture?: boolean;
  busy: boolean;
  error?: string | null;
}) {
  const platform = useMemo(() => detectPlatform(), []);
  const { canPrompt, installed, install } = useInstallPrompt();

  const [url, setUrl] = useState(initialUrl ?? '');
  // Start on the viewport that matches the phone in the user's hand.
  const [preset, setPreset] = useState<Preset>(platform.preset);
  const [darkMode, setDarkMode] = useState(false);
  const [fired, setFired] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [cookies, setCookies] = useState('');
  const [headerText, setHeaderText] = useState('');

  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    if (!autoCapture || !initialUrl || fired) return;
    setFired(true);
    onCapture({ url: initialUrl, preset, darkMode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCapture, initialUrl, fired]);

  const normalized = (() => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  })();

  const signedIn = Boolean(cookies.trim() || headerText.trim());

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!normalized) return;
    onCapture({
      url: normalized,
      preset,
      darkMode,
      cookies: cookies.trim() || undefined,
      headers: parseHeaders(headerText),
    });
  };

  return (
    <div className="home">
      <header className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span />
        </div>
        <div>
          <h1>cyshot</h1>
          <p>Full-page screenshots that end where you say.</p>
        </div>
      </header>

      <form className="card" onSubmit={submit}>
        <label className="field-label" htmlFor="url">
          Capture a web page
        </label>
        <div className="url-row">
          <input
            id="url"
            className="url-input"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={busy}
          />
          <button type="submit" className="primary" disabled={busy || !normalized}>
            Go
          </button>
        </div>

        <div className="chip-row" role="group" aria-label="Device size">
          {PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`chip ${preset === option.id ? 'selected' : ''}`}
              onClick={() => setPreset(option.id)}
              aria-pressed={preset === option.id}
            >
              {option.label}
            </button>
          ))}
          <span className="chip-spacer" />
          <Switch checked={darkMode} onChange={setDarkMode} label="Dark" />
        </div>
        <p className="hint">
          Rendered at phone width ({platform.label} detected), scrolled through, then shot whole — header and
          footer included.
        </p>

        <button
          type="button"
          className="ghost wide"
          onClick={() => setAuthOpen((open) => !open)}
          aria-expanded={authOpen}
        >
          {authOpen ? 'Hide signed-in options' : 'Page behind a login? Add cookies'}
        </button>

        {authOpen && (
          <div className="auth-fields">
            <label className="field-label" htmlFor="cookies">
              Cookie header
            </label>
            <p className="hint">
              Open the page while signed in, then copy the <code>Cookie</code> request header from DevTools →
              Network (desktop is easiest). It is sent for this capture only and scoped to that site.
            </p>
            <textarea
              id="cookies"
              className="text-area"
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="session=abc123; other=value"
              value={cookies}
              onChange={(event) => setCookies(event.target.value)}
              disabled={busy}
            />
            <label className="field-label" htmlFor="headers">
              Extra headers (optional)
            </label>
            <textarea
              id="headers"
              className="text-area"
              rows={2}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Authorization: Bearer eyJ…"
              value={headerText}
              onChange={(event) => setHeaderText(event.target.value)}
              disabled={busy}
            />
            <p className="tool-note">
              One <code>Name: value</code> per line. Cookies and headers are never stored.
            </p>
          </div>
        )}

        {signedIn && <p className="hint">Signed-in capture: cookies will be used for this page.</p>}
        {error && <p className="error">{error}</p>}
      </form>

      <div className="card">
        <span className="field-label">Stitch screenshots you already have</span>
        <p className="hint">
          Take a few shots while scrolling, in order. Overlap matters more than count. Duplicate frames and
          sticky headers are handled for you.
        </p>
        <button type="button" className="secondary wide" onClick={onPickFiles} disabled={busy}>
          Choose screenshots
        </button>
      </div>

      <div className="card platform-card">
        <span className="field-label">
          On {platform.label}
          {installed ? ' · installed' : ''}
        </span>
        {canPrompt && !installed ? (
          <button type="button" className="secondary wide" onClick={() => void install()}>
            Install cyshot
          </button>
        ) : (
          !installed && <p className="hint">{installHint(platform)}</p>
        )}
        <p className="hint">{shareHint(platform, installed)}</p>
      </div>

      <p className="footnote">
        Full-size images export as PNG, JPEG or a paged PDF. Your screenshots never leave this device unless you
        paste a URL to capture.
      </p>
    </div>
  );
}

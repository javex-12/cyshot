import { useEffect, useMemo, useState } from 'react';
import { Switch } from './ui';
import { parseHeaders, type CaptureRequest, type Preset, type Quality } from '../lib/capture';
import { detectPlatform, supportsShareTarget, type Platform } from '../lib/platform';
import { useInstallPrompt } from '../lib/install';
import { getBookmarkletCode } from '../lib/bookmarklet';
import { supportsScreenRecord } from '../lib/video';

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
    return 'On iOS: take screenshots or a 3-second screen recording in any app, then tap “Choose screenshots or screen recording” above.';
  }
  return 'Paste a link above, or drag screenshots/video in — the browser share target is Android-only.';
}

export function Home({
  onCapture,
  onPickFiles,
  onStartRecord,
  initialUrl,
  autoCapture,
  busy,
  error,
}: {
  onCapture: (request: CaptureRequest) => void;
  onPickFiles: () => void;
  onStartRecord?: () => void;
  initialUrl?: string;
  autoCapture?: boolean;
  busy: boolean;
  error?: string | null;
}) {
  const platform = useMemo(() => detectPlatform(), []);
  const { canPrompt, installed, install } = useInstallPrompt();
  const canLiveRecord = useMemo(() => supportsScreenRecord(), []);

  const [url, setUrl] = useState(initialUrl ?? '');
  const [preset, setPreset] = useState<Preset>(platform.preset);
  const [quality, setQuality] = useState<Quality>('best');
  const [darkMode, setDarkMode] = useState(false);
  const [fired, setFired] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'easy' | 'bookmarklet' | 'advanced'>('easy');
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);
  const [cookies, setCookies] = useState('');
  const [headerText, setHeaderText] = useState('');

  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  useEffect(() => {
    if (!autoCapture || !initialUrl || fired) return;
    setFired(true);
    onCapture({ url: initialUrl, preset, darkMode, quality });
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
      quality,
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
          <p>Full-page screenshots & long app captures in Best Resolution.</p>
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

        <div className="chip-row" role="group" aria-label="Resolution quality">
          <span className="field-label" style={{ alignSelf: 'center', marginRight: '4px', fontSize: '12px' }}>
            Resolution:
          </span>
          <button
            type="button"
            className={`chip ${quality === 'best' ? 'selected' : ''}`}
            onClick={() => setQuality('best')}
            aria-pressed={quality === 'best'}
          >
            Ultra HD (3x)
          </button>
          <button
            type="button"
            className={`chip ${quality === 'high' ? 'selected' : ''}`}
            onClick={() => setQuality('high')}
            aria-pressed={quality === 'high'}
          >
            High (2x)
          </button>
          <button
            type="button"
            className={`chip ${quality === 'standard' ? 'selected' : ''}`}
            onClick={() => setQuality('standard')}
            aria-pressed={quality === 'standard'}
          >
            1x
          </button>
        </div>

        <p className="hint">
          Rendered at {preset === 'iphone' ? 'iPhone' : preset === 'android' ? 'Android' : 'Desktop'} viewport, scrolled through, then captured at maximum resolution.
        </p>

        <button
          type="button"
          className="ghost wide"
          onClick={() => setAuthOpen((open) => !open)}
          aria-expanded={authOpen}
        >
          {authOpen ? 'Hide authorized page options' : 'Page behind a login? Easy authorized options'}
        </button>

        {authOpen && (
          <div className="auth-fields">
            <div className="chip-row" role="group" aria-label="Auth Method">
              <button
                type="button"
                className={`chip ${authMode === 'easy' ? 'selected' : ''}`}
                onClick={() => setAuthMode('easy')}
              >
                1. Screen Record (Easiest)
              </button>
              <button
                type="button"
                className={`chip ${authMode === 'bookmarklet' ? 'selected' : ''}`}
                onClick={() => setAuthMode('bookmarklet')}
              >
                2. 1-Tap Bookmarklet
              </button>
              <button
                type="button"
                className={`chip ${authMode === 'advanced' ? 'selected' : ''}`}
                onClick={() => setAuthMode('advanced')}
              >
                3. DevTools Cookies
              </button>
            </div>

            {authMode === 'easy' && (
              <div className="auth-guide" style={{ padding: '8px 0' }}>
                <p className="hint">
                  <strong>Easiest method on mobile (No technical knowledge needed):</strong>
                </p>
                <ol className="hint" style={{ paddingLeft: '20px', margin: '6px 0', lineHeight: '1.6' }}>
                  <li>Open the authorized website on your phone where you are already signed in.</li>
                  <li>
                    Swipe to open <strong>Screen Record</strong> in Control Center (iOS) or Quick Settings (Android), or take 2+ screenshots.
                  </li>
                  <li>Scroll through the page, stop recording, then tap <strong>“Choose screenshots or screen recording”</strong> below.</li>
                </ol>
                <p className="tool-note">Cyshot automatically stitches everything into a crystal-clear full page capture!</p>
              </div>
            )}

            {authMode === 'bookmarklet' && (
              <div className="auth-guide" style={{ padding: '8px 0' }}>
                <p className="hint">
                  <strong>1-Tap Safari / Chrome Bookmarklet:</strong>
                </p>
                <p className="hint">
                  Save this bookmarklet in Safari or Chrome. Whenever you are on an authorized or paywalled page, tap the bookmark to capture it instantly:
                </p>
                <button
                  type="button"
                  className="secondary wide"
                  onClick={() => {
                    void navigator.clipboard.writeText(getBookmarkletCode(window.location.origin));
                    setCopiedBookmarklet(true);
                    setTimeout(() => setCopiedBookmarklet(false), 2500);
                  }}
                >
                  {copiedBookmarklet ? '✓ Bookmarklet Code Copied!' : 'Copy 1-Tap Bookmarklet'}
                </button>
              </div>
            )}

            {authMode === 'advanced' && (
              <>
                <label className="field-label" htmlFor="cookies">
                  Cookie header (DevTools)
                </label>
                <p className="hint">
                  Copy the <code>Cookie</code> request header from DevTools → Network. It is sent for this capture only.
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
              </>
            )}
          </div>
        )}

        {signedIn && <p className="hint">Signed-in capture: custom cookies/headers will be used for this page.</p>}
        {error && <p className="error">{error}</p>}
      </form>

      <div className="card">
        <span className="field-label">Capture ANY App or Stitch Screenshots</span>
        <p className="hint">
          Works for <strong>any app</strong> (Instagram, WhatsApp, Twitter, Settings) or web page.
          Pick screenshots in any order (auto-sorted), or select a screen recording video (.mp4, .mov).
          Duplicate frames and sticky headers/status bars are removed automatically in 100% full resolution.
        </p>
        <button type="button" className="secondary wide" onClick={onPickFiles} disabled={busy}>
          Choose screenshots or screen recording
        </button>
        {canLiveRecord && onStartRecord && (
          <button
            type="button"
            className="ghost wide"
            onClick={onStartRecord}
            disabled={busy}
            style={{ marginTop: '2px' }}
          >
            ● Live Screen Record
          </button>
        )}
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

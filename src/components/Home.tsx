import { useEffect, useState } from 'react';
import { Switch } from './ui';
import type { CaptureRequest, Preset } from '../lib/capture';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'iphone', label: 'iPhone' },
  { id: 'android', label: 'Android' },
  { id: 'desktop', label: 'Desktop' },
];

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
  const [url, setUrl] = useState(initialUrl ?? '');
  const [preset, setPreset] = useState<Preset>('iphone');
  const [darkMode, setDarkMode] = useState(false);
  const [fired, setFired] = useState(false);

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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!normalized) return;
    onCapture({ url: normalized, preset, darkMode });
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
        <p className="hint">Rendered at phone width, scrolled through, then shot whole.</p>
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

      <p className="footnote">
        Install cyshot to your home screen, then share a link or screenshots straight to it from any app.
      </p>
    </div>
  );
}

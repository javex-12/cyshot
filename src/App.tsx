import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home } from './components/Home';
import { Editor } from './components/Editor';
import { ExportSheet } from './components/ExportSheet';
import { Spinner } from './components/ui';
import { disposeFrames, loadFrames, stitchLoadedFrames, type LoadedFrame } from './lib/frames';
import { buildLayout, emptyOps, type EditOps } from './lib/document';
import { capturePage, MAX_CAPTURE_HEIGHT, type CaptureRequest } from './lib/capture';
import { detectPlatform } from './lib/platform';
import { isVideoFile, startScreenCapture } from './lib/video';
import type { StitchResult } from './lib/stitcher';

type Screen = 'home' | 'busy' | 'editor';

/** The phone in the user's hand decides how a shared link is rendered. */
const DEFAULT_PRESET = detectPlatform().preset;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 32));

interface SharedMeta {
  url?: string;
  title?: string;
  files?: { key: string }[];
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [busyLabel, setBusyLabel] = useState('Working');
  const [progress, setProgress] = useState(0);
  const [frames, setFrames] = useState<LoadedFrame[]>([]);
  const [doc, setDoc] = useState<StitchResult | null>(null);
  const [ops, setOps] = useState<EditOps>(emptyOps());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | undefined>(undefined);
  const [autoCapture, setAutoCapture] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const framesRef = useRef<LoadedFrame[]>([]);
  framesRef.current = frames;

  const layout = useMemo(
    () => (doc ? buildLayout(doc.width, doc.height, ops) : null),
    [doc, ops],
  );

  const addBlobs = useCallback(async (blobs: Blob[], append: boolean) => {
    if (blobs.length === 0) return;
    setError(null);
    setScreen('busy');
    const hasVideo = blobs.some(isVideoFile);
    setBusyLabel(
      hasVideo
        ? 'Extracting sharp frames from screen recording'
        : blobs.length === 1
          ? 'Reading image'
          : `Reading ${blobs.length} screenshots`,
    );
    setProgress(0);
    await tick();

    const base = append ? framesRef.current : [];
    let loaded: LoadedFrame[] = [];
    try {
      loaded = await loadFrames(blobs, (done, total) => setProgress(done / total), base[0]?.width);
    } catch {
      setError('That file could not be read as an image or video.');
      setScreen('home');
      return;
    }

    const all = [...base, ...loaded];
    if (all.length > 1) {
      setBusyLabel(`Finding overlaps & stitching ${all.length} frames in best resolution`);
      setProgress(0);
      await tick();
    }

    try {
      const result = stitchLoadedFrames(all, (done, total) => setProgress(done / Math.max(1, total)));
      setFrames(all);
      setDoc(result);
      setOps(emptyOps());
      setScreen('editor');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Stitching failed.');
      setScreen('home');
    }
  }, []);

  const capture = useCallback(
    async (request: CaptureRequest) => {
      setError(null);
      setScreen('busy');
      setBusyLabel('Capturing the page');
      setProgress(0.15);
      try {
        const result = await capturePage(request);
        if (result.truncated) {
          setNotice(
            `The page was taller than the ${MAX_CAPTURE_HEIGHT.toLocaleString()}px capture limit, so the very bottom is missing. Stitch two captures for pages that long.`,
          );
        } else if (result.downscaled) {
          setNotice('This capture came back at CSS resolution to fit the response size limit.');
        }
        await addBlobs([result.blob], false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Capture failed.');
        setScreen('home');
      }
    },
    [addBlobs],
  );

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const handleStartRecord = useCallback(async () => {
    try {
      await startScreenCapture(
        (blobs) => void addBlobs(blobs, false),
        (err) => setError(err.message),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start screen recording.');
    }
  }, [addBlobs]);

  // Share target: /?share=<id> carries images, /?url=<url> carries a link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url');
    const shareId = params.get('share');
    if (!sharedUrl && !shareId) return;
    window.history.replaceState({}, '', window.location.pathname);

    if (sharedUrl) {
      setInitialUrl(sharedUrl);
      void capture({ url: sharedUrl, preset: DEFAULT_PRESET, darkMode: false });
      return;
    }

    void (async () => {
      if (typeof caches === 'undefined') {
        setError('Sharing needs the installed app (service worker unavailable here).');
        return;
      }
      setScreen('busy');
      setBusyLabel('Receiving share');
      try {
        const cache = await caches.open('cyshot-inbox');
        const metaResponse = await cache.match(`/__inbox/${shareId}/meta`);
        const meta = metaResponse ? ((await metaResponse.json()) as SharedMeta) : null;
        const blobs: Blob[] = [];
        for (const file of meta?.files ?? []) {
          const cached = await cache.match(file.key);
          if (cached) blobs.push(await cached.blob());
          await cache.delete(file.key);
        }
        await cache.delete(`/__inbox/${shareId}/meta`);

        if (blobs.length > 0) {
          await addBlobs(blobs, false);
        } else if (meta?.url) {
          setInitialUrl(meta.url);
          await capture({ url: meta.url, preset: DEFAULT_PRESET, darkMode: false });
        } else {
          setScreen('home');
          setError('That share did not include an image or a link.');
        }
      } catch {
        setScreen('home');
        setError('Could not read the shared content.');
      }
    })();
  }, [addBlobs, capture]);

  const exitEditor = () => {
    disposeFrames(frames);
    setFrames([]);
    setDoc(null);
    setOps(emptyOps());
    setInitialUrl(undefined);
    setAutoCapture(false);
    setExportOpen(false);
    setScreen('home');
  };

  return (
    <div className="app">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) void addBlobs(files, screen === 'editor');
        }}
      />

      {screen === 'home' && (
        <>
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button type="button" className="notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
          <Home
            onCapture={(request) => void capture(request)}
            onPickFiles={pickFiles}
            onStartRecord={handleStartRecord}
            initialUrl={initialUrl}
            autoCapture={autoCapture}
            busy={false}
            error={error}
          />
        </>
      )}

      {screen === 'busy' && (
        <div className="busy-screen">
          <Spinner large />
          <p className="busy-label">{busyLabel}</p>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}

      {screen === 'editor' && doc && layout && (
        <>
          <Editor
            frames={frames}
            doc={doc}
            ops={ops}
            warnings={doc.warnings}
            onChange={setOps}
            onAdd={pickFiles}
            onExit={exitEditor}
            onExport={() => setExportOpen(true)}
          />
          <ExportSheet
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            input={{ frames, placements: doc.placements, layout, redactions: ops.redactions }}
          />
        </>
      )}
    </div>
  );
}

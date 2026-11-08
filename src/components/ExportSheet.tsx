import { useEffect, useState } from 'react';
import {
  canShareFiles,
  download,
  exportImage,
  exportPdf,
  renderDocument,
  share,
  type ExportResult,
  type RenderInput,
} from '../lib/export';
import { Sheet, Spinner } from './ui';

type Action = 'share' | 'png' | 'jpeg' | 'pdf';

export function ExportSheet({
  open,
  onClose,
  input,
}: {
  open: boolean;
  onClose: () => void;
  input: RenderInput;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [prepared, setPrepared] = useState<ExportResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shareable = canShareFiles();
  const pixels = input.layout.width * input.layout.height;

  useEffect(() => {
    if (!open) {
      setPrepared(null);
      setBusy(null);
      setError(null);
      setMessage(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setMessage(null);
    // Pre-render so sharing happens inside the tap's activation window.
    (async () => {
      try {
        const { canvas, scale: usedScale } = renderDocument(input);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((value) => resolve(value), 'image/png'),
        );
        if (!blob || cancelled) return;
        setPrepared({
          blob,
          filename: `cyshot-${input.layout.width}x${input.layout.height}.png`,
          scale: usedScale,
          width: canvas.width,
          height: canvas.height,
        });
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not build the image.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, input]);

  const run = async (action: Action) => {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      if (action === 'pdf') {
        const result = await exportPdf(input);
        download(result.blob, result.filename);
        setMessage('PDF saved, one page per screenful.');
      } else if (action === 'png') {
        const result = prepared ? { ...prepared, blob: prepared.blob } : await exportImage(input, 'image/png');
        download(result.blob, goodFilename(result, 'png'));
        setMessage(
          result.scale < 1
            ? `Saved at ${Math.round(result.scale * 100)}% - this device could not hold the full ${input.layout.width}px width in one canvas.`
            : 'PNG saved.',
        );
      } else if (action === 'jpeg') {
        const result = await exportImage(input, 'image/jpeg', 0.92);
        download(result.blob, goodFilename(result, 'jpg'));
        setMessage(result.scale < 1 ? `Saved at ${Math.round(result.scale * 100)}%.` : 'JPEG saved.');
      } else {
        const result = prepared ?? (await exportImage(input, 'image/png'));
        const shared = await share(result.blob, goodFilename(result, 'png'), 'cyshot screenshot');
        if (!shared) {
          download(result.blob, goodFilename(result, 'png'));
          setMessage('Sharing is not available here, so the PNG was saved instead.');
        } else {
          setMessage('Shared.');
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <Sheet open={open} title="Export" onClose={onClose}>
      <div className="export-meta">
        <div>
          <strong>
            {input.layout.width} × {input.layout.height}
          </strong>
          <span>{(pixels / 1_000_000).toFixed(1)}M pixels · {prepared && prepared.scale >= 1 ? '100% Original Resolution' : prepared ? `${Math.round(prepared.scale * 100)}% resolution` : 'Best Resolution'}</span>
        </div>
        {prepared && prepared.scale < 1 && (
          <p className="tool-note">
            PNG/JPEG scaled to {Math.round(prepared.scale * 100)}% to fit this device's memory. PDF preserves 100% full resolution.
          </p>
        )}
      </div>

      <div className="export-actions">
        <button type="button" className="primary wide" onClick={() => run('share')} disabled={disabled || !shareable}>
          {busy === 'share' ? <Spinner /> : 'Share'}
        </button>
        {!shareable && <p className="tool-note">This browser cannot share files. Use one of the saves below.</p>}
        <div className="export-grid">
          <button type="button" className="secondary" onClick={() => run('png')} disabled={disabled}>
            {busy === 'png' ? <Spinner /> : 'PNG'}
          </button>
          <button type="button" className="secondary" onClick={() => run('jpeg')} disabled={disabled}>
            {busy === 'jpeg' ? <Spinner /> : 'JPEG'}
          </button>
          <button type="button" className="secondary" onClick={() => run('pdf')} disabled={disabled}>
            {busy === 'pdf' ? <Spinner /> : 'PDF'}
          </button>
        </div>
      </div>

      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}
      <p className="tool-note">
        Long images lose nothing in PNG. PDF pages are the best choice when the shot is taller than the canvas
        limit allows.
      </p>
    </Sheet>
  );
}

function goodFilename(result: ExportResult, ext: string): string {
  const base = result.filename.replace(/\.[a-z]+$/i, '');
  return `${base}.${ext}`;
}

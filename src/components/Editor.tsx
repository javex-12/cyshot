import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildLayout,
  buildSections,
  isSectionRemoved,
  outRectToVirtual,
  outToVirtual,
  toggleSection,
  virtualToOut,
  type EditOps,
  type Rect,
} from '../lib/document';
import { paintRedactions, paintSlice, type SliceOptions } from '../lib/render';
import type { LoadedFrame } from '../lib/frames';
import type { StitchResult, StitchWarning } from '../lib/stitcher';
import { Notice } from './ui';

type Tool = 'trim' | 'cut' | 'region' | 'redact';

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

function normalise(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

export function Editor({
  frames,
  doc,
  ops,
  warnings,
  onChange,
  onAdd,
  onExit,
  onExport,
}: {
  frames: LoadedFrame[];
  doc: StitchResult;
  ops: EditOps;
  warnings: StitchWarning[];
  onChange: (next: EditOps) => void;
  onAdd: () => void;
  onExit: () => void;
  onExport: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [tool, setTool] = useState<Tool>('trim');
  const [drag, setDrag] = useState<Rect | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [showWarnings, setShowWarnings] = useState(warnings.length > 0);
  const dragRef = useRef<{ startX: number; startY: number; pointerId: number } | null>(null);

  const layout = useMemo(() => buildLayout(doc.width, doc.height, ops), [doc.width, doc.height, ops]);
  const sections = useMemo(() => buildSections(doc.height, ops.dividers), [doc.height, ops.dividers]);
  const zoom = viewport.w > 0 ? Math.min(1, viewport.w / layout.width) : 1;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the scroll position valid when cuts shorten the document.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, layout.height * zoom - el.clientHeight);
    if (el.scrollTop > maxScroll) {
      el.scrollTop = maxScroll;
      setScrollTop(maxScroll);
    }
  }, [layout.height, zoom]);

  // Repaint the visible slice. The canvas is only ever viewport-sized.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.w === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(viewport.w * dpr);
    const pixelHeight = Math.round(viewport.h * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = zoom * dpr;
    const overscan = 300 / zoom;
    // Clamp to the document so row 0 sits at the top of the canvas at scroll 0.
    const slice: SliceOptions = {
      outY0: Math.max(0, scrollTop / zoom - overscan),
      outY1: Math.min(layout.height, (scrollTop + viewport.h) / zoom + overscan),
      scale,
    };
    if (slice.outY1 <= slice.outY0) slice.outY1 = slice.outY0 + 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintSlice(ctx, frames, doc.placements, layout, slice);
    paintRedactions(ctx, layout, ops.redactions, slice);
  }, [doc, frames, layout, ops.redactions, scrollTop, viewport, zoom]);

  const frameRef = useRef(0);
  const handleScroll = () => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      setScrollTop(scrollerRef.current?.scrollTop ?? 0);
    });
  };

  const pointFrom = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'trim') return;
    const p = pointFrom(event);
    dragRef.current = { startX: p.x, startY: p.y, pointerId: event.pointerId };
    if (tool === 'region' || tool === 'redact') {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const p = pointFrom(event);
    if (tool === 'region' || tool === 'redact') {
      setDrag(normalise(start.startX, start.startY, p.x, p.y));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    dragRef.current = null;
    if (!start) return;
    const p = pointFrom(event);
    const rect = normalise(start.startX, start.startY, p.x, p.y);
    const moved = rect.w > 6 || rect.h > 6;

    if (tool === 'cut') {
      if (!moved) {
        const target = Math.round(clamp(outToVirtual(layout, p.y), 1, doc.height - 1));
        if (!ops.dividers.some((d) => Math.abs(d - target) < 10)) {
          onChange({ ...ops, dividers: [...ops.dividers, target].sort((a, b) => a - b) });
        }
      }
      setDrag(null);
      return;
    }

    if (tool === 'redact') {
      if (rect.w > 6 && rect.h > 6) {
        onChange({ ...ops, redactions: [...ops.redactions, outRectToVirtual(layout, rect)] });
      }
      setDrag(null);
      return;
    }

    if (tool === 'region') {
      setSelection(rect.w > 8 ? rect : null);
      setDrag(null);
    }
  };

  const dragHandle = (which: 'top' | 'bottom') => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startTrimTop = opsRef.current.trimTop;
    const startTrimBottom = opsRef.current.trimBottom;
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientY - startY) / zoom;
      const current = opsRef.current;
      if (which === 'top') {
        onChange({
          ...current,
          trimTop: Math.round(clamp(startTrimTop + delta, 0, doc.height - current.trimBottom - 40)),
        });
      } else {
        onChange({
          ...current,
          trimBottom: Math.round(clamp(startTrimBottom - delta, 0, doc.height - current.trimTop - 40)),
        });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const keepAbove = () => {
    const vY = outToVirtual(layout, scrollTop / zoom);
    onChange({ ...ops, trimTop: Math.round(clamp(vY, 0, doc.height - ops.trimBottom - 40)) });
  };

  const keepBelow = () => {
    const vY = outToVirtual(layout, (scrollTop + viewport.h) / zoom);
    onChange({ ...ops, trimBottom: Math.round(clamp(doc.height - vY, 0, doc.height - ops.trimTop - 40)) });
  };

  const applyCrop = () => {
    if (!selection) return;
    const x0 = selection.x + layout.x0;
    onChange({ ...ops, cropX: { x: Math.round(x0), w: Math.round(selection.w) } });
    setSelection(null);
  };

  const switchTool = (next: Tool) => {
    setTool(next);
    setDrag(null);
    setSelection(null);
  };

  const docMeta = `${frames.length} frame${frames.length === 1 ? '' : 's'} · ${layout.width}×${layout.height}`;

  return (
    <div className="editor">
      <header className="editor-head">
        <button type="button" className="icon-btn" onClick={onExit} aria-label="Back">
          ‹
        </button>
        <div className="editor-meta">
          <strong>{docMeta}</strong>
          <span>
            {doc.matches.length > 0
              ? `${doc.matches.filter((m) => m.matched).length}/${doc.matches.length} seams matched`
              : 'single image'}
          </span>
        </div>
        <button type="button" className="primary small" onClick={onExport}>
          Export
        </button>
      </header>

      {showWarnings && warnings.length > 0 && (
        <Notice onDismiss={() => setShowWarnings(false)}>
          {warnings[0].message}
          {warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}
        </Notice>
      )}

      <div ref={scrollerRef} className="scroller" onScroll={handleScroll}>
        <div className="spacer" style={{ height: Math.max(viewport.h, layout.height * zoom) }}>
          <canvas
            ref={canvasRef}
            className="viewcanvas"
            style={{ width: viewport.w, height: viewport.h }}
            aria-label="Stitched screenshot"
          />
          <div
            className={`overlay tool-${tool}`}
            style={{ height: layout.height * zoom }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {tool === 'trim' && (
              <>
                <div className="trim-handle top" onPointerDown={dragHandle('top')}>
                  <span>Top</span>
                </div>
                <div className="trim-handle bottom" onPointerDown={dragHandle('bottom')}>
                  <span>End</span>
                </div>
              </>
            )}

            {tool === 'cut' &&
              ops.dividers.map((divider) => {
                const outY = virtualToOut(layout, divider);
                if (outY === null) return null;
                return (
                  <div key={divider} className="cut-line" style={{ top: outY * zoom }}>
                    <button
                      type="button"
                      className="cut-remove"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() =>
                        onChange({ ...ops, dividers: ops.dividers.filter((d) => d !== divider) })
                      }
                      aria-label="Remove cut"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

            {tool === 'region' && (drag ?? selection) && (
              <div
                className="region-rect"
                style={{
                  left: (drag ?? selection)!.x * zoom,
                  top: (drag ?? selection)!.y * zoom,
                  width: (drag ?? selection)!.w * zoom,
                  height: (drag ?? selection)!.h * zoom,
                }}
              />
            )}

            {tool === 'redact' && drag && (
              <div
                className="redact-rect"
                style={{ left: drag.x * zoom, top: drag.y * zoom, width: drag.w * zoom, height: drag.h * zoom }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="tool-context">
        {tool === 'trim' && (
          <>
            <p className="tool-hint">
              Scroll to where you want the shot to start or stop, then tap. Or drag the handles.
            </p>
            <div className="tool-actions">
              <button type="button" className="secondary" onClick={keepAbove}>
                Start here
              </button>
              <button type="button" className="secondary" onClick={keepBelow}>
                End here
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onChange({ ...ops, trimTop: 0, trimBottom: 0 })}
              >
                Reset
              </button>
            </div>
            <p className="tool-note">
              Trimmed {Math.round(ops.trimTop)} px from the top, {Math.round(ops.trimBottom)} px from the bottom.
            </p>
          </>
        )}

        {tool === 'cut' && (
          <>
            <p className="tool-hint">Tap the image to place a cut, then drop the parts you do not want.</p>
            {ops.dividers.length === 0 ? (
              <p className="tool-note">No cuts yet.</p>
            ) : (
              <div className="chip-scroll">
                {sections.map((section, index) => {
                  const removed = isSectionRemoved(layout, section);
                  return (
                    <button
                      key={`${section.y0}-${section.y1}`}
                      type="button"
                      className={`section-chip ${removed ? 'removed' : ''}`}
                      onClick={() => onChange(toggleSection(ops, section))}
                    >
                      <span className="section-name">Part {index + 1}</span>
                      <span className="section-size">{Math.round((section.y1 - section.y0) / 10) / 100}k px</span>
                      <span className="section-state">{removed ? 'Restore' : 'Drop'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tool === 'region' && (
          <>
            <p className="tool-hint">Drag across the image to keep only that column.</p>
            <div className="tool-actions">
              <button type="button" className="secondary" onClick={applyCrop} disabled={!selection}>
                Keep column
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onChange({ ...ops, cropX: null })}
                disabled={!ops.cropX}
              >
                Full width
              </button>
              <button type="button" className="ghost" onClick={() => setSelection(null)} disabled={!selection}>
                Clear
              </button>
            </div>
            {ops.cropX && (
              <p className="tool-note">
                Keeping {Math.round(ops.cropX.w)} px from x={Math.round(ops.cropX.x)}.
              </p>
            )}
          </>
        )}

        {tool === 'redact' && (
          <>
            <p className="tool-hint">Drag a box to black out anything private. Scrolling pauses while you draw.</p>
            <div className="tool-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => onChange({ ...ops, redactions: ops.redactions.slice(0, -1) })}
                disabled={ops.redactions.length === 0}
              >
                Undo box
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => onChange({ ...ops, redactions: [] })}
                disabled={ops.redactions.length === 0}
              >
                Clear
              </button>
            </div>
            {ops.redactions.length > 0 && (
              <p className="tool-note">{ops.redactions.length} box(es) blacked out.</p>
            )}
          </>
        )}
      </div>

      <nav className="toolbar">
        {(['trim', 'cut', 'region', 'redact'] as Tool[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`tool ${tool === id ? 'active' : ''}`}
            onClick={() => switchTool(id)}
            aria-pressed={tool === id}
          >
            {id === 'trim' && 'Trim'}
            {id === 'cut' && 'Cut'}
            {id === 'region' && 'Region'}
            {id === 'redact' && 'Redact'}
          </button>
        ))}
        <button type="button" className="tool" onClick={onAdd}>
          + Add
        </button>
      </nav>
    </div>
  );
}

/**
 * Sliced rendering.
 *
 * The editor and the exporter both draw through here. Nothing ever allocates a
 * canvas as tall as the document: a slice (the visible viewport, or one PDF
 * page) is rendered at a time. That is what keeps 40,000px documents working on
 * a phone, where a single canvas over ~16M pixels is refused by the browser.
 */

import type { Layout } from './document';
import type { FramePlacement } from './stitcher';

export interface FrameSource {
  bitmap: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SliceOptions {
  /** First output row to paint (may be negative for overscan). */
  outY0: number;
  /** Exclusive last output row. */
  outY1: number;
  /** Device pixels per output pixel. */
  scale: number;
  /** Target pixel where (outY0, layout.x0) lands. */
  dx?: number;
  dy?: number;
  background?: string;
}

function drawVirtualBand(
  ctx: Ctx,
  frames: FrameSource[],
  placements: FramePlacement[],
  vY0: number,
  vY1: number,
  x0: number,
  x1: number,
  dx: number,
  dy: number,
  scale: number,
): void {
  for (const p of placements) {
    const frame = frames[p.frameIndex];
    if (!frame) continue;
    const start = p.docY + p.srcY0;
    const end = p.docY + p.srcY1;
    if (end <= vY0 || start >= vY1) continue;

    const a = Math.max(vY0, start);
    const b = Math.min(vY1, end);
    const sy = p.srcY0 + (a - start);
    const srcW = Math.max(1, Math.min(x1, frame.width) - x0);
    ctx.drawImage(
      frame.bitmap,
      x0,
      sy,
      srcW,
      Math.max(1, b - a),
      dx,
      dy + (a - vY0) * scale,
      srcW * scale,
      (b - a) * scale,
    );
  }
}

export function paintSlice(
  ctx: Ctx,
  frames: FrameSource[],
  placements: FramePlacement[],
  layout: Layout,
  opts: SliceOptions,
): void {
  const { outY0, outY1, scale, dx = 0, dy = 0, background = '#ffffff' } = opts;
  const w = layout.width * scale;
  const h = Math.max(0, (outY1 - outY0) * scale);
  if (h <= 0 || w <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, w, h);
  ctx.clip();
  ctx.fillStyle = background;
  ctx.fillRect(dx, dy, w, h);

  const x0 = layout.x0;
  const x1 = layout.x0 + layout.width;

  for (const seg of layout.segments) {
    const len = seg.vY1 - seg.vY0;
    const segOutStart = seg.outY0;
    const segOutEnd = seg.outY0 + len;
    const tA = Math.max(outY0, segOutStart);
    const tB = Math.min(outY1, segOutEnd);
    if (tB <= tA) continue;

    const vA = seg.vY0 + (tA - segOutStart);
    const vB = seg.vY0 + (tB - segOutStart);
    drawVirtualBand(ctx, frames, placements, vA, vB, x0, x1, dx, dy + (tA - outY0) * scale, scale);
  }

  ctx.restore();
}

/** Paint redactions for a slice. Kept separate so the hot path stays readable. */
export function paintRedactions(
  ctx: Ctx,
  layout: Layout,
  redactions: { x: number; y: number; w: number; h: number }[],
  opts: SliceOptions,
): void {
  if (redactions.length === 0) return;
  const { outY0, outY1, scale, dx = 0, dy = 0 } = opts;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, layout.width * scale, Math.max(0, (outY1 - outY0) * scale));
  ctx.clip();
  ctx.fillStyle = '#000000';
  for (const rect of redactions) {
    for (const seg of layout.segments) {
      const a = Math.max(rect.y, seg.vY0);
      const b = Math.min(rect.y + rect.h, seg.vY1);
      if (b <= a) continue;
      const outTop = seg.outY0 + (a - seg.vY0);
      if (outTop + (b - a) <= outY0 || outTop >= outY1) continue;
      const clipTop = Math.max(outTop, outY0);
      const clipBottom = Math.min(outTop + (b - a), outY1);
      const x = Math.max(rect.x, layout.x0) - layout.x0;
      const w = Math.min(rect.x + rect.w, layout.x0 + layout.width) - Math.max(rect.x, layout.x0);
      if (w <= 0) continue;
      ctx.fillRect(dx + x * scale, dy + (clipTop - outY0) * scale, w * scale, (clipBottom - clipTop) * scale);
    }
  }
  ctx.restore();
}

/** Render one whole slice into a fresh canvas. Used by export and PDF pages. */
export function renderSlice(
  frames: FrameSource[],
  placements: FramePlacement[],
  layout: Layout,
  redactions: { x: number; y: number; w: number; h: number }[],
  outY0: number,
  outY1: number,
  scale: number,
  maxHeight?: number,
): HTMLCanvasElement {
  const width = Math.max(1, Math.round(layout.width * scale));
  const height = Math.max(1, Math.round((outY1 - outY0) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = maxHeight ? Math.min(height, maxHeight) : height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.imageSmoothingQuality = 'high';
  const opts: SliceOptions = { outY0, outY1, scale };
  paintSlice(ctx, frames, placements, layout, opts);
  paintRedactions(ctx, layout, redactions, opts);
  return canvas;
}

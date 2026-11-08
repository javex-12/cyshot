/**
 * Export: PNG / JPEG / PDF, plus sharing through the OS sheet.
 *
 * PNG and JPEG go through a canvas, which browsers cap (~16M pixels, 16384px
 * per side). Past that we render at a reduced scale and report it. PDF is the
 * full-resolution path: it is sliced into pages, so nothing is ever downscaled.
 */

import type { Layout, Rect } from './document';
import type { FramePlacement } from './stitcher';
import type { FrameSource } from './render';
import { paintRedactions, paintSlice, renderSlice } from './render';

/**
 * Canvas ceilings. Safari on iOS refuses anything over ~16M pixels or 16384px
 * per side; Chrome/Android will usually take far more, but a failed allocation
 * is silent (you get a blank canvas), so `canRender` probes for real.
 */
function canvasLimits(): { area: number; dim: number } {
  if (typeof navigator === 'undefined') return { area: 64_000_000, dim: 16_384 };
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  return ios ? { area: 64_000_000, dim: 16_384 } : { area: 128_000_000, dim: 32_767 };
}

export interface RenderInput {
  frames: FrameSource[];
  placements: FramePlacement[];
  layout: Layout;
  redactions: Rect[];
}

/** Largest whole-image scale this device should be able to hold in one canvas. */
export function planScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  const limits = canvasLimits();
  const byArea = Math.sqrt(limits.area / (width * height));
  const byDim = limits.dim / Math.max(width, height);
  return Math.max(0.05, Math.min(1, Math.floor(Math.min(byArea, byDim) * 100) / 100));
}

/** Allocating a too-large canvas does not throw, it silently yields a blank one. */
function allocate(width: number, height: number): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 1, 1);
    const probe = ctx.getImageData(0, 0, 1, 1).data;
    if (!(probe[3] === 255 && probe[0] > 200)) return null;
    return canvas;
  } catch {
    return null;
  }
}

export function renderDocument(input: RenderInput, preferFullResolution = true): { canvas: HTMLCanvasElement; scale: number } {
  const { frames, placements, layout, redactions } = input;
  // Always attempt 100% full original resolution first if requested
  const scalesToTry: number[] = preferFullResolution
    ? [1.0, planScale(layout.width, layout.height)]
    : [planScale(layout.width, layout.height)];

  for (let s of scalesToTry) {
    if (s <= 0) continue;
    for (let attempt = 0; attempt < 5; attempt++) {
      const width = Math.max(1, Math.round(layout.width * s));
      const height = Math.max(1, Math.round(layout.height * s));
      const canvas = allocate(width, height);
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create a 2D canvas context');
        ctx.clearRect(0, 0, width, height);

        // Paint in strips so the browser never sees one huge draw call.
        const stripOut = 2000 / s;
        for (let y = 0; y < layout.height; y += stripOut) {
          const slice = {
            outY0: y,
            outY1: Math.min(layout.height, y + stripOut),
            scale: s,
            dy: y * s,
          };
          paintSlice(ctx, frames, placements, layout, slice);
          paintRedactions(ctx, layout, redactions, slice);
        }
        return { canvas, scale: s };
      }
      s = Math.max(0.05, Math.round(s * 0.75 * 100) / 100);
    }
  }

  throw new Error('This device could not allocate a canvas for the image. Export as PDF instead.');
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode this image'))),
      type,
      quality,
    );
  });
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  scale: number;
  width: number;
  height: number;
}

export async function exportImage(
  input: RenderInput,
  format: 'image/png' | 'image/jpeg',
  quality = 0.92,
): Promise<ExportResult> {
  const { canvas, scale } = renderDocument(input);
  const blob = await canvasToBlob(canvas, format, format === 'image/jpeg' ? quality : undefined);
  const ext = format === 'image/png' ? 'png' : 'jpg';
  return {
    blob,
    filename: `cyshot-${input.layout.width}x${input.layout.height}.${ext}`,
    scale,
    width: canvas.width,
    height: canvas.height,
  };
}

export async function exportPdf(input: RenderInput): Promise<ExportResult> {
  const { jsPDF } = await import('jspdf');
  const { frames, placements, layout, redactions } = input;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  const contentHeight = pageHeight - margin * 2;

  // Rows of source that fit one page, also capped so a page canvas stays small.
  const rowsByPage = Math.floor((layout.width * contentHeight) / contentWidth);
  const rowsByMemory = Math.floor(6_000_000 / Math.max(1, layout.width));
  const rowsPerPage = Math.max(200, Math.min(rowsByPage, rowsByMemory));

  let first = true;
  for (let y = 0; y < layout.height; y += rowsPerPage) {
    const y1 = Math.min(layout.height, y + rowsPerPage);
    const slice = renderSlice(frames, placements, layout, redactions, y, y1, 1);
    if (!first) pdf.addPage();
    first = false;
    const drawHeight = ((y1 - y) * contentWidth) / layout.width;
    pdf.addImage(
      slice.toDataURL('image/jpeg', 0.92),
      'JPEG',
      margin,
      margin,
      contentWidth,
      drawHeight,
      undefined,
      'FAST',
    );
  }

  return {
    blob: pdf.output('blob'),
    filename: `cyshot-${layout.width}x${layout.height}.pdf`,
    scale: 1,
    width: layout.width,
    height: layout.height,
  };
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function canShareFiles(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
}

export async function share(blob: Blob, filename: string, title: string): Promise<boolean> {
  if (!canShareFiles()) return false;
  const file = new File([blob], filename, { type: blob.type });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    return false;
  }
}

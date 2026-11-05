/**
 * Editable document model.
 *
 * The stitched result is a virtual image (docWidth x docHeight). Every edit is
 * expressed in *virtual* coordinates:
 *   - trimTop / trimBottom: drop rows from the ends ("stop here")
 *   - removed: ranges cut out of the middle (a section between two cuts)
 *   - cropX: keep only a horizontal slice (region crop)
 *   - redactions: rectangles painted over
 *
 * `buildLayout` turns that into the output document: a list of kept segments
 * with their output offsets. Rendering and export both walk these segments, so
 * nothing ever needs one giant canvas.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Range {
  y0: number;
  y1: number;
}

export interface EditOps {
  trimTop: number;
  trimBottom: number;
  removed: Range[];
  cropX: { x: number; w: number } | null;
  redactions: Rect[];
  dividers: number[];
}

export interface Segment {
  /** Virtual start row (inclusive). */
  vY0: number;
  /** Virtual end row (exclusive). */
  vY1: number;
  /** Output start row (inclusive). */
  outY0: number;
}

export interface Layout {
  /** Output width in px. */
  width: number;
  /** Output height in px. */
  height: number;
  /** Output x origin inside the virtual image. */
  x0: number;
  segments: Segment[];
}

export function emptyOps(): EditOps {
  return { trimTop: 0, trimBottom: 0, removed: [], cropX: null, redactions: [], dividers: [] };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.y1 > r.y0).sort((a, b) => a.y0 - b.y0);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.y0 <= last.y1) last.y1 = Math.max(last.y1, r.y1);
    else out.push({ y0: r.y0, y1: r.y1 });
  }
  return out;
}

export function buildLayout(docWidth: number, docHeight: number, ops: EditOps): Layout {
  const top = clamp(ops.trimTop, 0, docHeight);
  const bottom = clamp(docHeight - ops.trimBottom, top, docHeight);

  const removed = mergeRanges(
    ops.removed.map((r) => ({ y0: clamp(r.y0, top, bottom), y1: clamp(r.y1, top, bottom) })),
  );

  const segments: Segment[] = [];
  let cursor = top;
  let outY = 0;
  for (const r of removed) {
    if (r.y0 > cursor) {
      segments.push({ vY0: cursor, vY1: r.y0, outY0: outY });
      outY += r.y0 - cursor;
    }
    cursor = Math.max(cursor, r.y1);
  }
  if (cursor < bottom) segments.push({ vY0: cursor, vY1: bottom, outY0: outY });

  const height = segments.reduce((sum, s) => sum + (s.vY1 - s.vY0), 0);
  const cropW = ops.cropX ? clamp(ops.cropX.w, 1, docWidth - ops.cropX.x) : docWidth;
  const x0 = ops.cropX ? clamp(ops.cropX.x, 0, docWidth - 1) : 0;

  return { width: Math.round(cropW), height: Math.round(height), x0: Math.round(x0), segments };
}

/** Output row -> virtual row. Rows inside a removed range snap to its start. */
export function outToVirtual(layout: Layout, outY: number): number {
  if (layout.segments.length === 0) return 0;
  const y = clamp(outY, 0, layout.height);
  for (const s of layout.segments) {
    const len = s.vY1 - s.vY0;
    if (y < s.outY0 + len) return s.vY0 + (y - s.outY0);
  }
  const last = layout.segments[layout.segments.length - 1];
  return last.vY1;
}

/** Virtual row -> output row, or null when the row was cut away. */
export function virtualToOut(layout: Layout, vY: number): number | null {
  for (const s of layout.segments) {
    if (vY >= s.vY0 && vY < s.vY1) return s.outY0 + (vY - s.vY0);
  }
  return null;
}

/** Map a rect from output space to virtual space (used by the redaction tool). */
export function outRectToVirtual(layout: Layout, rect: Rect): Rect {
  const yTop = outToVirtual(layout, rect.y);
  const yBottom = outToVirtual(layout, rect.y + rect.h);
  return { x: rect.x, y: yTop, w: rect.w, h: Math.max(1, yBottom - yTop) };
}

/** Sections are the pieces between cut lines, in virtual coordinates. */
export function buildSections(docHeight: number, dividers: number[]): Range[] {
  const cuts = [...new Set(dividers.map((d) => Math.round(d)).filter((d) => d > 0 && d < docHeight))].sort(
    (a, b) => a - b,
  );
  const edges = [0, ...cuts, docHeight];
  const sections: Range[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] > edges[i]) sections.push({ y0: edges[i], y1: edges[i + 1] });
  }
  return sections;
}

/** A section counts as removed when the layout keeps none of its rows. */
export function isSectionRemoved(layout: Layout, section: Range): boolean {
  return !layout.segments.some((s) => s.vY1 > section.y0 && s.vY0 < section.y1);
}

export function toggleSection(ops: EditOps, section: Range): EditOps {
  const already = ops.removed.some((r) => r.y0 <= section.y0 && r.y1 >= section.y1);
  if (already) {
    const removed = ops.removed.filter((r) => !(r.y0 === section.y0 && r.y1 === section.y1));
    return { ...ops, removed };
  }
  return { ...ops, removed: [...ops.removed, { y0: section.y0, y1: section.y1 }] };
}

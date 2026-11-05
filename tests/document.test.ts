import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  buildSections,
  emptyOps,
  isSectionRemoved,
  mergeRanges,
  outRectToVirtual,
  outToVirtual,
  toggleSection,
  virtualToOut,
} from '../src/lib/document';

describe('mergeRanges', () => {
  it('merges overlapping and touching ranges', () => {
    expect(mergeRanges([{ y0: 10, y1: 20 }, { y0: 15, y1: 30 }, { y0: 30, y1: 40 }])).toEqual([
      { y0: 10, y1: 40 },
    ]);
  });

  it('drops empty ranges', () => {
    expect(mergeRanges([{ y0: 5, y1: 5 }])).toEqual([]);
  });
});

describe('buildLayout', () => {
  it('keeps everything by default', () => {
    const layout = buildLayout(300, 1000, emptyOps());
    expect(layout.height).toBe(1000);
    expect(layout.width).toBe(300);
    expect(layout.segments).toEqual([{ vY0: 0, vY1: 1000, outY0: 0 }]);
  });

  it('trims both ends', () => {
    const layout = buildLayout(300, 1000, { ...emptyOps(), trimTop: 100, trimBottom: 50 });
    expect(layout.height).toBe(850);
    expect(layout.segments).toEqual([{ vY0: 100, vY1: 950, outY0: 0 }]);
  });

  it('removes a middle section and closes the gap', () => {
    const layout = buildLayout(300, 1000, { ...emptyOps(), removed: [{ y0: 200, y1: 400 }] });
    expect(layout.height).toBe(800);
    expect(layout.segments).toEqual([
      { vY0: 0, vY1: 200, outY0: 0 },
      { vY0: 400, vY1: 1000, outY0: 200 },
    ]);
  });

  it('maps rows in both directions across a cut', () => {
    const layout = buildLayout(300, 1000, { ...emptyOps(), removed: [{ y0: 200, y1: 400 }] });
    expect(virtualToOut(layout, 100)).toBe(100);
    expect(virtualToOut(layout, 300)).toBeNull();
    expect(virtualToOut(layout, 400)).toBe(200);
    expect(outToVirtual(layout, 200)).toBe(400);
    expect(outToVirtual(layout, 199)).toBe(199);
  });

  it('applies a horizontal crop and reports the new width', () => {
    const layout = buildLayout(300, 500, { ...emptyOps(), cropX: { x: 40, w: 200 } });
    expect(layout.width).toBe(200);
    expect(layout.x0).toBe(40);
  });

  it('clamps a region crop that runs past the right edge', () => {
    const layout = buildLayout(300, 500, { ...emptyOps(), cropX: { x: 250, w: 200 } });
    expect(layout.width).toBe(50);
  });

  it('is stable when everything is removed', () => {
    const layout = buildLayout(300, 500, { ...emptyOps(), removed: [{ y0: 0, y1: 500 }] });
    expect(layout.height).toBe(0);
    expect(layout.segments).toEqual([]);
  });
});

describe('sections', () => {
  it('splits at dividers', () => {
    expect(buildSections(900, [300, 600])).toEqual([
      { y0: 0, y1: 300 },
      { y0: 300, y1: 600 },
      { y0: 600, y1: 900 },
    ]);
  });

  it('ignores dividers outside the document', () => {
    expect(buildSections(900, [-5, 0, 950])).toEqual([{ y0: 0, y1: 900 }]);
  });

  it('toggles a section off and back on', () => {
    const section = { y0: 300, y1: 600 };
    let ops = { ...emptyOps(), dividers: [300, 600] };
    let layout = buildLayout(100, 900, ops);
    expect(isSectionRemoved(layout, section)).toBe(false);

    ops = toggleSection(ops, section);
    layout = buildLayout(100, 900, ops);
    expect(isSectionRemoved(layout, section)).toBe(true);
    expect(layout.height).toBe(600);

    ops = toggleSection(ops, section);
    layout = buildLayout(100, 900, ops);
    expect(isSectionRemoved(layout, section)).toBe(false);
    expect(layout.height).toBe(900);
  });
});

describe('outRectToVirtual', () => {
  it('shifts a redaction below a cut by the removed height', () => {
    const layout = buildLayout(300, 1000, { ...emptyOps(), removed: [{ y0: 200, y1: 400 }] });
    const rect = outRectToVirtual(layout, { x: 10, y: 250, w: 50, h: 100 });
    expect(rect.y).toBe(450);
    expect(rect.h).toBe(100);
  });
});

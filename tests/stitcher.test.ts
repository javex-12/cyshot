import { describe, expect, it } from 'vitest';
import { composite, estimateMatch, stitchFrames, type FramePixels } from '../src/lib/stitcher';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic "page": text-like blobs on white, unique enough row to row. */
function makeDocument(width: number, height: number, seed = 7): FramePixels {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < height; y += 10) {
    for (let x = 6; x < width - 6; x += 6) {
      if (rand() > 0.52) continue;
      const shade = 20 + Math.floor(rand() * 90);
      const w = 2 + Math.floor(rand() * 3);
      for (let dy = 0; dy < 6 && y + dy < height; dy++) {
        for (let dx = 0; dx < w && x + dx < width; dx++) {
          const i = ((y + dy) * width + (x + dx)) * 4;
          data[i] = shade;
          data[i + 1] = shade;
          data[i + 2] = shade;
          data[i + 3] = 255;
        }
      }
    }
  }
  return { width, height, data };
}

/** Cut a viewport-sized frame out of the document at a scroll position. */
function frameAt(doc: FramePixels, scrollY: number, viewportH: number): FramePixels {
  const data = new Uint8ClampedArray(doc.width * viewportH * 4);
  data.fill(255);
  const start = Math.max(0, Math.min(doc.height - viewportH, scrollY));
  data.set(doc.data.subarray(start * doc.width * 4, (start + viewportH) * doc.width * 4));
  return { width: doc.width, height: viewportH, data };
}

/** Paint a fake sticky header over the top of a frame. */
function withStickyHeader(frame: FramePixels, bandH: number, colour = 40): FramePixels {
  const data = new Uint8ClampedArray(frame.data);
  for (let y = 0; y < bandH; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 4;
      data[i] = colour;
      data[i + 1] = colour;
      data[i + 2] = colour;
      data[i + 3] = 255;
    }
  }
  return { width: frame.width, height: frame.height, data };
}

function addNoise(frame: FramePixels, amplitude: number, seed = 3): FramePixels {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(frame.data);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * amplitude;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  return { width: frame.width, height: frame.height, data };
}

function meanAbsDiff(a: FramePixels, b: FramePixels, y0: number, y1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[i]);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

describe('estimateMatch', () => {
  const W = 240;
  const V = 600;
  const doc = makeDocument(W, 4000);

  it('recovers the exact scroll distance', () => {
    const a = frameAt(doc, 0, V);
    const b = frameAt(doc, 420, V);
    const m = estimateMatch(a, b);
    expect(m.matched).toBe(true);
    expect(m.offset).toBe(420);
    expect(m.score).toBeLessThan(1);
  });

  it('still matches with JPEG-ish noise', () => {
    const a = addNoise(frameAt(doc, 100, V), 6);
    const b = addNoise(frameAt(doc, 100 + 333, V), 6);
    const m = estimateMatch(a, b);
    expect(m.matched).toBe(true);
    expect(m.offset).toBe(333);
  });

  it('detects a sticky header and ignores it when matching', () => {
    const a = withStickyHeader(frameAt(doc, 0, V), 56);
    const b = withStickyHeader(frameAt(doc, 300, V), 56);
    const m = estimateMatch(a, b);
    // Blank spacer rows inside the header can extend the detected band by a few
    // pixels; skipping them is harmless because the previous frame covers them.
    expect(m.topFixed).toBeGreaterThanOrEqual(56);
    expect(m.topFixed).toBeLessThan(70);
    expect(m.matched).toBe(true);
    expect(m.offset).toBe(300);
  });

  it('reports no overlap when the jump is bigger than the screen', () => {
    const a = frameAt(doc, 0, V);
    const b = frameAt(doc, 1400, V);
    const m = estimateMatch(a, b);
    expect(m.matched).toBe(false);
  });
});

describe('stitchFrames', () => {
  const W = 240;
  const V = 600;
  const scrolls = [0, 380, 760, 1140, 1520, 1900, 2280, 2660, 3040, 3400];
  const doc = makeDocument(W, 4000);

  it('rebuilds the document from overlapping frames, pixel for pixel', () => {
    const frames = scrolls.map((s) => frameAt(doc, s, V));
    const result = stitchFrames(frames);
    expect(result.height).toBe(doc.height);
    expect(result.warnings).toEqual([]);
    const out = composite(result, frames);
    expect(out.height).toBe(doc.height);
    expect(meanAbsDiff(out, doc, 0, doc.height)).toBe(0);
  });

  it('keeps a sticky header exactly once instead of repeating it at every seam', () => {
    const frames = scrolls.map((s) => withStickyHeader(frameAt(doc, s, V), 56));
    const result = stitchFrames(frames);
    const out = composite(result, frames);
    expect(out.height).toBe(doc.height);
    // Below the header every row must be genuine page content.
    expect(meanAbsDiff(out, doc, 56, doc.height)).toBeLessThan(0.5);
  });

  it('drops duplicate frames', () => {
    const frames = [frameAt(doc, 0, V), frameAt(doc, 0, V), frameAt(doc, 400, V)];
    const result = stitchFrames(frames);
    expect(result.placements).toHaveLength(2);
    expect(result.warnings.some((w) => w.kind === 'duplicate')).toBe(true);
    expect(result.height).toBe(1000);
  });

  it('degrades to edge-to-edge joining and warns when frames do not overlap', () => {
    const frames = [frameAt(doc, 0, V), frameAt(doc, 1600, V)];
    const result = stitchFrames(frames);
    expect(result.placements).toHaveLength(2);
    expect(result.warnings.some((w) => w.kind === 'no-overlap')).toBe(true);
    expect(result.height).toBeGreaterThan(V);
  });

  it('keeps vertical order when frames arrive out of order? no - order is the input order', () => {
    // Explicit: input order defines output order, offsets are always positive.
    const frames = [frameAt(doc, 0, V), frameAt(doc, 200, V)];
    const result = stitchFrames(frames);
    expect(result.placements[1].docY).toBe(200);
  });
});

/**
 * Long-image stitching.
 *
 * Pure pixel maths, no DOM: the same code runs in the browser and in tests.
 *
 * Given consecutive viewport frames of the same page or app, we work out how
 * far the content moved between them, then composite the frames into one tall
 * image. Screenshots usually have a sticky header (status bar, app bar) and
 * sometimes a sticky footer (tab bar, home indicator) that do not move, so the
 * match ignores those bands and skips them when compositing.
 */

export interface FramePixels {
  width: number;
  height: number;
  /** RGBA, row-major, length === width * height * 4 */
  data: Uint8ClampedArray;
}

export interface FramePlacement {
  frameIndex: number;
  /** Document row that this frame's row 0 sits on. */
  docY: number;
  /** First source row to composite (skips a sticky header on later frames). */
  srcY0: number;
  /** Exclusive last source row to composite (skips a sticky footer). */
  srcY1: number;
}

export type WarningKind = 'duplicate' | 'no-overlap';

export interface StitchWarning {
  frameIndex: number;
  kind: WarningKind;
  message: string;
}

export interface FrameMatch {
  /** Whether the overlap was found confidently. */
  matched: boolean;
  /** Scroll distance in px: how far the content moved between the two frames. */
  offset: number;
  /** Mean absolute error of the winning alignment, 0-255. Lower is better. */
  score: number;
  /** Height of the sticky band pinned to the top of both frames. */
  topFixed: number;
  /** Height of the sticky band pinned to the bottom of both frames. */
  bottomFixed: number;
  /** Rows of genuine shared content at the winning alignment. */
  overlap: number;
}

export interface StitchResult {
  width: number;
  height: number;
  placements: FramePlacement[];
  matches: FrameMatch[];
  warnings: StitchWarning[];
}

export interface MatchOptions {
  /** Rows of shared content required before we trust a match. */
  minOverlap?: number;
  /** Mean absolute error above which we treat the frames as unmatched. */
  threshold?: number;
  /** Whether to automatically detect and correct reverse or out-of-order screenshots. */
  autoOrder?: boolean;
}

/** Column buckets per row signature. */
const BUCKETS = 16;
const DEFAULT_THRESHOLD = 7.5;
const STICKY_EPS = 1.2;

function signatures(frame: FramePixels): Float32Array {
  const w = frame.width;
  const h = frame.height;
  const data = frame.data;
  const sig = new Float32Array(h * BUCKETS);
  if (w <= 0 || h <= 0) return sig;

  const bucketOf = new Uint16Array(w);
  const counts = new Float32Array(BUCKETS);
  for (let x = 0; x < w; x++) {
    const b = Math.min(BUCKETS - 1, Math.floor((x * BUCKETS) / w));
    bucketOf[x] = b;
    counts[b] += 1;
  }

  for (let y = 0; y < h; y++) {
    const rowOff = y * w * 4;
    const out = y * BUCKETS;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      sig[out + bucketOf[x]] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    for (let b = 0; b < BUCKETS; b++) {
      if (counts[b] > 0) sig[out + b] /= counts[b];
    }
  }
  return sig;
}

const sigCache = new WeakMap<FramePixels, Float32Array>();

export function sigOf(frame: FramePixels): Float32Array {
  let s = sigCache.get(frame);
  if (!s) {
    s = signatures(frame);
    sigCache.set(frame, s);
  }
  return s;
}

/** Mean absolute difference between the two signatures at the same row. */
export function rowDistance(sigA: Float32Array, sigB: Float32Array, y: number): number {
  const off = y * BUCKETS;
  let sum = 0;
  for (let b = 0; b < BUCKETS; b++) sum += Math.abs(sigA[off + b] - sigB[off + b]);
  return sum / BUCKETS;
}

/**
 * Checks if a row is part of a fixed band (status bar / header / footer).
 * Allows for localized variance such as clock digits or battery percentage by
 * verifying that the vast majority (>= 75%) of horizontal column buckets match identically.
 */
function isStickyRow(sigA: Float32Array, sigB: Float32Array, y: number): boolean {
  const off = y * BUCKETS;
  let matching = 0;
  for (let b = 0; b < BUCKETS; b++) {
    if (Math.abs(sigA[off + b] - sigB[off + b]) < STICKY_EPS) matching++;
  }
  return matching >= Math.floor(BUCKETS * 0.75);
}

/** How much visual content a row has. Flat rows match anything, so they are weak evidence. */
function rowWeight(sig: Float32Array, y: number): number {
  const off = y * BUCKETS;
  let mean = 0;
  for (let b = 0; b < BUCKETS; b++) mean += sig[off + b];
  mean /= BUCKETS;
  let variance = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const d = sig[off + b] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / BUCKETS);
  if (std < 2.5) return 0;
  return Math.min(1, std / 12);
}

/** Rows pinned to the top that are identical in both frames (status bar, sticky header). */
function detectTopFixed(sigA: Float32Array, sigB: Float32Array, h: number): number {
  const cap = Math.floor(h * 0.3);
  let y = 0;
  while (y < cap && isStickyRow(sigA, sigB, y)) y++;
  // A whole-frame match is "same screen", not a sticky band.
  return y >= cap ? 0 : y;
}

function detectBottomFixed(sigA: Float32Array, sigB: Float32Array, h: number, topFixed: number): number {
  const cap = Math.floor(h * 0.25);
  let y = h - 1;
  let n = 0;
  while (n < cap && y > topFixed && isStickyRow(sigA, sigB, y)) {
    y--;
    n++;
  }
  return n >= cap ? 0 : n;
}

/**
 * Estimate how far the content scrolled between two frames.
 */
export function estimateMatch(prev: FramePixels, next: FramePixels, opts: MatchOptions = {}): FrameMatch {
  const h = Math.min(prev.height, next.height);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const sigA = sigOf(prev);
  const sigB = sigOf(next);

  const topFixed = detectTopFixed(sigA, sigB, h);
  const bottomFixed = detectBottomFixed(sigA, sigB, h, topFixed);
  const minOverlap = opts.minOverlap ?? Math.max(24, Math.round(h * 0.03));
  const maxOffset = h - topFixed - bottomFixed - minOverlap;

  const contentEnd = h - bottomFixed;
  const empty: FrameMatch = {
    matched: false,
    offset: Math.max(1, h - topFixed),
    score: Infinity,
    topFixed,
    bottomFixed,
    overlap: 0,
  };
  if (maxOffset < 1) return empty;

  // Mean absolute error between next rows [topFixed, ...) and prev rows shifted by d.
  // Rows with real content count more; flat rows would otherwise match anything.
  const score = (d: number, rowStep: number): number => {
    let weighted = 0;
    let weightSum = 0;
    let plain = 0;
    let plainCount = 0;
    const end = Math.min(contentEnd, h - d);
    for (let i = topFixed; i < end; i += rowStep) {
      const offB = i * BUCKETS;
      const offA = (i + d) * BUCKETS;
      let sum = 0;
      for (let b = 0; b < BUCKETS; b++) sum += Math.abs(sigB[offB + b] - sigA[offA + b]);
      const dist = sum / BUCKETS;
      plain += dist;
      plainCount++;
      const w = rowWeight(sigB, i);
      weighted += dist * w;
      weightSum += w;
    }
    if (weightSum > 4) return weighted / weightSum;
    if (plainCount === 0) return Infinity;
    return plain / plainCount;
  };

  // d = 0 is included so a repeated screen is detected instead of appended.
  let bestD = -1;
  let bestScore = Infinity;
  for (let d = 0; d <= maxOffset; d += 2) {
    const s = score(d, 3);
    if (s < bestScore) {
      bestScore = s;
      bestD = d;
    }
  }
  if (bestD < 0) return empty;

  const from = Math.max(0, bestD - 2);
  const to = Math.min(maxOffset, bestD + 2);
  for (let d = from; d <= to; d++) {
    const s = score(d, 1);
    if (s < bestScore) {
      bestScore = s;
      bestD = d;
    }
  }

  const overlap = Math.min(contentEnd, h - bestD) - topFixed;
  if (bestScore > threshold) {
    return { ...empty, score: bestScore, overlap: Math.max(0, overlap) };
  }
  return { matched: true, offset: bestD, score: bestScore, topFixed, bottomFixed, overlap: Math.max(0, overlap) };
}

/**
 * Work out where every frame belongs in the final document.
 * Automatically checks for reverse-order inputs (common on mobile photo pickers).
 */
export function stitchWith(
  count: number,
  get: (index: number) => FramePixels,
  opts: MatchOptions & { onProgress?: (done: number, total: number) => void } = {},
): StitchResult {
  if (count === 0) throw new Error('stitchFrames: no frames');

  // Check if frames were supplied in reverse order (e.g. from newest-first mobile gallery)
  let order = Array.from({ length: count }, (_, i) => i);
  if (opts.autoOrder !== false && count >= 2) {
    const f0 = get(0);
    const f1 = get(1);
    const mForward = estimateMatch(f0, f1, opts);
    const mReverse = estimateMatch(f1, f0, opts);

    if (!mForward.matched && mReverse.matched && mReverse.score < DEFAULT_THRESHOLD) {
      let reverseVotes = 1;
      let forwardVotes = 0;
      if (count > 2) {
        const fEnd = get(count - 1);
        const fPrevEnd = get(count - 2);
        const mFwdEnd = estimateMatch(fPrevEnd, fEnd, opts);
        const mRevEnd = estimateMatch(fEnd, fPrevEnd, opts);
        if (mRevEnd.matched && !mFwdEnd.matched) reverseVotes++;
        if (mFwdEnd.matched) forwardVotes++;
      }
      if (reverseVotes > forwardVotes) {
        order = order.reverse();
      }
    }
  }

  const first = get(order[0]);
  const width = first.width;
  const placements: FramePlacement[] = [
    { frameIndex: order[0], docY: 0, srcY0: 0, srcY1: first.height },
  ];
  const matches: FrameMatch[] = [];
  const warnings: StitchWarning[] = [];

  for (let i = 1; i < count; i++) {
    const prevPlacement = placements[placements.length - 1];
    const prev = get(prevPlacement.frameIndex);
    const nextIdx = order[i];
    const next = get(nextIdx);
    opts.onProgress?.(i, count - 1);
    const match = estimateMatch(prev, next, opts);
    matches.push(match);

    if (match.matched && match.offset < 4) {
      warnings.push({
        frameIndex: nextIdx,
        kind: 'duplicate',
        message: `Frame ${nextIdx + 1} shows the same screen as frame ${prevPlacement.frameIndex + 1} - skipped.`,
      });
      continue;
    }

    if (!match.matched) {
      warnings.push({
        frameIndex: nextIdx,
        kind: 'no-overlap',
        message: `No overlap found between frame ${prevPlacement.frameIndex + 1} and ${nextIdx + 1}; they were joined edge to edge. Some content may be missing.`,
      });
    }

    const isLast = i === count - 1;
    placements.push({
      frameIndex: nextIdx,
      docY: prevPlacement.docY + Math.max(1, match.offset),
      srcY0: match.topFixed,
      srcY1: isLast ? next.height : Math.max(match.topFixed + 1, next.height - match.bottomFixed),
    });
  }

  let height = 0;
  for (const p of placements) {
    height = Math.max(height, p.docY + p.srcY1);
  }

  return { width, height, placements, matches, warnings };
}

/** Convenience wrapper for callers that already hold every frame in memory. */
export function stitchFrames(frames: FramePixels[], opts: MatchOptions = {}): StitchResult {
  return stitchWith(frames.length, (i) => frames[i], opts);
}

/**
 * Flatten placements into one tall pixel buffer. Used by tests and by the
 * "export a small document" path; the editor renders slices instead so it never
 * needs a canvas bigger than the screen.
 */
export function composite(result: StitchResult, frames: FramePixels[]): FramePixels {
  const width = result.width;
  const height = Math.max(1, result.height);
  const data = new Uint8ClampedArray(width * height * 4);

  for (const p of result.placements) {
    const frame = frames[p.frameIndex];
    const rows = p.srcY1 - p.srcY0;
    for (let r = 0; r < rows; r++) {
      const dstY = p.docY + p.srcY0 + r;
      if (dstY < 0 || dstY >= height) continue;
      const srcStart = ((p.srcY0 + r) * frame.width) * 4;
      const dstStart = dstY * width * 4;
      data.set(frame.data.subarray(srcStart, srcStart + width * 4), dstStart);
    }
  }
  return { width, height, data };
}

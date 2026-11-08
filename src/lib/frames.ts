/**
 * Frame loading and the bridge between decoded images and the stitching core.
 */

import { stitchWith, type FramePixels, type StitchResult } from './stitcher';
import type { FrameSource } from './render';
import { isVideoFile, extractFramesFromVideo } from './video';

export interface LoadedFrame extends FrameSource {
  id: string;
  bitmap: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
}

/** Very wide inputs (above 4K) are clamped to stay in memory. */
const MAX_WIDTH = 4096;

let frameCounter = 0;

function nextId(): string {
  frameCounter += 1;
  return `f${frameCounter}`;
}

function drawToCanvas(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Decode blobs into frames of a common width. Frames come from different apps
 * and sometimes different devices, so normalising here means the stitcher can
 * assume a shared coordinate space.
 */
export async function loadFrames(
  blobs: Blob[],
  onProgress?: (done: number, total: number) => void,
  widthOverride?: number,
): Promise<LoadedFrame[]> {
  // If any input is a video file, unpack video frames first
  const imageBlobs: Blob[] = [];
  for (const blob of blobs) {
    if (isVideoFile(blob)) {
      const extracted = await extractFramesFromVideo(blob, (d, t) => {
        onProgress?.(d, t);
      });
      imageBlobs.push(...extracted);
    } else {
      imageBlobs.push(blob);
    }
  }

  const frames: LoadedFrame[] = [];
  let targetWidth = widthOverride ?? 0;

  for (let i = 0; i < imageBlobs.length; i++) {
    const bitmap = await createImageBitmap(imageBlobs[i], { imageOrientation: 'from-image' });
    const width = targetWidth || Math.min(bitmap.width, MAX_WIDTH);
    if (!targetWidth) targetWidth = width;

    if (bitmap.width === width) {
      frames.push({ id: nextId(), bitmap, width: bitmap.width, height: bitmap.height });
    } else {
      const canvas = drawToCanvas(bitmap, width, (bitmap.height * width) / bitmap.width);
      bitmap.close();
      frames.push({ id: nextId(), bitmap: canvas, width: canvas.width, height: canvas.height });
    }
    onProgress?.(i + 1, imageBlobs.length);
  }

  return frames;
}

export function framePixels(frame: LoadedFrame): FramePixels {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.drawImage(frame.bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, frame.width, frame.height);
  return { width: frame.width, height: frame.height, data: data.data };
}

/**
 * Stitch decoded frames, extracting raw pixels only two frames at a time.
 */
export function stitchLoadedFrames(
  frames: LoadedFrame[],
  onProgress?: (done: number, total: number) => void,
): StitchResult {
  const cache = new Map<number, FramePixels>();
  const get = (index: number): FramePixels => {
    const hit = cache.get(index);
    if (hit) return hit;
    const pixels = framePixels(frames[index]);
    cache.set(index, pixels);
    for (const key of [...cache.keys()]) {
      if (key < index - 2) cache.delete(key);
    }
    return pixels;
  };
  return stitchWith(frames.length, get, { onProgress });
}

export function disposeFrames(frames: LoadedFrame[]): void {
  for (const frame of frames) {
    if (typeof ImageBitmap !== 'undefined' && frame.bitmap instanceof ImageBitmap) frame.bitmap.close();
  }
}

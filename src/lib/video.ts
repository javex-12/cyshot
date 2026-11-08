/**
 * Video screen recording frame extractor.
 *
 * Allows users to turn a screen recording of ANY app or authorized website into
 * a full-page long screenshot on iOS, Android, and Desktop.
 */

export function isVideoFile(blob: Blob): boolean {
  if (blob.type && blob.type.startsWith('video/')) return true;
  if ('name' in blob && typeof (blob as File).name === 'string') {
    return /\.(mp4|mov|webm|m4v|3gp|mkv)$/i.test((blob as File).name);
  }
  return false;
}

/** Check if live in-browser screen recording is supported. */
export function supportsScreenRecord(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

/**
 * Extract sharp, overlapping key frames from a screen recording video.
 */
export async function extractFramesFromVideo(
  file: Blob,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not open video file. Ensure it is a valid MP4 or MOV.'));
      // Timeout after 8 seconds if video metadata fails to load
      setTimeout(() => reject(new Error('Timeout loading video metadata.')), 8000);
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Invalid video duration.');
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) {
      throw new Error('Invalid video dimensions.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create 2D canvas context.');

    // Sample video every 0.25 to 0.5s, capping total samples to 50
    const interval = Math.max(0.2, Math.min(0.6, duration / 40));
    const sampleTimes: number[] = [];
    for (let t = 0.05; t < duration; t += interval) {
      sampleTimes.push(t);
    }
    if (sampleTimes.length === 0) sampleTimes.push(0);

    const seekTo = (time: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = Math.min(time, duration - 0.05);
      });

    const rawBlobs: Blob[] = [];
    let prevThumb: Uint8ClampedArray | null = null;
    const thumbW = 32;
    const thumbH = 64;
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

    for (let i = 0; i < sampleTimes.length; i++) {
      const time = sampleTimes[i];
      await seekTo(time);
      onProgress?.(i + 1, sampleTimes.length);

      // Downsample to a small thumbnail to detect motion / pause
      if (thumbCtx) {
        thumbCtx.drawImage(video, 0, 0, thumbW, thumbH);
        const thumbData = thumbCtx.getImageData(0, 0, thumbW, thumbH).data;

        if (prevThumb) {
          // Compute average pixel difference
          let diffSum = 0;
          for (let p = 0; p < thumbData.length; p += 4) {
            diffSum +=
              Math.abs(thumbData[p] - prevThumb[p]) +
              Math.abs(thumbData[p + 1] - prevThumb[p + 1]) +
              Math.abs(thumbData[p + 2] - prevThumb[p + 2]);
          }
          const avgDiff = diffSum / (thumbW * thumbH * 3);

          // If the screen is essentially static (diff < 2.0) and we already have frames, skip duplicate
          if (avgDiff < 2.0 && rawBlobs.length > 0 && i < sampleTimes.length - 1) {
            continue;
          }
        }
        prevThumb = new Uint8ClampedArray(thumbData);
      }

      ctx.drawImage(video, 0, 0, width, height);
      const frameBlob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/jpeg', 0.95),
      );
      if (frameBlob) rawBlobs.push(frameBlob);
    }

    if (rawBlobs.length === 0) {
      throw new Error('No frames could be extracted from the video.');
    }

    return rawBlobs;
  } finally {
    URL.revokeObjectURL(url);
    video.src = '';
  }
}

/**
 * Capture live screen recording (supported in Chrome/Android & desktop).
 */
export async function startScreenCapture(
  onComplete: (blobs: Blob[]) => void,
  onError: (err: Error) => void,
): Promise<{ stop: () => void }> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is not supported in this browser.');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
  });

  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    const videoBlob = new Blob(chunks, { type: 'video/webm' });
    try {
      const frames = await extractFramesFromVideo(videoBlob);
      onComplete(frames);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  recorder.start(100);

  return {
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}

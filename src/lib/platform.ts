/**
 * What is the visitor running?
 *
 * Used for three decisions: which device preset a capture defaults to, which
 * install instructions make sense, and whether a share sheet is even possible.
 * iPadOS reports itself as a Mac, so touch points are what give it away.
 */

export type OS = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';
export type Preset = 'iphone' | 'android' | 'desktop';

export interface Platform {
  os: OS;
  label: string;
  preset: Preset;
  /** Chromium-based, so Web Share Target can be offered once installed. */
  chromium: boolean;
  /** Running from the home screen rather than a browser tab. */
  standalone: boolean;
}

function readUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent || '';
}

export function detectOS(ua = readUserAgent()): OS {
  const maxTouch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ sends a desktop macOS user agent; a real Mac has no touch screen.
  if (/Macintosh/i.test(ua) && maxTouch > 1) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

const LABELS: Record<OS, string> = {
  ios: 'iPhone or iPad',
  android: 'Android',
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
  other: 'this device',
};

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const display = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(display || iosStandalone);
}

export function detectPlatform(ua = readUserAgent()): Platform {
  const os = detectOS(ua);
  // Chrome, Edge, Opera and Samsung Internet all share Chromium's share-target support.
  const chromium = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser/i.test(ua) && !/Firefox|FxiOS/i.test(ua);
  return {
    os,
    label: LABELS[os],
    preset: os === 'ios' ? 'iphone' : os === 'android' ? 'android' : 'desktop',
    chromium,
    standalone: isStandalone(),
  };
}

/** True when the platform can route shares into an installed web app. */
export function supportsShareTarget(platform: Platform): boolean {
  return platform.os === 'android' && platform.chromium && platform.standalone;
}

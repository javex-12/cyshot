/**
 * 1-Tap Mobile & Desktop Bookmarklet for Authorized / Signed-in Websites.
 *
 * Allows non-technical mobile users to capture any signed-in web page directly
 * from their browser without ever needing to inspect cookies, cache, or devtools.
 */

export function getBookmarkletCode(cyshotOrigin: string): string {
  const code = `
javascript:(function(){
  try {
    const origin = ${JSON.stringify(cyshotOrigin)};
    const w = window.open(origin + '/?url=' + encodeURIComponent(window.location.href), '_blank');
    if (!w) {
      alert('Please allow popups to open Cyshot, or copy this page URL to Cyshot.');
    }
  } catch(e) {
    alert('Could not launch Cyshot: ' + e.message);
  }
})();
  `.trim().replace(/\s+/g, ' ');
  return code;
}

export const IOS_SHORTCUT_INSTRUCTIONS = [
  'Open the page in Safari or any app on your iPhone.',
  'Swipe down from the top-right to open Control Center and tap Screen Record (or take 2-4 screenshots while scrolling).',
  'Open Cyshot and tap "Choose Screenshots or Screen Recording" — Cyshot automatically stitches everything in full HD!',
];

export const ANDROID_INSTRUCTIONS = [
  'In Chrome on Android, you can install Cyshot as an app (Menu → Install).',
  'Once installed, use the normal Android Share menu in Chrome or any app to share screenshots or links directly to Cyshot.',
  'You can also record your screen with Android Quick Settings Screen Record and pick the video in Cyshot.',
];

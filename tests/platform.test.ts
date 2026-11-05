import { describe, expect, it } from 'vitest';
import { detectOS, detectPlatform, supportsShareTarget, type Platform } from '../src/lib/platform';
import { parseHeaders, withScheme } from '../src/lib/capture';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPOD =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const platform = (overrides: Partial<Platform>): Platform => ({
  os: 'android',
  label: 'Android',
  preset: 'android',
  chromium: true,
  standalone: true,
  ...overrides,
});

describe('detectOS', () => {
  it('recognises iPhone and iPod', () => {
    expect(detectOS(IPHONE)).toBe('ios');
    expect(detectOS(IPOD)).toBe('ios');
  });

  it('treats Android as Android, not Linux', () => {
    expect(detectOS(ANDROID)).toBe('android');
  });

  it('recognises desktop platforms', () => {
    expect(detectOS(WINDOWS)).toBe('windows');
    expect(detectOS(MAC)).toBe('macos');
    expect(detectOS('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36')).toBe('linux');
  });

  it('falls back to other for an unknown agent', () => {
    expect(detectOS('curl/8.5.0')).toBe('other');
  });
});

describe('detectPlatform', () => {
  it('defaults the capture preset to the visitor phone', () => {
    expect(detectPlatform(IPHONE).preset).toBe('iphone');
    expect(detectPlatform(ANDROID).preset).toBe('android');
    expect(detectPlatform(WINDOWS).preset).toBe('desktop');
    expect(detectPlatform(MAC).preset).toBe('desktop');
  });

  it('flags Chromium browsers, including Edge and Samsung Internet', () => {
    expect(detectPlatform(ANDROID).chromium).toBe(true);
    expect(detectPlatform(IPHONE).chromium).toBe(false);
    expect(detectPlatform(`${WINDOWS} Edg/131.0.0.0`).chromium).toBe(true);
    expect(
      detectPlatform('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 SamsungBrowser/24.0 Chrome/117 Mobile Safari/537.36')
        .chromium,
    ).toBe(true);
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/133.0').chromium).toBe(false);
  });
});

describe('supportsShareTarget', () => {
  it('needs Android, Chromium and an installed app', () => {
    expect(supportsShareTarget(platform({}))).toBe(true);
    expect(supportsShareTarget(platform({ standalone: false }))).toBe(false);
    expect(supportsShareTarget(platform({ chromium: false }))).toBe(false);
    expect(supportsShareTarget(platform({ os: 'ios', preset: 'iphone', chromium: true }))).toBe(false);
  });
});

describe('parseHeaders', () => {
  it('parses one Name: value per line', () => {
    expect(parseHeaders('Authorization: Bearer abc\nX-Trace: 1')).toEqual({
      Authorization: 'Bearer abc',
      'X-Trace': '1',
    });
  });

  it('keeps colons inside the value', () => {
    expect(parseHeaders('Authorization: Basic dXNlcjpwYXNz')).toEqual({
      Authorization: 'Basic dXNlcjpwYXNz',
    });
  });

  it('ignores blank lines, comments and junk', () => {
    expect(parseHeaders('\n# a note\nnonsense\n\n')).toBeUndefined();
    expect(parseHeaders(': novalue')).toBeUndefined();
  });

  it('returns undefined when nothing was pasted', () => {
    expect(parseHeaders('   ')).toBeUndefined();
  });
});

describe('withScheme', () => {
  it('adds https when the scheme is missing', () => {
    expect(withScheme('example.com/a')).toBe('https://example.com/a');
    expect(withScheme('  HTTP://example.com  ')).toBe('HTTP://example.com');
  });
});

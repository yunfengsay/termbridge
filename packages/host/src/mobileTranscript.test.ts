import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMobileTranscriptPatch,
  parseMobileTranscript,
  type MobileTranscriptLine,
} from './mobileTranscript.js';

function plain(text: string): MobileTranscriptLine {
  return { spans: text ? [{ text }] : [] };
}

test('mobile transcript preserves bounded ANSI styles as structured spans', () => {
  const lines = parseMobileTranscript('\x1b[32mgreen\x1b[0m plain\n\x1b[38;2;10;20;30mtruecolor\x1b[0m');

  assert.deepEqual(lines, [
    { spans: [{ text: 'green', style: 'color:#91C39A' }, { text: ' plain' }] },
    { spans: [{ text: 'truecolor', style: 'color:#0a141e' }] },
  ]);
});

test('mobile transcript preserves safe OSC 8 hyperlink targets', () => {
  const lines = parseMobileTranscript(
    'Read \x1b]8;;https://example.com/docs\x07the docs\x1b]8;;\x07 now',
  );

  assert.deepEqual(lines, [{ spans: [
    { text: 'Read ' },
    { text: 'the docs', href: 'https://example.com/docs' },
    { text: ' now' },
  ] }]);
});

test('mobile transcript preserves OSC 8 file:// links across wrapped lines without polluting href', () => {
  const lines = parseMobileTranscript(
    'Open \x1b]8;;file:///repo/apps/android-host/AndroidManifest.xml\x07apps/android-\nhost/AndroidManifest.xml\x1b]8;;\x07 ok',
  );

  assert.deepEqual(lines, [
    { spans: [
      { text: 'Open ' },
      { text: 'apps/android-', file: '/repo/apps/android-host/AndroidManifest.xml' },
    ] },
    { spans: [
      { text: 'host/AndroidManifest.xml', file: '/repo/apps/android-host/AndroidManifest.xml' },
      { text: ' ok' },
    ] },
  ]);
});

test('mobile transcript restores label links from the original Agent transcript', () => {
  const href = 'https://help.figma.com/hc/en-us/articles/1500007537281-Guide-to-the-Figma-mobile-app';
  const lines = parseMobileTranscript(
    '\x1b[4m\x1b[36mFigma Mobile 官方指南\x1b[0m',
    [{ text: 'Figma Mobile 官方指南', href }],
  );

  assert.deepEqual(lines, [{ spans: [{
    text: 'Figma Mobile 官方指南',
    style: 'color:#76C7C0;text-decoration:underline',
    href,
  }] }]);
});

test('mobile transcript recognizes bare http links without swallowing punctuation', () => {
  const lines = parseMobileTranscript('See https://example.com/docs, then continue.');

  assert.deepEqual(lines, [{ spans: [
    { text: 'See ' },
    { text: 'https://example.com/docs', href: 'https://example.com/docs' },
    { text: ', then continue.' },
  ] }]);
});

test('mobile transcript patch retains the sliding window instead of replacing it', () => {
  const previous = ['a', 'b', 'c', 'working'].map(plain);
  const next = ['b', 'c', 'working', 'done'].map(plain);

  assert.deepEqual(createMobileTranscriptPatch(previous, next), {
    oldStart: 1,
    newStart: 0,
    retainCount: 3,
    before: [],
    after: [plain('done')],
  });
});

test('mobile transcript patch replaces only a mutable status tail', () => {
  const previous = ['a', 'b', 'working 10%'].map(plain);
  const next = ['a', 'b', 'working 20%'].map(plain);

  assert.deepEqual(createMobileTranscriptPatch(previous, next), {
    oldStart: 0,
    newStart: 0,
    retainCount: 2,
    before: [],
    after: [plain('working 20%')],
  });
});

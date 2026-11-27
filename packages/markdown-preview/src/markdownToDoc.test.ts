import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSET_SCHEME_PREFIX,
  extractFrontmatter,
  markdownToTiptapDocument,
  rewriteImageSrc,
  sanitizeLinkHref,
} from './markdownToDoc.js';
import { readShellMessage } from './bridge.js';

test('rewriteImageSrc rewrites local, relative, and file URLs to tb-md-asset while blocking unsafe schemes', () => {
  assert.equal(
    rewriteImageSrc('/Users/alice/.gemini/brain/shot.png'),
    `${ASSET_SCHEME_PREFIX}${encodeURIComponent('/Users/alice/.gemini/brain/shot.png')}`,
  );
  assert.equal(
    rewriteImageSrc('./images/arch diagram.png'),
    `${ASSET_SCHEME_PREFIX}${encodeURIComponent('./images/arch diagram.png')}`,
  );
  assert.equal(
    rewriteImageSrc('file:///Users/alice/My%20Shot.png'),
    `${ASSET_SCHEME_PREFIX}${encodeURIComponent('/Users/alice/My Shot.png')}`,
  );
  assert.equal(rewriteImageSrc('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(rewriteImageSrc('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(rewriteImageSrc('javascript:alert(1)'), undefined);
  assert.equal(rewriteImageSrc('data:text/html,<script>alert(1)</script>'), undefined);
  assert.equal(rewriteImageSrc('http://insecure.example/x.png'), undefined);
  assert.equal(rewriteImageSrc('//protocol-relative.example/x.png'), undefined);
});

test('sanitizeLinkHref allows anchors, web URLs, and file links while blocking dangerous schemes', () => {
  assert.equal(sanitizeLinkHref('#section-1'), '#section-1');
  assert.equal(sanitizeLinkHref('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(sanitizeLinkHref('file:///Users/alice/app.swift#L12-L24'), 'file:///Users/alice/app.swift#L12-L24');
  assert.equal(sanitizeLinkHref('./README.md:42'), './README.md:42');
  assert.equal(sanitizeLinkHref('javascript:alert(1)'), undefined);
  assert.equal(sanitizeLinkHref('vbscript:msgbox(1)'), undefined);
  assert.equal(sanitizeLinkHref('data:text/html,hi'), undefined);
  assert.equal(sanitizeLinkHref('ssh://host/etc/passwd'), undefined);
});

test('extractFrontmatter parses YAML key-value frontmatter without touching horizontal rules', () => {
  const md = [
    '---',
    'title: "Living Spec"',
    'status: Active',
    'tags: [canvas, tiptap]',
    '---',
    '',
    '# Heading',
  ].join('\n');
  const { entries, body } = extractFrontmatter(md);
  assert.deepEqual(entries, [
    { key: 'title', value: 'Living Spec' },
    { key: 'status', value: 'Active' },
    { key: 'tags', value: 'canvas, tiptap' },
  ]);
  assert.equal(body, '# Heading');

  const noFm = '# Heading\n\n---\n\nParagraph';
  assert.deepEqual(extractFrontmatter(noFm).entries, []);
});

test('markdownToTiptapDocument builds structured headings, GFM alerts, tables, task lists, figures, and carousels', () => {
  const source = [
    '# 标题 One',
    '',
    '> [!IMPORTANT]',
    '> Keep **secrets** on the Host.',
    '',
    '- [x] Done item',
    '- [ ] Pending item',
    '',
    '| Name | Count |',
    '| :--- | ---: |',
    '| Alpha | 42 |',
    '',
    '![Standalone shot](/Users/alice/demo.png)',
    '',
    '````carousel',
    '![Slide A](/Users/alice/a.png)',
    '<!-- slide -->',
    '```swift',
    'let x = 1',
    '```',
    '````',
    '',
    '<script>alert(1)</script>',
  ].join('\n');

  const { doc, stats } = markdownToTiptapDocument(source);
  assert.equal(doc.type, 'doc');
  assert.equal(stats.headingCount, 1);
  assert.equal(stats.imageCount, 2);
  assert.equal(stats.carouselCount, 1);

  const types = (doc.content ?? []).map((n) => n.type);
  assert.deepEqual(types, ['heading', 'callout', 'taskList', 'table', 'figureImage', 'carousel', 'paragraph']);

  const callout = doc.content![1]!;
  assert.equal(callout.attrs?.kind, 'important');

  const taskList = doc.content![2]!;
  assert.equal(taskList.content?.[0]?.attrs?.checked, true);
  assert.equal(taskList.content?.[1]?.attrs?.checked, false);

  const table = doc.content![3]!;
  assert.equal(table.content?.[0]?.content?.[1]?.attrs?.align, 'right');

  const figure = doc.content![4]!;
  assert.equal(figure.attrs?.alt, 'Standalone shot');
  assert.equal(figure.attrs?.src, `${ASSET_SCHEME_PREFIX}${encodeURIComponent('/Users/alice/demo.png')}`);

  const carousel = doc.content![5]!;
  const slides = carousel.attrs?.slides as Array<{ image?: { alt: string }; blocks: Array<{ type: string }> }>;
  assert.equal(slides.length, 2);
  assert.equal(slides[0]?.image?.alt, 'Slide A');
  assert.equal(slides[1]?.image, undefined);
  assert.equal(slides[1]?.blocks[0]?.type, 'codeBlock');

  // Raw script tag stays literal text, never HTML.
  const trailing = doc.content![6]!;
  assert.equal(trailing.content?.[0]?.text, '<script>alert(1)</script>');
});

test('markdownToTiptapDocument handles empty input safely for ProseMirror doc+ constraint', () => {
  const { doc } = markdownToTiptapDocument('   \n\n  ');
  assert.deepEqual(doc, { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('readShellMessage validates commands cleanly', () => {
  assert.deepEqual(readShellMessage({ op: 'render', markdown: '# Hi', theme: 'dark' }), {
    op: 'render',
    markdown: '# Hi',
    theme: 'dark',
  });
  assert.deepEqual(readShellMessage({ op: 'find', query: 'abc', caseSensitive: true }), {
    op: 'find',
    query: 'abc',
    caseSensitive: true,
  });
  assert.equal(readShellMessage({ op: 'render', markdown: 123 }), undefined);
  assert.equal(readShellMessage({ op: 'unknown' }), undefined);
});

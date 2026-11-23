import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenableHref, parseMarkdown } from './markdown.js';

test('Markdown artifact paths survive parsing while unsafe schemes remain inert', () => {
  for (const href of ['docs/report.md', '/project/a.png', './src/a.ts:12', 'https://example.com/a.png']) {
    assert.ok(isOpenableHref(href), href);
    assert.match(JSON.stringify(parseMarkdown(`[View](${href})`)), /"type":"link"/);
  }
  for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'content://photos/1', 'data:image/png,xxx', '//evil.test/a.png', 'https://user:secret@example.com/a', '/x\u0000.png']) {
    assert.equal(isOpenableHref(href), false, href);
  }
  assert.match(JSON.stringify(parseMarkdown('![Preview](docs/result.png)')), /docs\/result.png/);
});

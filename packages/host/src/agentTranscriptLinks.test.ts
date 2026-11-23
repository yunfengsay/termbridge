import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractMarkdownHttpLinks, resolveLocalAgentTranscriptLinks } from './agentTranscriptLinks.js';
import { parseMobileTranscript } from './mobileTranscript.js';

test('extractMarkdownHttpLinks keeps labels and only safe web targets', () => {
  assert.deepEqual(extractMarkdownHttpLinks(
    '[Figma guide](https://help.figma.com/guide) ' +
    '[local file](file:///tmp/private) ' +
    '[script](javascript:alert(1))',
  ), [{ text: 'Figma guide', href: 'https://help.figma.com/guide' }]);
});

test('extractMarkdownHttpLinks deduplicates repeated rendered messages', () => {
  assert.deepEqual(extractMarkdownHttpLinks(
    '[Docs](https://example.com/docs) and [Docs](https://example.com/docs)',
  ), [{ text: 'Docs', href: 'https://example.com/docs' }]);
});

test('Herdr path references restore a rendered label using the record identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-link-path-'));
  try {
    const path = join(home, 'record.jsonl');
    const id = '11111111-1111-4111-8111-111111111111';
    const href = 'https://example.com/downloads';
    const record = (target: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: `[余页 Folio 官网与下载页](${target})` }] } }),
    ].join('\n') + '\n';
    await writeFile(path, record(href));
    const identity = { agent: 'codex', agentSessionId: path, agentSessionRef: { kind: 'path', value: path } };
    const links = await resolveLocalAgentTranscriptLinks(identity);
    assert.deepEqual(links, [{ text: '余页 Folio 官网与下载页', href }]);
    const spans = parseMobileTranscript('\x1b[34;4m余页 Folio 官网与下载页\x1b[0m', links)[0].spans;
    assert.equal(spans[0].href, href);
    assert.deepEqual(await resolveLocalAgentTranscriptLinks({ ...identity, agentSessionId: '22222222-2222-4222-8222-222222222222' }), []);
    // A replaced record at the same path must not keep the previous URL.
    await writeFile(path, record('https://example.com/new-place'));
    assert.equal((await resolveLocalAgentTranscriptLinks(identity))[0].href, 'https://example.com/new-place');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('record decoding accepts JSON whitespace and visible assistant messages, excluding tools and reasoning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-link-records-'));
  try {
    const path = join(home, 'record.jsonl');
    await writeFile(path, [
      '{ "type": "session_meta", "payload": { "id": "33333333-3333-4333-8333-333333333333" } }',
      '{ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "[Docs](https://example.com/docs)" }] } }',
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Latest](https://example.com/latest)' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: '[Internal](https://example.com/internal)' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: '[Tool](https://example.com/tool)' } }),
    ].join('\n') + '\n');
    const links = await resolveLocalAgentTranscriptLinks({ agent: 'codex', agentSessionId: path, agentSessionRef: { kind: 'path', value: path } });
    assert.deepEqual(links, [{ text: 'Latest', href: 'https://example.com/latest' }, { text: 'Docs', href: 'https://example.com/docs' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('ID lookup verifies record contents instead of trusting a matching filename', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-link-id-'));
  try {
    const id = '44444444-4444-4444-8444-444444444444';
    const dir = join(home, '.codex', 'sessions', '2026', '10', '09');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-${id}.jsonl`);
    const records = (claimed: string) => [
      JSON.stringify({ type: 'session_meta', payload: { id: claimed } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[Docs](https://example.com/docs)' }] } }),
    ].join('\n') + '\n';
    const identity = { agent: 'codex', agentSessionId: id };
    await writeFile(path, records('55555555-5555-4555-8555-555555555555'));
    assert.deepEqual(await resolveLocalAgentTranscriptLinks(identity, { home }), []);
    await writeFile(path, records(id));
    assert.deepEqual(await resolveLocalAgentTranscriptLinks(identity, { home }), [{ text: 'Docs', href: 'https://example.com/docs' }]);
    await writeFile(path, records('55555555-5555-4555-8555-555555555555'));
    assert.deepEqual(await resolveLocalAgentTranscriptLinks(identity, { home }), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('existing Claude records use the shared decoder without launching an Agent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-link-claude-'));
  try {
    const path = join(home, 'record.jsonl');
    const identity = { agentSessionRef: { agent: 'claude', kind: 'path', value: path } };
    assert.deepEqual(await resolveLocalAgentTranscriptLinks(identity), []);
    await writeFile(path, JSON.stringify({ type: 'assistant', sessionId: '66666666-6666-4666-8666-666666666666',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '[Hidden](https://example.com/hidden)' },
        { type: 'text', text: '[Docs](https://example.com/docs)' }] } }) + '\n');
    assert.deepEqual(await resolveLocalAgentTranscriptLinks(identity), [{ text: 'Docs', href: 'https://example.com/docs' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

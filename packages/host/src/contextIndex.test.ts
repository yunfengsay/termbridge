import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContextIndex } from './contextIndex.js';

describe('AgentContextIndex', () => {
  it('prioritizes working, recent, and semantically relevant Agent context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-context-'));
    try {
      const path = join(dir, 'context.json');
      const now = 1_700_000_000_000;
      const index = new AgentContextIndex(path);
      index.observe([
        {
          sessionId: 'herdr:w1:p1', source: 'herdr', workspace: 'termbridge', command: 'codex',
          name: 'TermBridge', agent: 'codex', status: 'working', preview: 'Implementing context search',
          context: 'The implementation source mentions 语音, voice and TTS aliases.',
        },
        {
          sessionId: 'herdr:w2:p2', source: 'herdr', workspace: 'my-small-phone', command: 'voice_ux_refactor',
          agent: 'voice_ux_refactor', status: 'idle', preview: 'Voice playback and TTS controls completed',
          context: 'Finished the voice UX refactor and verified speech playback.',
        },
      ], now);

      assert.equal(index.ranked('为什么没有语音了？', now)[0].sessionId, 'herdr:w2:p2');
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[] };
      assert.equal(stored.records.length, 2);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(index.getSnapshot().records[0].name, 'TermBridge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps completed summaries after a pane disappears and injects all current Agents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-context-'));
    try {
      const index = new AgentContextIndex(join(dir, 'context.json'));
      index.observe([
        {
          sessionId: 'herdr:w1:p1', source: 'herdr', workspace: 'alpha', command: 'codex',
          agent: 'codex', status: 'working', preview: 'Still working',
        },
        {
          sessionId: 'herdr:w2:p1', source: 'herdr', workspace: 'beta', command: 'claude',
          agent: 'claude', status: 'done', preview: 'Finished the release',
        },
      ], 1_000);
      index.observe([
        {
          sessionId: 'herdr:w1:p1', source: 'herdr', workspace: 'alpha', command: 'codex',
          agent: 'codex', status: 'done', preview: 'Implemented and tested the fix',
        },
      ], 2_000);

      const historical = index.ranked('', 2_000, true);
      assert.equal(historical.find((record) => record.sessionId === 'herdr:w2:p1')?.present, false);
      assert.equal(historical.find((record) => record.sessionId === 'herdr:w1:p1')?.completedAt, 2_000);

      const prompt = index.buildPromptContext({
        currentRequest: '刚才完成了什么？',
        clientPlatform: 'android',
        messages: [{ role: 'user', text: '继续', createdAt: 1_900 }],
        tasks: [{ agent: 'codex', status: 'completed', text: '修复功能', updatedAt: 2_000 }],
        now: 2_000,
        timeZone: 'Asia/Shanghai',
      });
      assert.match(prompt, /Current TB roster: 1 sessions/);
      assert.match(prompt, /Host snapshot time: 1970-01-01T00:00:02\.000Z/);
      assert.match(prompt, /Host local time: 1970-01-01T08:00:02\+08:00; time zone: Asia\/Shanghai/);
      assert.match(prompt, /Implemented and tested the fix/);
      assert.match(prompt, /tb context search/);
      assert.match(prompt, /Client platform: android/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects a semantic task referent without inventing client-local playback state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-context-'));
    try {
      const index = new AgentContextIndex(join(dir, 'context.json'));
      index.observe([
        {
          sessionId: 'herdr:w7:p2', source: 'herdr', workspace: 'my-small-phone',
          command: 'voice_ux_refactor', agent: 'voice_ux_refactor', status: 'idle',
          preview: 'Finished Android TTS and voice controls',
        },
      ], 2_000);
      const prompt = index.buildPromptContext({
        currentRequest: '为什么没有语音了？',
        clientPlatform: 'android',
        messages: [],
        tasks: [{ agent: 'codex', status: 'failed', text: '为什么没有语音了？', updatedAt: 1_900 }],
        now: 2_000,
      });

      assert.match(prompt, /Likely semantic task referent: topic=voice; name=my-small-phone; workspace=my-small-phone; agent=voice_ux_refactor/);
      assert.match(prompt, /not evidence about client-local voice\/TTS settings/);
      assert.match(prompt, /exact local cause is unknown/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps completion events authoritative after the same Agent starts working again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-context-'));
    try {
      const index = new AgentContextIndex(join(dir, 'context.json'));
      index.observe([{
        sessionId: 'herdr:wA:p1', source: 'herdr', workspace: 'termbridge', command: 'codex',
        agent: 'codex', status: 'working', preview: 'Implementing the first task',
        context: 'UNTRUSTED_TERMINAL_DETAIL',
      }], 1_000);
      index.observe([{
        sessionId: 'herdr:wA:p1', source: 'herdr', workspace: 'termbridge', command: 'codex',
        agent: 'codex', status: 'done', preview: 'Echo-loop fix completed and installed',
      }], 2_000);
      for (let tick = 0; tick < 30; tick += 1) {
        index.observe([{
          sessionId: 'herdr:wA:p1', source: 'herdr', workspace: 'termbridge', command: 'codex',
          agent: 'codex', status: 'working', preview: `Working (${tick}s • esc to interrupt)`,
          context: 'UNTRUSTED_TERMINAL_DETAIL',
        }], 3_000 + tick);
      }

      const completion = index.recentCompletions(1)[0];
      assert.equal(completion.sessionId, 'herdr:wA:p1');
      assert.equal(completion.completedAt, 2_000);
      assert.equal(completion.currentStatus, 'working');
      assert.equal(completion.summary, 'Echo-loop fix completed and installed');

      const prompt = index.buildPromptContext({
        currentRequest: 'A live Voice session is starting', messages: [], tasks: [], now: 3_000,
        includeExecutionExcerpts: false,
      });
      assert.match(prompt, /Recent Agent completion events \(newest first, authoritative\)/);
      assert.match(prompt, /currentStatus=working/);
      assert.match(prompt, /Echo-loop fix completed and installed/);
      assert.doesNotMatch(prompt, /UNTRUSTED_TERMINAL_DETAIL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects the latest direct user-to-Agent message ahead of historical Global tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-context-'));
    try {
      const path = join(dir, 'context.json');
      const index = new AgentContextIndex(path);
      index.observe([
        {
          sessionId: 'herdr:wA:p3', source: 'herdr', workspace: 'termbridge', command: 'ios_termbridge',
          agent: 'ios_termbridge', status: 'working', preview: 'Old native dispatch context',
        },
        {
          sessionId: 'herdr:w7:p2', source: 'herdr', workspace: 'my-small-phone', command: 'voice_ux_refactor',
          agent: 'voice_ux_refactor', status: 'idle', preview: 'Ready for another review',
        },
      ], 1_000);

      index.recordUserMessage({
        sessionId: 'herdr:w7:p2',
        text: '继续检查刚才的语音交互方案',
        clientPlatform: 'android',
      }, 3_000);

      const reloaded = new AgentContextIndex(path);
      assert.equal(reloaded.recentUserMessages(1)[0]?.sessionId, 'herdr:w7:p2');
      const prompt = reloaded.buildPromptContext({
        currentRequest: '刚才我给哪个 Agent 发送了消息？',
        clientPlatform: 'android',
        messages: [],
        tasks: [{
          agent: 'codex', status: 'completed',
          text: 'Send to the Agent herdr:wA:p3 and reply exactly NATIVE_DISPATCH_OK.',
          updatedAt: 2_000,
        }],
        now: 4_000,
      });

      assert.match(prompt, /Recent direct user-to-Agent messages \(newest first, authoritative\)/);
      assert.match(prompt, /recipientKind=terminal_agent; contentIsInstructionForGlobal=false/);
      assert.doesNotMatch(prompt, /against the highest-ranked/);
      assert.match(prompt, /session=herdr:w7:p2/);
      assert.match(prompt, /继续检查刚才的语音交互方案/);
      assert.match(prompt, /Do not infer a direct-message target from Global tasks or terminal excerpts/);
      assert.ok(prompt.indexOf('session=herdr:w7:p2') < prompt.indexOf('NATIVE_DISPATCH_OK'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

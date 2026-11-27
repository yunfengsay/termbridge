import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrainCoordinator, MemoryBrainStore } from '@termbridge/brain';
import { BrainMemory } from '../brainMemory.js';
import { WorkspaceFiles } from '../workspaceFiles.js';
import { AgentContextIndex } from '../contextIndex.js';
import { CompletionSupervisor, type CompletionInput } from '../completionSupervisor.js';
import { resolveBrainAgent } from '../config.js';
import { buildConversationHistoryMessages, summarizeForkToolCalls } from './toolHistorySummary.js';
import { createBrainRouter } from './brainRouter.js';
import { readStructuredAgentTranscript } from './agentTranscriptSummary.js';

test('BrainMemory supports structured upsert, search, remove, secret blocking, and query-aware snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-memory-tool-'));
  try {
    const memory = new BrainMemory(join(dir, 'memory.md'));
    memory.ensure();
    const first = memory.upsert({ section: 'Preferences', key: 'default_agent', content: 'Prefer agy for coding tasks' });
    assert.equal(first.ok, true);
    assert.equal(first.updated, false);
    const second = memory.upsert({ section: 'Preferences', key: 'default_agent', content: 'Prefer agy with proxy' });
    assert.equal(second.updated, true);
    memory.upsert({ section: 'Projects', key: 'termbridge', content: 'Primary workspace is termbridge-oss' });

    const hits = memory.search('proxy');
    assert.equal(hits.total, 1);
    assert.equal(hits.matches[0]?.section, 'Preferences');

    assert.throws(
      () => memory.upsert({ section: 'Secrets', content: 'api_key=sk-1234567890abcdefghij' }),
      /secret|key|token/i,
    );

    const removed = memory.remove({ section: 'Preferences', query: 'proxy' });
    assert.equal(removed.removedCount, 1);
    assert.equal(memory.search('proxy').total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkspaceFiles supports ranged line reads, bounded code search, and read-only git inspection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-wsfiles-'));
  try {
    const repo = join(dir, 'demo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), ['line1', 'const targetSymbol = 42;', 'line3', 'line4'].join('\n'));
    writeFileSync(join(repo, '.env'), 'SECRET=targetSymbol');
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/app.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'src', 'app.ts'), ['line1', 'const targetSymbol = 99;', 'line3', 'line4'].join('\n'));

    const files = new WorkspaceFiles(dir, join(dir, 'memory.md'));
    const ranged = await files.execute('read', 'demo/src/app.ts', { startLine: 2, endLine: 3 });
    assert.equal(ranged.text, 'const targetSymbol = 99;\nline3');
    assert.equal(ranged.totalLines, 4);

    const search = await files.execute('search', 'demo', { query: 'targetSymbol' }) as {
      count: number; matches: Array<{ path: string; line: number }>;
    };
    assert.equal(search.count, 1, 'sensitive .env must be excluded from search');
    assert.equal(search.matches[0]?.path, 'demo/src/app.ts');
    assert.equal(search.matches[0]?.line, 2);

    const status = await files.execute('git_status', 'demo') as { text: string };
    assert.match(status.text, /src\/app\.ts/);
    assert.doesNotMatch(status.text, /\.env/);

    const diff = await files.execute('git_diff', 'demo') as { text: string };
    assert.match(diff.text, /targetSymbol = 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AgentContextIndex preserves [Current user request] when clipping oversized context and coalesces async writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-ctx-clip-'));
  try {
    const file = join(dir, 'context.json');
    const index = new AgentContextIndex(file, { debounceMs: 25 });
    const records = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `herdr:w${i}:p1`, source: 'herdr' as const, name: `Project-${i}`,
      workspace: `workspace-${i}`, command: 'codex', agent: 'codex', status: 'working',
      preview: 'x'.repeat(500),
    }));
    index.observe(records, 1000);
    index.observe(records, 1001); // identical signature -> dirty-check skips redundant write
    await index.flush();

    const stored = JSON.parse(readFileSync(file, 'utf8')) as { records: unknown[] };
    assert.equal(stored.records.length, 40);

    const prompt = index.buildPromptContext({
      currentRequest: 'UNIQUE_TAIL_MARKER_REQUEST',
      messages: [],
      tasks: [],
      now: 1001,
    });
    assert.match(prompt, /UNIQUE_TAIL_MARKER_REQUEST/);
    assert.match(prompt, /\[Context clipped to the host prompt budget\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CompletionSupervisor circuit-breaks repeated judge outages and uses fallbackJudge when provided', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-sup-cb-'));
  try {
    const makeInput = (at: number): CompletionInput => ({
      event: {
        sessionId: 'herdr:a1', source: 'herdr', name: 'A1', command: 'agy',
        workspace: 'proj', completedAt: at, currentStatus: 'done', summary: 'Done',
      },
      goal: 'Ship fix', revision: 1, conversationId: 'conv-1', candidates: [],
    });

    // 1. Without fallback: trips circuit after 2 failures and silently skips the 3rd without calling judge or publish.
    let judgeCalls = 0;
    const published: Array<{ status: string; degraded?: boolean }> = [];
    const sup = new CompletionSupervisor(join(dir, 'cb.json'), {
      judge: async () => { judgeCalls += 1; throw new Error('Jev unreachable'); },
      review: async () => '',
      current: () => ({ status: 'done', revision: 1, completedAt: 1000 }),
      handoff: async () => ({ ok: true }),
      publish: (r) => { published.push({ status: r.status, degraded: r.judgeDegraded }); },
    }, { circuitBreakerThreshold: 2, circuitCooldownMs: 60_000 });

    await sup.observe(makeInput(1000));
    await sup.observe(makeInput(2000));
    assert.equal(sup.isJudgeCircuitOpen(), true);
    const publishedBeforeThird = published.length;
    await sup.observe(makeInput(3000));
    assert.equal(judgeCalls, 2, 'circuit breaker must skip judge calls while open');
    assert.equal(published.length, publishedBeforeThird, 'circuit-open skip must not publish spam cards');

    // 2. With fallbackJudge: transparently recovers when primary judge fails.
    let fallbackCalls = 0;
    const supFallback = new CompletionSupervisor(join(dir, 'fb.json'), {
      judge: async () => { throw new Error('Jev down'); },
      fallbackJudge: async () => {
        fallbackCalls += 1;
        return { next: 'notify', confidence: 0.92, presentation: 'compact' };
      },
      review: async () => '',
      current: () => ({ status: 'done', revision: 1, completedAt: 4000 }),
      handoff: async () => ({ ok: true }),
      publish: () => {},
    });
    await supFallback.observe(makeInput(4000));
    assert.equal(fallbackCalls, 1);
    assert.equal(supFallback.list()[0]?.status, 'ready');
    assert.equal(supFallback.list()[0]?.judgeDegraded, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBrainAgent supports agy non-interactive print mode alongside codex and claude', () => {
  const resolved = resolveBrainAgent(
    { shell: '/bin/zsh', agents: { agy: 'proxy && agy --dangerously-skip-permissions', codex: 'codex', claude: 'claude' } },
    'agy',
    'Inspect build',
    '/tmp/result.md',
  );
  assert.ok(resolved);
  assert.match(resolved.args[1] ?? '', /agy --dangerously-skip-permissions -p "\$TB_BRAIN_PROMPT"/);
  assert.equal(resolved.env.TB_BRAIN_RESULT, '/tmp/result.md');
});

test('toolHistorySummary retains recent turn tool evidence for multi-turn Pi continuity', () => {
  const summary = summarizeForkToolCalls([{
    call: { name: 'workspace_files', arguments: { action: 'search', path: 'termbridge-oss', query: 'brain_send' } },
    output: JSON.stringify({ ok: true, action: 'search', path: 'termbridge-oss', query: 'brain_send', count: 1, matches: [{ path: 'packages/host/src/brain/brainRouter.ts', line: 100 }] }),
  }]);
  assert.match(summary ?? '', /brainRouter\.ts:100/);

  const history = buildConversationHistoryMessages(
    [
      { id: 'req-1', role: 'user', text: '搜一下 brain_send', createdAt: 100 },
      { id: 'req-1-brain', role: 'brain', text: '在 brainRouter.ts 第 100 行。', createdAt: 101 },
    ],
    [],
    '把它展开看看',
    new Map([['req-1', summary!]]),
  );
  assert.equal(history[1]?.role, 'assistant');
  assert.match(history[1]?.toolSummary ?? '', /brainRouter\.ts:100/);
});

test('brainRouter streams brain_text_delta and persists standard-mode failure onto timeline', async () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const deltas: Array<{ delta: string; text: string; final?: boolean }> = [];
  const errors: string[] = [];
  const router = createBrainRouter({
    brain,
    brainConversation: { provider: 'bailian', model: 'deepseek-v4.1-flash', runtime: 'pi', respond: async () => ({ text: '', provider: 'bailian', model: 'deepseek-v4.1-flash', toolCalls: [] }) },
    completionSupervisor: undefined,
    silentExecutions: { start: () => new AbortController().signal, cancel: () => false, finish: () => {} } as never,
    inFlightBrainRequests: new Set(),
    brainRequestWaiters: new Map(),
    maxConcurrentBrainRequests: 2,
    maxBrainTextChars: 16_000,
    hasActiveRealtimeConversations: () => false,
    consumeBrainQuota: () => true,
    closeRealtimeVoiceForClient: () => {},
    rotateBrainConversationScope: () => {},
    sendBrainSnapshot: () => {},
    broadcastBrainSnapshot: () => {},
    sendBrainAccepted: () => {},
    addBrainWaiter: () => {},
    sendBackgroundReply: () => {},
    sendBrainError: (_req, msg) => errors.push(msg),
    broadcastTextDelta: (_req, delta, text, final) => deltas.push({ delta, text, final }),
    listPeerAndWaiterClientIds: () => [],
    sendToClient: () => {},
    runGlobalExecutionFork: async (input) => {
      if (input.requestId === 'req-fail') throw new Error('provider 502');
      input.onTextDelta?.('你好', '你好');
      input.onTextDelta?.('世界', '你好世界');
    },
  });

  await router.handle(1, { t: 'brain_send', requestId: 'req-ok', text: 'hi' });
  assert.equal(deltas.at(-1)?.text, '你好世界');
  assert.equal(deltas.at(-1)?.final, true);

  await router.handle(1, { t: 'brain_send', requestId: 'req-fail', text: 'fail me' });
  assert.equal(errors[0], 'provider 502');
  assert.match(brain.findConversationMessage('req-fail-brain')?.text ?? '', /执行失败：provider 502/);
});

test('readStructuredAgentTranscript returns clean recent turns for a verified Claude transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-transcript-'));
  try {
    const sid = '11111111-2222-3333-4444-555555555555';
    const file = join(home, 'session.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: sid, uuid: 'u1', message: { role: 'user', content: '检查构建状态' } }),
      JSON.stringify({ type: 'assistant', sessionId: sid, uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '构建已全部通过。' }] } }),
    ].join('\n') + '\n');

    const transcript = await readStructuredAgentTranscript({
      agent: 'claude',
      providerSessionId: sid,
      sessionRef: { kind: 'path', value: file },
      home,
    });
    assert.equal(transcript?.provider, 'claude');
    assert.equal(transcript?.recentTurns.length, 2);
    assert.equal(transcript?.recentTurns[1]?.text, '构建已全部通过。');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

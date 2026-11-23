import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HerdrScrollback } from './herdrScrollback.js';

describe('compatible terminal scroll lifecycle', () => {
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  const history = Array.from({ length: 100 }, (_, n) => `ROW_${n + 1}`).join('\n');

  it('coalesces a pending gesture, caches history, clamps boundaries and resumes live output', async () => {
    const pending = deferred<string>(), frames: string[] = [];
    let reads = 0;
    const viewer = new HerdrScrollback({ rows: () => 5,
      readHistory: async limit => { reads++; assert.equal(limit, 2000); return pending.promise; },
      readLive: async () => Buffer.from('LIVE'), output: data => frames.push(data.toString()), error: () => assert.fail('read error'),
    });
    viewer.scroll('up', 3); viewer.scroll('up', 4); viewer.scroll('down', 2);
    pending.resolve(history); await tick();
    assert.equal(reads, 1); assert.equal(frames.length, 1);
    assert.match(frames[0]!, /ROW_91\r\n/); assert.match(frames[0]!, /ROW_95$/);
    viewer.scroll('up', 100); await tick();
    assert.match(frames.at(-1)!, /ROW_1\r\n/); assert.match(frames.at(-1)!, /ROW_5$/);
    assert.equal(reads, 1, 'a frozen reading position must not trigger more API reads');
    viewer.scroll('down', 100); await tick();
    assert.equal(viewer.active, false); assert.equal(frames.at(-1), 'LIVE');
    viewer.close();
  });

  for (const action of ['close', 'resume'] as const) {
    it(`discards a history reply after ${action}`, async () => {
      const pending = deferred<string>(), frames: string[] = [];
      const viewer = new HerdrScrollback({ rows: () => 5, readHistory: () => pending.promise,
        readLive: async () => Buffer.from('LIVE'), output: data => frames.push(data.toString()), error: () => assert.fail('stale error'),
      });
      viewer.scroll('up', 3); viewer[action](); pending.resolve(history); await tick();
      assert.deepEqual(frames, action === 'close' ? [] : ['LIVE']);
      viewer.close();
    });
  }

  it('does not deliver an older live read over a newer scroll gesture', async () => {
    const pending = deferred<Buffer>(), frames: string[] = [];
    const viewer = new HerdrScrollback({ rows: () => 5, readHistory: async () => history,
      readLive: () => pending.promise, output: data => frames.push(data.toString()), error: () => assert.fail('read error'),
    });
    viewer.scroll('up', 3); await tick();
    viewer.scroll('down', 3); viewer.scroll('up', 2);
    pending.resolve(Buffer.from('STALE_LIVE')); await tick();
    assert.equal(frames.some(frame => frame === 'STALE_LIVE'), false);
    assert.match(frames.at(-1)!, /ROW_98$/);
    viewer.close();
  });

  it('bounds failed reads and allows an explicit retry without closing the session', async () => {
    let reads = 0, errors = 0;
    const frames: string[] = [];
    const viewer = new HerdrScrollback({ rows: () => 5,
      readHistory: async () => ++reads === 1 ? 'x'.repeat(1024 * 1024 + 1) : history,
      readLive: async () => Buffer.from('LIVE'), output: data => frames.push(data.toString()), error: () => { errors++; },
    });
    viewer.scroll('up', 3); await tick();
    assert.equal(errors, 1); assert.equal(viewer.active, false); assert.equal(frames.length, 0);
    viewer.scroll('up', 3); await tick();
    assert.equal(reads, 2); assert.match(frames.at(-1)!, /ROW_97$/);
    viewer.close();
  });
});
import {
  decodeTerminalInput,
  extractPanePreview,
  HerdrBridge,
  pasteAndSubmit,
  renderMobilePaneText,
  TerminalInputDecoder,
} from './herdr.js';

describe('HerdrBridge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'termbridge-herdr-'));
  const socketPath = join(dir, 'herdr.sock');
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  let agentStatus = 'idle';
  let paneText = '• 已完成。\n\n  这是最后一句回复。\n\n─ Worked for 1m ─';
  let paneRevision = 7;
  let rejectEventWait = false;
  let alternateScreenRows: number | undefined;
  let historyScrolls = 0;
  let historyText: string | undefined;
  let snapshotProtocol = 19;
  let agentSession = { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 'codex-session-1234567890' };
  const server = net.createServer((connection) => {
    let input = '';
    connection.on('data', (chunk) => {
      input += chunk.toString('utf8');
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as (typeof requests)[number];
      requests.push(request);
      // Herdr can recover missing alt-screen history by scrolling the running
      // application and restoring its position. This is not a passive read.
      if (request.method === 'pane.read' && alternateScreenRows !== undefined &&
          request.params.source !== 'visible' &&
          Number(request.params.lines) > alternateScreenRows) {
        historyScrolls++;
        paneRevision++;
      }
      if (request.method === 'events.wait' && rejectEventWait) {
        connection.end(JSON.stringify({
          id: request.id,
          error: { code: 'unsupported_event_wait_match', message: 'unsupported_event_wait_match' },
        }) + '\n');
        return;
      }
      const result = request.method === 'session.snapshot'
        ? {
            type: 'session_snapshot',
            snapshot: {
              version: '0.8.0',
              protocol: snapshotProtocol,
              workspaces: [{ workspace_id: 'w1', label: 'project' }],
              tabs: [],
              layouts: [{ panes: [{ pane_id: 'w1:p1', rect: { width: 120, height: 40 } }] }],
              panes: [{
                pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term-1',
                terminal_title_stripped: 'project shell', agent: 'codex', agent_status: agentStatus, revision: 7,
                cwd: '/code/project', foreground_cwd: '/code/project/packages/app',
              }],
              agents: [{
                pane_id: 'w1:p1', name: 'builder', agent: 'codex', agent_status: agentStatus,
                agent_session: agentSession,
              }],
            },
          }
        : request.method === 'pane.read'
          ? {
              type: 'pane_read',
              read: {
                text: request.params.source === 'recent' && historyText !== undefined
                  ? historyText.split('\n').slice(-Number(request.params.lines)).join('\n') : paneText,
                revision: paneRevision,
              },
            }
          : { type: 'ok' };
      connection.end(JSON.stringify({ id: request.id, result }) + '\n');
    });
  });

  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers and maps every pane from the Herdr snapshot', async () => {
    agentStatus = 'idle';
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    const sessions = await bridge.refresh();

    assert.equal(sessions.length, 1);
    assert.deepEqual(
      {
        id: sessions[0].id,
        paneId: sessions[0].paneId,
        name: sessions[0].name,
        workspace: sessions[0].workspace,
        agent: sessions[0].agent,
        agentSessionId: sessions[0].agentSessionId,
        cwd: sessions[0].cwd,
        command: sessions[0].command,
        status: sessions[0].status,
        cols: sessions[0].cols,
        rows: sessions[0].rows,
      },
      {
        id: 'herdr:w1:p1',
        paneId: 'w1:p1',
        name: 'builder',
        workspace: 'project',
        agent: 'codex',
        agentSessionId: 'codex-session-1234567890',
        cwd: '/code/project/packages/app',
        command: 'project · builder',
        status: 'idle',
        cols: 120,
        rows: 40,
      },
    );
  });

  it('lists panes for every checked Herdr protocol and rejects a newer one', async () => {
    try {
      for (const protocol of [19, 22]) {
        snapshotProtocol = protocol;
        const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
        assert.deepEqual((await bridge.refresh()).map(session => session.id), ['herdr:w1:p1']);
      }
      snapshotProtocol = 23;
      const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
      await assert.rejects(bridge.refresh(), /Herdr protocol 23 is not supported \(supported 19-22\)/);
    } finally {
      snapshotProtocol = 19;
    }
  });

  it('keeps the live session object when refreshing an attached pane', async () => {
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    const attached = (await bridge.refresh())[0];
    attached.viewers.push({ clientId: 9, sid: 4, presentation: 'mobile' });
    attached.watching = true;

    const refreshed = (await bridge.refresh())[0];

    assert.equal(refreshed, attached);
    assert.deepEqual(refreshed.viewers, [{ clientId: 9, sid: 4, presentation: 'mobile' }]);
    assert.equal(refreshed.watching, true);
  });

  it('keeps polling an attached pane after a session-list refresh', async () => {
    rejectEventWait = true;
    paneText = 'first screen';
    paneRevision = 7;
    let resolveUpdate: (() => void) | undefined;
    const update = new Promise<void>((resolve) => { resolveUpdate = resolve; });
    const bridge = new HerdrBridge({
      socketPath,
      onOutput(_session, screens) {
        if (screens.mobile?.includes('second screen')) resolveUpdate?.();
      },
      onExit() {},
    });

    try {
      const attached = (await bridge.refresh())[0];
      await bridge.addViewer(attached, 12, 6, 'mobile');
      await bridge.refresh();
      paneText = 'second screen';
      paneRevision = 8;

      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        update,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('attached pane stopped refreshing')), 2_500);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
    } finally {
      bridge.removeViewersForClient(12);
      rejectEventWait = false;
      paneText = '• 已完成。\n\n  这是最后一句回复。\n\n─ Worked for 1m ─';
      paneRevision = 7;
    }
  });

  it('records the observed completion time and preserves it while done', async () => {
    agentStatus = 'working';
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();

    const beforeCompletion = Date.now();
    agentStatus = 'done';
    const completed = (await bridge.refresh())[0];
    const afterCompletion = Date.now();

    assert.ok(completed.completedAt !== undefined);
    assert.ok(completed.completedAt >= beforeCompletion);
    assert.ok(completed.completedAt <= afterCompletion);
    assert.equal((await bridge.refresh())[0].completedAt, completed.completedAt);
    agentStatus = 'idle';
  });

  it('sends terminal text and logical keys through pane.send_input in order', async () => {
    requests.length = 0;
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    await bridge.write(session, Buffer.from('你好\x03\x1b[Aok\r', 'utf8'));

    assert.deepEqual(
      requests.filter((request) => request.method === 'pane.send_input').map((request) => request.params),
      [
        { pane_id: 'w1:p1', text: '你好' },
        { pane_id: 'w1:p1', keys: ['ctrl+c', 'up'] },
        { pane_id: 'w1:p1', text: 'ok' },
        { pane_id: 'w1:p1', keys: ['enter'] },
      ],
    );
  });

  it('closes a pane through Herdr and removes the bridged session', async () => {
    requests.length = 0;
    let exited: string | undefined;
    const bridge = new HerdrBridge({
      socketPath,
      onOutput() {},
      onExit(session) { exited = session.id; },
    });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    await bridge.close(session);

    assert.deepEqual(requests.find((request) => request.method === 'pane.close')?.params, { pane_id: 'w1:p1' });
    assert.equal(bridge.sessions.has(session.id), false);
    assert.equal(exited, session.id);
  });

  it('reads and caches the latest reply at the current pane revision', async () => {
    requests.length = 0;
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    assert.equal(await bridge.getPreview(session), '这是最后一句回复。');
    await bridge.refresh();
    assert.equal(await bridge.getPreview(bridge.sessions.get('herdr:w1:p1')!), '这是最后一句回复。');
    assert.equal(requests.filter((request) => request.method === 'pane.read').length, 1);
    assert.deepEqual(requests.find((request) => request.method === 'pane.read')?.params, {
      pane_id: 'w1:p1',
      source: 'visible',
      format: 'text',
      strip_ansi: true,
    });
  });

  it('captures and caches visible context for Global', async () => {
    requests.length = 0;
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    assert.match(await bridge.getContext(session) || '', /这是最后一句回复/);
    await bridge.getContext(session);
    assert.equal(requests.filter((request) => request.method === 'pane.read').length, 1);
    assert.deepEqual(requests.find((request) => request.method === 'pane.read')?.params, {
      pane_id: 'w1:p1',
      source: 'visible',
      format: 'text',
      strip_ansi: true,
    });
  });

  for (const consumer of ['preview', 'context', 'mobile'] as const) {
    it(`observes an alternate-screen ${consumer} without scrolling the running application`, async () => {
      const previousRevision = paneRevision;
      alternateScreenRows = 12;
      historyScrolls = 0;
      const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
      try {
        await bridge.refresh();
        const session = bridge.sessions.get('herdr:w1:p1')!;
        // The last discovery snapshot says 40 rows. The actual viewport has
        // since shrunk to 12, so clamping to cached geometry is not sufficient.
        assert.equal(session.rows, 40);
        if (consumer === 'preview') {
          assert.match(await bridge.getPreview(session) || '', /这是最后一句回复/);
        } else if (consumer === 'context') {
          assert.match(await bridge.getContext(session) || '', /这是最后一句回复/);
        } else {
          const initial = await bridge.addViewer(session, 91, 1, 'mobile', true);
          assert.ok(initial.mobileTranscript?.lines.length);
          assert.ok((await bridge.resyncMobileViewer(session, 91, 1))?.lines.length);
        }
        assert.equal(historyScrolls, 0, 'observation must not invoke Herdr app-history scrolling');
        assert.equal(paneRevision, previousRevision, 'observation must not change the pane revision');
      } finally {
        bridge.removeViewersForClient(91);
        alternateScreenRows = undefined;
        paneRevision = previousRevision;
      }
    });
  }

  it('scrolls a compatible viewer only on demand and returns to the live viewport before input', async () => {
    requests.length = 0;
    historyText = Array.from({ length: 100 }, (_, i) => `HISTORY_${i + 1}`).join('\n');
    const frames: Buffer[] = [];
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {},
      onTerminalOutput: (_session, viewer, data) => { if (viewer.clientId === 92) frames.push(data); } });
    try {
      const [session] = await bridge.refresh();
      await bridge.addViewer(session!, 92, 9);
      assert.equal(requests.some(r => r.params.source === 'recent'), false, 'attach must remain passive');
      assert.equal(bridge.scrollViewer(session!, 93, 9, 'up', 3), false, 'another client cannot scroll this viewer');
      assert.equal(bridge.scrollViewer(session!, 92, 9, 'up', 3), true);
      for (let n = 0; n < 100 && frames.length === 0; n++) await new Promise(r => setTimeout(r, 10));
      assert.match(frames.at(-1)!.toString(), /HISTORY_58\r\n/);
      assert.match(frames.at(-1)!.toString(), /HISTORY_97/);
      assert.doesNotMatch(frames.at(-1)!.toString(), /HISTORY_100/);
      assert.equal(requests.filter(r => r.params.source === 'recent').length, 1);
      await bridge.writeViewer(session!, 92, 9, Buffer.from('hello'));
      assert.match(frames.at(-1)!.toString(), /这是最后一句回复/);
      assert.equal(requests.filter(r => r.method === 'pane.send_input').length, 1, 'wheel must not send keys');
      await bridge.writeViewer(session!, 92, 9, Buffer.from('\x1bOB'));
      assert.deepEqual(requests.filter(r => r.method === 'pane.send_input').at(-1)?.params,
        { pane_id: 'w1:p1', keys: ['down'] }, 'the application receives Down, not Alt+O and B');
    } finally { bridge.removeViewersForClient(92); historyText = undefined; }
  });

  it('renders a passive viewport read for a mobile viewer', async () => {
    requests.length = 0;
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    const initial = await bridge.addViewer(session, 7, 3, 'mobile');
    bridge.removeViewersForClient(7);

    const read = requests.find((request) => request.method === 'pane.read');
    assert.deepEqual(read?.params, {
      pane_id: 'w1:p1',
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    });
    assert.match(initial.screen.toString('utf8'), /^\x1b\[3J\x1b\[2J\x1b\[H/);
    assert.match(initial.screen.toString('utf8'), /• 已完成。\r\n\r\n  这是最后一句回复。/);
  });

  it('negotiates a structured mobile snapshot without breaking legacy viewers', async () => {
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    await bridge.refresh();
    const session = bridge.sessions.get('herdr:w1:p1')!;

    const initial = await bridge.addViewer(session, 7, 3, 'mobile', true);

    assert.equal(initial.mobileTranscript?.revision, 7);
    assert.ok(initial.mobileTranscript?.lines.length);
    assert.equal(session.viewers[0].mobilePatches, true);
    assert.equal(session.viewers[0].mobileSnapshot, initial.mobileTranscript);
    bridge.removeViewersForClient(7);
  });

  it('reads a path-valued Agent reference through the real resolver for mobile links', async () => {
    const previousText = paneText, previousSession = agentSession;
    const path = join(dir, 'link-record.jsonl');
    const href = 'https://example.com/downloads';
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: '77777777-7777-4777-8777-777777777777' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[余页 Folio 官网与下载页](${href})` }] } }),
    ].join('\n') + '\n');
    agentSession = { agent: 'codex', kind: 'path', source: 'herdr:codex', value: path };
    paneText = '已发布：\x1b[34;4m余页 Folio 官网与下载页\x1b[0m';
    const bridge = new HerdrBridge({ socketPath, onOutput() {}, onExit() {} });
    try {
      await bridge.refresh();
      const initial = await bridge.addViewer(bridge.sessions.get('herdr:w1:p1')!, 88, 4, 'mobile', true);
      assert.equal(initial.mobileTranscript?.lines.flatMap(line => line.spans).find(span => span.href)?.href, href);
    } finally {
      bridge.removeViewersForClient(88);
      paneText = previousText; agentSession = previousSession;
    }
  });

  it('restores an original Agent Markdown link in the structured mobile snapshot', async () => {
    const href = 'https://example.com/original';
    const bridge = new HerdrBridge({
      socketPath,
      onOutput() {},
      onExit() {},
      async resolveTranscriptLinks(session) {
        assert.equal(session.agentSessionId, 'codex-session-1234567890');
        return [{ text: '这是最后一句回复。', href }];
      },
    });
    await bridge.refresh();

    const initial = await bridge.addViewer(bridge.sessions.get('herdr:w1:p1')!, 8, 4, 'mobile', true);
    const linked = initial.mobileTranscript?.lines.flatMap((line) => line.spans).find((span) => span.href);

    assert.deepEqual(linked, { text: '这是最后一句回复。', href });
    bridge.removeViewersForClient(8);
  });
});

describe('renderMobilePaneText', () => {
  it('preserves ANSI colors while removing colored separator-only rows', () => {
    const rendered = renderMobilePaneText(
      '\x1b[0m\x1b[2m────────────\x1b[0m\n' +
      '\x1b[48;2;45;57;66m                    \x1b[0m\n' +
      '\x1b[38;5;6mcolored text ────────────\x1b[0m',
    ).toString('utf8');

    assert.match(rendered, /\x1b\[38;5;6mcolored text\x1b\[0m/);
    assert.doesNotMatch(rendered, /────────────/);
    assert.doesNotMatch(rendered, /48;2;45;57;66/);
  });
});

describe('decodeTerminalInput', () => {
  it('forwards the mobile Codex question shortcut as Shift+Left, never as text', () => {
    assert.deepEqual(decodeTerminalInput(Buffer.from('\x1b[1;2D')), [{ keys: ['shift+left'] }]);
  });

  it('composes Shift, Alt and Ctrl for all cursor keys', () => {
    const names = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
    for (let mask = 1; mask <= 7; mask += 1) {
      const modifiers = [mask & 4 ? 'ctrl' : '', mask & 2 ? 'alt' : '', mask & 1 ? 'shift' : ''].filter(Boolean);
      for (const [final, name] of Object.entries(names)) {
        assert.deepEqual(decodeTerminalInput(Buffer.from(`\x1b[1;${mask + 1}${final}`)), [{ keys: [[...modifiers, name].join('+')] }]);
      }
    }
  });

  it('holds an unambiguous modified cursor prefix across frames without delaying Escape', () => {
    const decoder = new TerminalInputDecoder();
    assert.deepEqual(decoder.decode(Buffer.from('\x1b[1;')), []);
    assert.deepEqual(decoder.decode(Buffer.from('2')), []);
    assert.deepEqual(decoder.decode(Buffer.from('D')), [{ keys: ['shift+left'] }]);
    assert.deepEqual(decoder.decode(Buffer.from('\x1b')), [{ keys: ['esc'] }]);
    assert.deepEqual(decodeTerminalInput(Buffer.from('\x1b[200~\x1b[1;2D\x1b[201~')), [{ text: '\x1b[1;2D' }]);
  });

  it('preserves application-cursor arrows from native desktop terminals', () => {
    assert.deepEqual(decodeTerminalInput(Buffer.from('\x1bOA\x1bOB\x1bOC\x1bOD')), [
      { keys: ['up', 'down', 'right', 'left'] },
    ]);
  });

  it('removes bracketed-paste wrappers without losing Unicode text', () => {
    assert.deepEqual(
      decodeTerminalInput(Buffer.from('\x1b[200~中文 paste\x1b[201~', 'utf8')),
      [{ text: '中文 paste' }],
    );
  });

  it('treats CRLF as one Enter key', () => {
    assert.deepEqual(decodeTerminalInput(Buffer.from('command\r\n', 'utf8')), [
      { text: 'command' },
      { keys: ['enter'] },
    ]);
  });

  it('does not delay a standalone Escape key while looking for paste markers', () => {
    assert.deepEqual(decodeTerminalInput(Buffer.from('\x1b', 'utf8')), [{ keys: ['esc'] }]);
  });

  it('keeps newlines inside bracketed paste as text instead of Enter keys', () => {
    assert.deepEqual(
      decodeTerminalInput(Buffer.from('\x1b[200~first\r\nsecond\nthird\x1b[201~', 'utf8')),
      [{ text: 'first\nsecond\nthird' }],
    );
  });

  it('pastes a multi-line Agent prompt and submits it only once', () => {
    assert.deepEqual(decodeTerminalInput(pasteAndSubmit('first\nsecond\nthird')), [
      { text: 'first\nsecond\nthird' },
      { keys: ['enter'] },
    ]);
  });

  it('preserves paste mode when wrappers and Unicode text cross input frames', () => {
    const decoder = new TerminalInputDecoder();

    assert.deepEqual(decoder.decode(Buffer.from('\x1b[20', 'utf8')), []);
    assert.deepEqual(decoder.decode(Buffer.from('0~first\r\n\xe4\xb8', 'binary')), [{ text: 'first\n' }]);
    assert.deepEqual(decoder.decode(Buffer.from('\xadsecond\x1b[2', 'binary')), [{ text: '中second' }]);
    assert.deepEqual(decoder.decode(Buffer.from('01~next\r', 'utf8')), [
      { text: 'next' },
      { keys: ['enter'] },
    ]);
  });
});

describe('extractPanePreview', () => {
  it('keeps Claude prose and ignores its following tool and task UI', () => {
    assert.equal(
      extractPanePreview(`
⏺ 修法：在纹理退休的唯一入口打上死亡标记，异步 finalize 回来时先检查。

⏺ Update(packages/renderer-three/src/renderer/core/rendererCore.ts)
  ⎿ Added 6 lines
  10 tasks (9 done, 1 open)
  ◻ Reuse baked textures on zoom rebuild
────────────────────────────────────────
❯
`),
      '修法：在纹理退休的唯一入口打上死亡标记，异步 finalize 回来时先检查。',
    );
  });

  it('returns the final wrapped line from a Codex response block', () => {
    assert.equal(
      extractPanePreview(`
• Ran npm view bytespost-canvas version
  └ 0.1.3

────────────────────────────────────────

• 发布完成。

  - bytespost-canvas@0.1.3 已发布
  - Registry 全新安装成功

  普通 npm 登录不用重复，但受 npm 2FA 策略影响，今后直接发布仍可能要求安全密钥确认；彻底免交互发布需要配置 GitHub Actions
  OIDC trusted publishing。

─ Worked for 3m 52s ────────────────────

› Find and fix a bug in @filename
`),
      'OIDC trusted publishing。',
    );
  });
});

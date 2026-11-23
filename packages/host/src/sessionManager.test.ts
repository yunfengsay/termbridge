import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionBackend } from './backend.js';
import { BrainCoordinator, MemoryBrainStore } from '@termbridge/brain';
import { SessionManager, TerminalSpawnError } from './sessionManager.js';
import { execFileSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const directBackend: SessionBackend = {
  name: 'direct',
  durable: false,
  wrap: (_key, spec) => spec,
};

test('an immediately exiting direct session reports its exit and is removed', async () => {
  const brain = new BrainCoordinator(new MemoryBrainStore());
  const task = brain.submit({
    requestId: 'fast-exit',
    text: '快速退出',
    requestedAgent: 'codex',
    availableAgents: ['codex'],
  });
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const manager = new SessionManager(
    () => {},
    (session, exitCode) => {
      brain.finishSession(session.id, exitCode);
      resolveExit?.(exitCode);
    },
    directBackend,
  );

  const session = manager.create({
    command: '/bin/sh',
    args: ['-c', 'exit 7'],
    cols: 80,
    rows: 24,
    durable: false,
    onCreated: (createdSession) => {
      brain.bindSession(task.taskId, createdSession.id);
    },
  });

  const exitCode = await Promise.race([
    exited,
    new Promise<number>((_, reject) => setTimeout(() => reject(new Error('exit event timed out')), 5_000)),
  ]);
  assert.equal(exitCode, 7);
  assert.equal(manager.sessions.has(session.id), false);
  assert.equal(brain.getSnapshot().tasks[0]?.status, 'failed');
});

test('PTY masters close on exit, kill, failed setup and shutdown; detach and restart retain live sessions',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    assert.match(new TerminalSpawnError(new Error('forkpty(3) failed.')).message, /终端句柄耗尽/);
    assert.match(new TerminalSpawnError(new Error('openpty: Device not configured')).message, /PTY handles exhausted/);
    assert.doesNotMatch(new TerminalSpawnError(new Error('private command detail')).message, /private command detail/);
    const ptmxCount = () => process.platform === 'darwin'
      ? execFileSync('lsof', ['-nP', '-p', String(process.pid)], { encoding: 'utf8' })
          .split('\n').filter(line => /\/dev\/(ptmx|ttys)/.test(line)).length
      : 0;
    const baseline = ptmxCount();
    let exits = 0;
    const manager = new SessionManager(() => {}, () => { exits++; }, {
      ...directBackend, restart: () => true,
    });
    const closed = async (fd: number) => {
      for (let i = 0; i < 100; i++) {
        try { fstatSync(fd); } catch { return; }
        await delay(10);
      }
      assert.fail(`PTY master ${fd} is still open`);
    };
    try {
      for (let i = 0; i < 5; i++) {
        const s = manager.create({ command: '/bin/sh', args: ['-c', 'exit 0'], cols: 80, rows: 24 });
        const fd = (s.pty as typeof s.pty & { fd: number }).fd;
        await closed(fd);
        for (let n = 0; manager.sessions.size && n < 500; n++) await delay(10);
        assert.equal(manager.sessions.size, 0);
      }
      const s = manager.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cols: 80, rows: 24 });
      const fd = (s.pty as typeof s.pty & { fd: number }).fd;
      manager.addViewer(s, 42, 1);
      manager.removeViewersForClient(42);
      assert.equal(s.viewers.length, 0);
      assert.equal(manager.sessions.get(s.id), s, 'disconnect retains the owned live session');
      assert.equal(manager.restart(s), true);
      fstatSync(fd);
      manager.kill(s);
      manager.kill(s);
      await closed(fd);
      assert.equal(manager.sessions.size, 0);
      assert.equal(exits, 6, 'kill and a late exit must notify exactly once');
      let failedFd = -1;
      assert.throws(() => manager.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cols: 80, rows: 24,
        onCreated: s => { failedFd = (s.pty as typeof s.pty & { fd: number }).fd; throw new Error('setup failed'); },
      }), /setup failed/);
      await closed(failedFd);
      const live = manager.create({ command: '/bin/sh', args: ['-c', 'sleep 30'], cols: 80, rows: 24 });
      const liveFd = (live.pty as typeof live.pty & { fd: number }).fd;
      // Force posix_spawn(E2BIG), including native allocation failure cleanup.
      assert.throws(() => manager.create({ command: '/bin/echo', args: ['x'.repeat(1024 * 1024)], cols: 80, rows: 24 }),
        /Cannot start terminal/);
      manager.dispose();
      manager.dispose();
      await closed(liveFd);
      assert.equal(manager.sessions.size, 0);
      assert.throws(() => manager.create({ cols: 80, rows: 24 }), /closed/);
      await delay(100);
      assert.equal(ptmxCount(), baseline, 'native spare master/slave FDs must also return to baseline');
    } finally { manager.dispose(); }
  });

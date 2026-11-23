import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ServeSupervisor, reloadOwnedServes } from './serveSupervisor.js';

async function fixture(t: test.TestContext, extra: Partial<ConstructorParameters<typeof ServeSupervisor>[0]> = {}) {
  const root = await mkdtemp('/tmp/tb-serve-'), directory = join(root, 'records'), packageRoot = join(root, 'package');
  await mkdir(packageRoot); await writeFile(join(packageRoot, 'package.json'), '{}');
  const children: ChildProcess[] = []; let version = '1.0.0';
  const service = new ServeSupervisor({ packageRoot, directory, version: () => version, readyTimeoutMs: 3000, stopTimeoutMs: 200,
    launch: target => {
      const child = spawn(process.execPath, ['-e', `process.send({event:${JSON.stringify(target === 'relay' ? 'listening' : 'ready')}}); setInterval(()=>{},1000);`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child); return child;
    }, ...extra });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, children, directory, packageRoot, setVersion: (value: string) => version = value };
}

test('reload restarts only children owned by the exact package and preserves other services', async t => {
  const a = await fixture(t), b = await fixture(t);
  await a.service.start(); await b.service.start();
  a.setVersion('2.0.0');
  assert.equal(await reloadOwnedServes(b.packageRoot, a.directory), 0);
  assert.equal(await reloadOwnedServes(a.packageRoot, a.directory), 1);
  assert.equal(a.children.length, 4); assert.equal(b.children.length, 2);
  assert.ok(a.children.slice(0, 2).every(child => child.signalCode !== null));
  assert.ok(b.children.every(child => child.signalCode === null));
  await a.service.stop(); await a.service.stop();
  assert.deepEqual(await readdir(a.directory), []);
});

test('stop during restart drains old children and never spawns replacements', async t => {
  const f = await fixture(t); await f.service.start();
  const restarting = f.service.restart(); const stopping = f.service.stop();
  await assert.rejects(restarting, /stopped/); await stopping;
  assert.equal(f.children.length, 2); assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.service.restart(), /stopped/);
});

test('concurrent reload requests share one restart and App replacement triggers another', async t => {
  const f = await fixture(t, { watchReplacement: true, watchIntervalMs: 15 });
  await f.service.start();
  await Promise.all([f.service.restart(), f.service.restart()]);
  assert.equal(f.children.length, 4);
  f.setVersion('2.0.0'); await writeFile(join(f.packageRoot, 'package.json'), '{"version":"2.0.0"}');
  for (let i = 0; i < 100 && f.children.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.children.length, 6);
  await f.service.stop(); assert.ok(f.children.every(child => child.signalCode !== null || child.exitCode !== null));
});

test('failed startup and cancellation leave no service or children', async t => {
  const f = await fixture(t, { launch: () => spawn('/nonexistent/tb-fixture', [], { stdio: 'ignore' }) });
  await assert.rejects(f.service.start(), /could not start/);
  const g = await fixture(t, { launch: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) });
  const starting = g.service.start(); const stopped = g.service.stop();
  await assert.rejects(starting); await stopped;
});

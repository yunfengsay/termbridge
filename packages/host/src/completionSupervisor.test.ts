import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionSupervisor, completionId, completionCard, type CompletionInput, type CompletionDependencies } from './completionSupervisor.js';

const input = (): CompletionInput => ({ event: { sessionId: 'herdr:author', source: 'herdr', name: 'Builder',
  command: 'codex', workspace: 'project', completedAt: 1000, currentStatus: 'done', summary: 'Implemented; no test output provided.' },
  goal: 'Implement feature with tests', revision: 5, conversationId: 'conversation',
  candidates: [{ sessionId: 'herdr:reviewer', name: 'Reviewer', source: 'herdr', workspace: 'project' }] });
function fixture(t: { after(fn: () => void): void }, overrides: Partial<CompletionDependencies> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-completion-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'reviews.json'); let sent = 0; const published: string[] = [];
  const dependencies: CompletionDependencies = {
    judge: async () => ({ next: 'review', confidence: .96, reviewerId: 'herdr:reviewer', presentation: 'evidence' }),
    review: async () => 'Missing tests; not verified.',
    current: id => id === 'herdr:author' ? { status: 'done', revision: 5, completedAt: 1000 } : { status: 'idle', completedAt: 900 },
    handoff: async () => { sent++; return { ok: true }; }, publish: r => { published.push(r.status); }, ...overrides,
  };
  return { file, dependencies, supervisor: new CompletionSupervisor(file, dependencies), sent: () => sent, published };
}
test('completion → read-only review → explicit handoff → reviewer receipt; duplicates never reexecute', async t => {
  const f = fixture(t); const original = input();
  await f.supervisor.observe(original); await f.supervisor.observe(original);
  assert.equal(f.sent(), 0); assert.deepEqual(f.published, ['classifying', 'reviewing', 'ready']);
  const id = completionId(original.event);
  assert.equal(completionCard(f.supervisor.list()[0]).items[1].id, `${id}:handoff`);
  await f.supervisor.approve(id); assert.equal(f.sent(), 1);
  await assert.rejects(f.supervisor.approve(id));
  const restored = new CompletionSupervisor(f.file, f.dependencies);
  await restored.observe(original); assert.equal(f.sent(), 1);
  await restored.observe({ ...original, event: { ...original.event, sessionId: 'herdr:reviewer', completedAt: 2000, summary: 'Test evidence missing' } });
  const result = restored.list().find(r => r.id === id)!;
  assert.equal(result.status, 'needs_decision'); assert.equal(result.review, 'Test evidence missing');
  assert.equal(completionCard(result).items.length, 1);
});
test('missing goals, uncertain judgments and stale versions never start independent review', async t => {
  let reviewed = 0;
  const f = fixture(t, { review: async () => { reviewed++; return ''; }, current: () => ({ status: 'done', revision: 6, completedAt: 1000 }) });
  await f.supervisor.observe(input()); assert.equal(reviewed, 0);
  await assert.rejects(f.supervisor.approve(completionId(input().event)));
  const other = fixture(t, { review: async () => { reviewed++; return ''; } });
  await other.supervisor.observe({ ...input(), goal: undefined }); assert.equal(reviewed, 0);
});
test('cancel beats a late provider and produces a persisted cancelled receipt', async t => {
  let release!: (value: string) => void;
  const f = fixture(t, { review: () => new Promise(resolve => { release = resolve; }) });
  const operation = f.supervisor.observe(input());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.supervisor.cancel(completionId(input().event)));
  await operation; release('late success'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.supervisor.list()[0].status, 'cancelled');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8'))[0].status, 'cancelled');
  assert.equal(f.sent(), 0);
});
test('unknown delivery cannot be approved again; reviewer must differ and share workspace', async t => {
  const f = fixture(t, { handoff: async () => { throw new Error('delivery unknown'); } });
  await f.supervisor.observe(input()); await f.supervisor.approve(completionId(input().event));
  await assert.rejects(f.supervisor.approve(completionId(input().event)));
  assert.equal(f.supervisor.list()[0].decision?.reviewerId, undefined);
  const unsafe = fixture(t);
  await unsafe.supervisor.observe({ ...input(), candidates: [{ ...input().candidates[0], workspace: 'another-project' }] });
  assert.equal(unsafe.supervisor.list()[0].decision?.reviewerId, undefined);
});
test('busy reviewer blocks dispatch and in-flight reviewer remains reserved', async t => {
  const f = fixture(t);
  await f.supervisor.observe(input()); await f.supervisor.approve(completionId(input().event));
  const next = { ...input(), event: { ...input().event, sessionId: 'herdr:other', completedAt: 3000 } };
  f.dependencies.current = id => id === 'herdr:other' ? { status: 'done', completedAt: 3000, revision: 5 } : { status: 'idle' };
  await f.supervisor.observe(next);
  await assert.rejects(f.supervisor.approve(completionId(next.event)), /busy/);
  assert.equal(f.sent(), 1);
});

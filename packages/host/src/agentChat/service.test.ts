import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentChatDeliveryUnknown,
  AgentChatService,
  type AgentChatAppendEvent,
  type AgentChatSnapshotEvent,
  type ConversationDescriptor,
} from './service.js';
import { claudeProjectSlug } from './transcriptLocator.js';
import type { AgentChatDelivery } from '@termbridge/agent-chat';

const SESSION = '77777777-7777-4777-8777-777777777777';
const CWD = '/Users/tester/code/demo';
const CONVERSATION = 'herdr:wZ:p1';

// Synthetic records only. Nothing from a real conversation is checked in.
const modeRecord = () => JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }) + '\n';
const userRecord = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, sessionId: SESSION, timestamp: '2026-09-14T04:00:00.000Z', message: { role: 'user', content: text } }) + '\n';
const assistantRecord = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, sessionId: SESSION, timestamp: '2026-09-14T04:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

interface Harness {
  home: string;
  path: string;
  service: AgentChatService;
  snapshots: Array<{ clientId: number; event: AgentChatSnapshotEvent }>;
  appends: Array<{ clientId: number; event: AgentChatAppendEvent }>;
  deliveries: Array<{ clientId: number; event: AgentChatDelivery & { generation: number } }>;
  delivered: string[];
  descriptor: ConversationDescriptor;
  // `silent` is a write the channel accepted but the Agent never recorded — the
  // only way a pending matcher survives to reach its own boundary.
  deliverMode: { value: 'ok' | 'silent' | 'reject' | 'unknown' };
  // Lets a test hold `describe` open and act while a subscribe is mid-flight,
  // which is the only way to exercise what happens to a pending subscription.
  gate: { hold?: Promise<void> };
  dispose(): Promise<void>;
}

async function harness(options: { recordOverdueMs?: number } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-svc-'));
  const dir = join(home, '.claude', 'projects', claudeProjectSlug(CWD));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(path, modeRecord() + userRecord('u1', '第一条') + assistantRecord('a1', '收到'));

  const snapshots: Harness['snapshots'] = [];
  const appends: Harness['appends'] = [];
  const deliveries: Harness['deliveries'] = [];
  const delivered: string[] = [];
  const deliverMode: Harness['deliverMode'] = { value: 'ok' };
  const gate: Harness['gate'] = {};
  const descriptor: ConversationDescriptor = {
    conversationId: CONVERSATION, paneId: 'wZ:p1', agent: 'claude',
    providerSessionId: SESSION, sessionRef: { kind: 'id', value: SESSION },
    workspace: 'demo', title: 'demo agent', cwd: CWD, status: 'idle',
  };

  const service = new AgentChatService({
    hostId: 'host-1',
    home,
    pollIntervalMs: 1_000_000, // every poll in these tests is explicit
    bindRetryMs: 0, // and so is every look for a record that is not written yet
    recordOverdueMs: options.recordOverdueMs,
    backend: {
      list: async () => [descriptor],
      describe: async (id) => {
        if (gate.hold) await gate.hold;
        return id === CONVERSATION ? descriptor : undefined;
      },
      deliver: async (_id, text) => {
        if (deliverMode.value === 'reject') throw new Error('pane 拒绝了输入');
        if (deliverMode.value === 'unknown') throw new AgentChatDeliveryUnknown('Herdr 未返回结果');
        delivered.push(text);
        if (deliverMode.value === 'silent') return;
        await appendFile(path, userRecord(`echo-${delivered.length}`, text));
      },
    },
    sink: {
      snapshot: (clientId, event) => snapshots.push({ clientId, event }),
      append: (clientId, event) => appends.push({ clientId, event }),
      delivery: (clientId, event) => deliveries.push({ clientId, event }),
    },
  });

  return {
    home, path, service, snapshots, appends, deliveries, delivered, descriptor, deliverMode, gate,
    dispose: async () => { service.stop(); await rm(home, { recursive: true, force: true }); },
  };
}

test('a subscription opens on real records and appends only what was added', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    const snapshot = h.snapshots.at(-1)!;
    assert.equal(snapshot.clientId, 5);
    assert.equal(snapshot.event.status, 'ready');
    assert.equal(snapshot.event.binding?.providerSessionId, SESSION);
    assert.equal(snapshot.event.binding?.paneId, 'wZ:p1');
    assert.deepEqual(snapshot.event.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(snapshot.event.capabilities.send, true);
    // Images ride the same verified input channel as text — the Host stores the
    // bytes and the message names the path — so attaching is offered exactly
    // when sending is. Approving, answering and stopping still need a structured
    // channel no adapter provides yet, and say so.
    assert.equal(snapshot.event.capabilities.attachments, true);
    assert.deepEqual(
      [snapshot.event.capabilities.approvals, snapshot.event.capabilities.questions, snapshot.event.capabilities.stop],
      [false, false, false],
    );

    await appendFile(h.path, assistantRecord('a2', '继续中'));
    await h.service.poll(CONVERSATION);
    const append = h.appends.at(-1)!;
    assert.equal(append.event.messages.length, 1);
    assert.equal(append.event.messages[0]!.blocks[0]!.type === 'text' && append.event.messages[0]!.blocks[0]!.text, '继续中');
    assert.equal(append.event.generation, 1);

    // A pass with nothing appended and no status change emits nothing at all.
    const before = h.appends.length;
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.length, before);
  } finally { await h.dispose(); }
});

test('send reports accepted, delivered, then observed against the agent’s own record', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    await h.service.send(5, CONVERSATION, 'send-1', '跑一次测试');
    await h.service.poll(CONVERSATION);
    const states = h.deliveries.filter((entry) => entry.event.requestId === 'send-1').map((entry) => entry.event.state);
    assert.deepEqual(states, ['accepted', 'delivered', 'observed']);
    assert.deepEqual(h.delivered, ['跑一次测试']);
    const observed = h.deliveries.at(-1)!.event;
    assert.equal(typeof observed.messageId, 'string');
    assert.equal(observed.generation, 1);
    assert.equal(observed.conversationId, CONVERSATION);
  } finally { await h.dispose(); }
});

test('an identical prompt already in history does not confirm a new send', async () => {
  const h = await harness();
  try {
    await appendFile(h.path, userRecord('old', '重复的内容'));
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.deliverMode.value = 'unknown';
    await h.service.send(5, CONVERSATION, 'send-1', '重复的内容');
    await h.service.poll(CONVERSATION);
    const states = h.deliveries.filter((entry) => entry.event.requestId === 'send-1').map((entry) => entry.event.state);
    assert.deepEqual(states, ['accepted', 'uncertain']);
  } finally { await h.dispose(); }
});

test('a rejected write is failed, an unknown one is uncertain, and neither is auto-resent', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.deliverMode.value = 'reject';
    await h.service.send(5, CONVERSATION, 'send-1', '第一次');
    h.deliverMode.value = 'unknown';
    await h.service.send(5, CONVERSATION, 'send-2', '第二次');
    assert.deepEqual(h.deliveries.filter((e) => e.event.requestId === 'send-1').map((e) => e.event.state), ['accepted', 'failed']);
    assert.deepEqual(h.deliveries.filter((e) => e.event.requestId === 'send-2').map((e) => e.event.state), ['accepted', 'uncertain']);
    assert.deepEqual(h.delivered, []);
  } finally { await h.dispose(); }
});

test('a client that did not subscribe cannot send, and a blocked agent disables the composer', async () => {
  const h = await harness();
  try {
    await h.service.send(9, CONVERSATION, 'send-x', '越权发送');
    assert.equal(h.deliveries.at(-1)!.event.state, 'failed');
    assert.equal(h.delivered.length, 0);

    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.descriptor.status = 'blocked';
    await h.service.poll(CONVERSATION);
    const append = h.appends.at(-1)!;
    assert.equal(append.event.capabilities.send, false);
    assert.match(append.event.capabilities.degraded ?? '', /终端/);
    await h.service.send(5, CONVERSATION, 'send-2', '不该送出去');
    assert.equal(h.deliveries.at(-1)!.event.state, 'failed');
    assert.deepEqual(h.delivered, []);
  } finally { await h.dispose(); }
});

test('two clients keep independent generations and independent selection', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-a');
    await h.service.subscribe(6, CONVERSATION, 7, 'req-b');
    await appendFile(h.path, assistantRecord('a2', '广播'));
    await h.service.poll(CONVERSATION);
    const generations = h.appends.slice(-2).map((entry) => [entry.clientId, entry.event.generation]);
    assert.deepEqual(generations.sort(), [[5, 1], [6, 7]]);

    // One client leaving does not disturb the other's watcher.
    h.service.unsubscribe(5, CONVERSATION);
    await appendFile(h.path, assistantRecord('a3', '只给还在的人'));
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.clientId, 6);
  } finally { await h.dispose(); }
});

test('an upload is authorized by a live subscription, and only that', async () => {
  const h = await harness();
  try {
    // Naming a conversation is not enough; the Host has to have granted it.
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);

    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), true);
    // A different connection holds nothing, even for the same conversation.
    assert.equal(h.service.hasSubscriber(6, CONVERSATION), false);
    assert.equal(h.service.hasSubscriber(5, 'herdr:wZ:p9'), false);

    h.service.unsubscribe(5, CONVERSATION);
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);

    // A dropped connection loses the grant too, so a late upload from a socket
    // that has gone away cannot still be accepted.
    await h.service.subscribe(5, CONVERSATION, 2, 'req-2');
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), true);
    h.service.dropClient(5);
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);
  } finally { await h.dispose(); }
});

test('a subscribe still in flight cannot revive a grant the client already gave up', async () => {
  const h = await harness();
  try {
    // Hold the subscribe inside its first await, then revoke from outside — the
    // exact interleaving the Host allows, since control frames are handled
    // concurrently and nothing cancels an in-flight subscribe on its own.
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.service.subscribe(5, CONVERSATION, 1, 'req-1');

    h.service.unsubscribe(5, CONVERSATION);
    release();
    await pending;

    // The subscribe ran to completion against a client that had unsubscribed.
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);
    // And it must not have drawn anything for that client either.
    assert.equal(h.snapshots.some((s) => s.clientId === 5), false);
  } finally { await h.dispose(); }
});

test('a connection dropped mid-subscribe does not end up holding the conversation', async () => {
  const h = await harness();
  try {
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.service.subscribe(5, CONVERSATION, 1, 'req-1');

    h.service.dropClient(5);
    release();
    await pending;

    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);
    assert.equal(h.snapshots.some((s) => s.clientId === 5), false);

    // A client that subscribes properly afterwards still works, so revoking did
    // not poison the conversation for everyone.
    h.gate.hold = undefined;
    await h.service.subscribe(6, CONVERSATION, 1, 'req-2');
    assert.equal(h.service.hasSubscriber(6, CONVERSATION), true);
  } finally { await h.dispose(); }
});

test('a losing older subscribe does not take the newer one down with it (V06 g1/g2)', async () => {
  const h = await harness();
  try {
    // g1 is held inside describe; g2 then subscribes and completes; g1 returns
    // last. This pins the outcome V06 asks for — g2 keeps its subscription,
    // upload grant and watcher, and g1 draws nothing — whichever way g1 ends.
    // (g1 exits at its revocation check before reaching cleanup, so this does
    // not exercise the withdrawal identity guard; that one is defence in depth
    // and is documented as such in service.ts.)
    let releaseFirst!: () => void;
    h.gate.hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = h.service.subscribe(5, CONVERSATION, 1, 'req-g1');

    h.gate.hold = undefined;
    await h.service.subscribe(5, CONVERSATION, 2, 'req-g2');
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), true);

    releaseFirst();
    await first;

    // g2 survives: still subscribed, still able to upload, still watched.
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), true);
    const snapshots = h.snapshots.filter((s) => s.clientId === 5);
    assert.equal(snapshots.at(-1)!.event.generation, 2);
    // g1 never drew anything, in either order of completion.
    assert.equal(snapshots.some((s) => s.event.generation === 1), false);

    // The watcher really is live: an append still reaches g2.
    await appendFile(h.path, assistantRecord('a9', '仍在推送'));
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.event.generation, 2);
  } finally { await h.dispose(); }
});

test('two connections opening the same conversation at once both keep it', async () => {
  const h = await harness();
  try {
    // Both arrive before it exists, so both run the create path. If the loser
    // overwrote the map, the winner's subscriber would sit on an orphan: no
    // appends, and no grant for its uploads.
    let release!: () => void;
    h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
    const first = h.service.subscribe(5, CONVERSATION, 1, 'req-a');
    const second = h.service.subscribe(6, CONVERSATION, 1, 'req-b');
    release();
    await Promise.all([first, second]);

    assert.equal(h.service.hasSubscriber(5, CONVERSATION), true);
    assert.equal(h.service.hasSubscriber(6, CONVERSATION), true);
    assert.equal(h.snapshots.filter((s) => s.clientId === 5).length, 1);
    assert.equal(h.snapshots.filter((s) => s.clientId === 6).length, 1);

    // And both keep receiving: one watcher, feeding both subscribers.
    await appendFile(h.path, assistantRecord('a7', '两个客户端都要收到'));
    await h.service.poll(CONVERSATION);
    assert.deepEqual(h.appends.slice(-2).map((a) => a.clientId).sort(), [5, 6]);
  } finally { await h.dispose(); }
});

test('the last unsubscribe releases the watcher and a later poll does nothing', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.service.dropClient(5);
    const before = h.appends.length;
    await appendFile(h.path, assistantRecord('a2', '无人订阅'));
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.length, before);
    // Re-subscribing rebuilds from the file, so nothing was lost by releasing.
    await h.service.subscribe(5, CONVERSATION, 2, 'req-2');
    assert.equal(h.snapshots.at(-1)!.event.messages.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === '无人订阅')), true);
  } finally { await h.dispose(); }
});

test('a truncated or rotated transcript pushes a fresh snapshot instead of appending', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    const snapshotsBefore = h.snapshots.length;
    await writeFile(h.path, modeRecord() + userRecord('n1', '轮转之后'));
    assert.equal((await stat(h.path)).size > 0, true);
    await h.service.poll(CONVERSATION);
    assert.equal(h.snapshots.length, snapshotsBefore + 1);
    const snapshot = h.snapshots.at(-1)!.event;
    assert.equal(snapshot.generation, 1);
    assert.deepEqual(snapshot.messages.map((m) => m.blocks[0]!.type === 'text' && m.blocks[0]!.text), ['轮转之后']);
  } finally { await h.dispose(); }
});

const FRESH = '88888888-8888-4888-8888-888888888888';
// Stamped now: a record the Agent writes in answer to a send postdates it.
const freshRecord = (sessionId: string, type: 'user' | 'assistant', uuid: string, text: string, at = new Date()) =>
  JSON.stringify({
    type, uuid, sessionId, timestamp: at.toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';
const freshPath = (h: Harness, sessionId = FRESH) =>
  join(h.home, '.claude', 'projects', claudeProjectSlug(CWD), `${sessionId}.jsonl`);

test('a recognized Agent with no record yet opens empty and can be sent to', async () => {
  const h = await harness();
  try {
    // A Claude session reports its id at start but writes nothing until its
    // first turn, so the file it names does not exist yet.
    h.descriptor.providerSessionId = FRESH;
    h.descriptor.sessionRef = { kind: 'id', value: FRESH };
    await h.service.subscribe(5, CONVERSATION, 3, 'req-1');
    const snapshot = h.snapshots.at(-1)!.event;
    assert.equal(snapshot.requestId, 'req-1');
    assert.equal(snapshot.status, 'empty');
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.earlierCursor, undefined);
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.capabilities.history, true);
    assert.equal(snapshot.capabilities.send, true);
    assert.equal(snapshot.capabilities.attachments, true);
    // An Agent with nothing said yet is simply empty; a warning would be noise.
    assert.equal(snapshot.capabilities.degraded, undefined);

    const listed = await h.service.list();
    assert.equal(listed[0]!.chat, true);
    assert.equal(listed[0]!.reason, undefined);
    // Nothing to page back through, and nothing is invented.
    const page = await h.service.loadEarlier(5, CONVERSATION, 3, 0);
    assert.deepEqual(page, { ok: true, messages: [], atHead: true });
  } finally { await h.dispose(); }
});

test('a freshly started Agent binds to its record once it names itself, confirming the first send', async () => {
  const h = await harness();
  try {
    // Nothing reported yet: the Agent has not had a turn, so it has not said
    // which session it is.
    delete h.descriptor.providerSessionId;
    delete h.descriptor.sessionRef;
    await h.service.subscribe(5, CONVERSATION, 7, 'req-1');
    assert.equal(h.snapshots.at(-1)!.event.status, 'empty');
    assert.equal(h.snapshots.at(-1)!.event.capabilities.send, true);

    h.deliverMode.value = 'silent';
    await h.service.send(5, CONVERSATION, 'send-1', '开始吧');
    assert.deepEqual(h.delivered, ['开始吧']);
    assert.deepEqual(
      h.deliveries.filter((entry) => entry.event.requestId === 'send-1').map((entry) => entry.event.state),
      ['accepted', 'delivered'],
    );

    // Still nameless: another pass binds nothing and pushes nothing, and a
    // first turn in progress is not yet a reason to send the reader elsewhere.
    const snapshotsBefore = h.snapshots.length;
    await h.service.poll(CONVERSATION);
    assert.equal(h.snapshots.length, snapshotsBefore);
    assert.equal(h.appends.some((entry) => entry.event.capabilities.degraded !== undefined), false);

    // The first turn makes the Agent write its record and report its identity.
    await writeFile(freshPath(h), modeRecord().replace(SESSION, FRESH)
      + freshRecord(FRESH, 'user', 'f1', '开始吧') + freshRecord(FRESH, 'assistant', 'f2', '好的'));
    h.descriptor.providerSessionId = FRESH;
    h.descriptor.sessionRef = { kind: 'id', value: FRESH };
    await h.service.poll(CONVERSATION);

    // The page it was showing is replaced wholesale, under the same subscription.
    assert.equal(h.snapshots.length, snapshotsBefore + 1);
    const bound = h.snapshots.at(-1)!;
    assert.equal(bound.clientId, 5);
    assert.equal(bound.event.requestId, 'req-1');
    assert.equal(bound.event.generation, 7);
    assert.equal(bound.event.binding?.providerSessionId, FRESH);
    assert.equal(bound.event.status, 'ready');
    assert.equal(bound.event.capabilities.degraded, undefined);
    assert.deepEqual(bound.event.messages.map((m) => m.role), ['user', 'assistant']);
    // The send made before the file existed is proven by the record that
    // carries it, not left to expire as uncertain.
    const observed = h.deliveries.filter((entry) => entry.event.requestId === 'send-1').at(-1)!.event;
    assert.equal(observed.state, 'observed');
    assert.equal(observed.messageId, bound.event.messages[0]!.id);

    // From here it is an ordinary conversation.
    await appendFile(freshPath(h), freshRecord(FRESH, 'assistant', 'f3', '完成'));
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.event.messages.length, 1);
  } finally { await h.dispose(); }
});

test('a prompt no record answers in time says where the reply is, once', async () => {
  const h = await harness({ recordOverdueMs: 0 });
  try {
    delete h.descriptor.providerSessionId;
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    assert.equal(h.snapshots.at(-1)!.event.capabilities.degraded, undefined);
    h.deliverMode.value = 'silent';
    await h.service.send(5, CONVERSATION, 'send-1', '在吗');

    // The Agent never names its session, so this view cannot show the reply.
    // The composer stays usable; the reader is told to look at the terminal.
    const told = h.appends.at(-1)!.event;
    assert.match(told.capabilities.degraded ?? '', /终端查看/);
    assert.equal(told.capabilities.send, true);
    const pushed = h.appends.length;
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.length, pushed);

    // A record that turns up after all retires the notice with the snapshot.
    await writeFile(freshPath(h), freshRecord(FRESH, 'user', 'late', '在吗'));
    h.descriptor.providerSessionId = FRESH;
    await h.service.poll(CONVERSATION);
    assert.equal(h.snapshots.at(-1)!.event.capabilities.degraded, undefined);
    assert.equal(h.deliveries.filter((entry) => entry.event.requestId === 'send-1').at(-1)!.event.state, 'observed');
  } finally { await h.dispose(); }
});

test('an older identical prompt in a record found late does not confirm a new send', async () => {
  const h = await harness();
  try {
    delete h.descriptor.providerSessionId;
    delete h.descriptor.sessionRef;
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.deliverMode.value = 'silent';
    await h.service.send(5, CONVERSATION, 'send-1', '继续');

    // The record turns up holding the same words, but written an hour before
    // the send: offsets prove nothing for a file first seen now, its time does.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await writeFile(freshPath(h), freshRecord(FRESH, 'user', 'old', '继续', hourAgo) + freshRecord(FRESH, 'assistant', 'old-a', '好', hourAgo));
    h.descriptor.providerSessionId = FRESH;
    await h.service.poll(CONVERSATION);
    assert.equal(h.snapshots.at(-1)!.event.messages.length, 2);
    assert.deepEqual(
      h.deliveries.filter((entry) => entry.event.requestId === 'send-1').map((entry) => entry.event.state),
      ['accepted', 'delivered'],
    );
  } finally { await h.dispose(); }
});

test('a record that names another session closes a waiting conversation and settles its send', async () => {
  const h = await harness();
  try {
    h.descriptor.providerSessionId = FRESH;
    await h.service.subscribe(5, CONVERSATION, 2, 'req-1');
    h.deliverMode.value = 'silent';
    await h.service.send(5, CONVERSATION, 'send-1', '这条会怎样');

    // A file under this session's name that belongs to a different session is a
    // contradiction, not a record still being written.
    await writeFile(freshPath(h), freshRecord('99999999-9999-4999-8999-999999999999', 'user', 'x1', '别人的'));
    await h.service.poll(CONVERSATION);
    const settled = h.deliveries.filter((entry) => entry.event.requestId === 'send-1').at(-1)!.event;
    assert.equal(settled.state, 'uncertain');
    assert.match(settled.error ?? '', /请在终端确认/);
    const closed = h.snapshots.at(-1)!.event;
    assert.equal(closed.requestId, 'req-1');
    assert.equal(closed.generation, 2);
    assert.equal(closed.status, 'unavailable');
    assert.equal(closed.capabilities.history, false);
    assert.equal(closed.capabilities.send, false);
    assert.match(closed.error ?? '', /没有找到/);

    // The watcher is gone: the grant is withdrawn and nothing more is pushed.
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);
    const pushed = h.snapshots.length + h.appends.length;
    await h.service.poll(CONVERSATION);
    assert.equal(h.snapshots.length + h.appends.length, pushed);
  } finally { await h.dispose(); }
});

test('a waiting conversation closes when the Agent leaves its pane', async () => {
  const h = await harness();
  try {
    delete h.descriptor.providerSessionId;
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    // A prompt typed into whatever holds the pane now would run as a command.
    h.descriptor.agent = 'bash';
    await h.service.poll(CONVERSATION);
    const closed = h.snapshots.at(-1)!.event;
    assert.equal(closed.status, 'unavailable');
    assert.match(closed.error ?? '', /Codex\/Claude/);
    assert.equal(h.service.hasSubscriber(5, CONVERSATION), false);
  } finally { await h.dispose(); }
});

test('a pane that is not an Agent is reported unavailable, not approximated', async () => {
  const h = await harness();
  try {
    h.descriptor.agent = 'bash';
    await h.service.subscribe(5, CONVERSATION, 4, 'req-2');
    const snapshot = h.snapshots.at(-1)!.event;
    assert.equal(snapshot.status, 'unavailable');
    assert.equal(snapshot.capabilities.history, false);
    assert.equal(snapshot.capabilities.send, false);
    assert.equal(snapshot.capabilities.terminal, true);
    assert.match(snapshot.error ?? '', /Codex\/Claude/);
    const listed = await h.service.list();
    assert.equal(listed[0]!.chat, false);
    assert.equal(typeof listed[0]!.reason, 'string');
  } finally { await h.dispose(); }
});

test('a send that can no longer be confirmed settles as uncertain, not as silence', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    // The channel took the bytes but the Agent recorded nothing, so the matcher
    // is still waiting; if it is dropped silently the client shows "sending" forever.
    h.deliverMode.value = 'silent';
    await h.service.send(5, CONVERSATION, 'send-1', '这条不会被记录');
    assert.deepEqual(
      h.deliveries.filter((entry) => entry.event.requestId === 'send-1').map((entry) => entry.event.state),
      ['accepted', 'delivered'],
    );
    h.deliveries.length = 0;

    // Rotating the transcript destroys the offsets the matcher was built on.
    await writeFile(h.path, modeRecord() + userRecord('n1', '轮转之后'));
    await h.service.poll(CONVERSATION);
    const settled = h.deliveries.filter((entry) => entry.event.requestId === 'send-1');
    assert.deepEqual(settled.map((entry) => entry.event.state), ['uncertain']);
    assert.match(settled[0]!.event.error ?? '', /轮转或截断/);
    assert.equal(settled[0]!.event.generation, 1);

    // And it is reported exactly once, not on every later pass.
    h.deliveries.length = 0;
    await h.service.poll(CONVERSATION);
    assert.deepEqual(h.deliveries.filter((entry) => entry.event.requestId === 'send-1'), []);
  } finally { await h.dispose(); }
});

test('a streaming agent reads as working without flickering on every poll', async () => {
  const h = await harness();
  try {
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    h.descriptor.status = 'working';
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.event.status, 'working');
    // Herdr reports a streaming agent as working and done in alternation; the
    // label must not follow every flip.
    h.descriptor.status = 'done';
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.event.status, 'working');
    // New records are activity too, so they hold the same latch.
    await appendFile(h.path, assistantRecord('a2', '流式输出'));
    await h.service.poll(CONVERSATION);
    assert.equal(h.appends.at(-1)!.event.status, 'working');
  } finally { await h.dispose(); }
});

test('history pages backwards without re-reading the whole file', async () => {
  const h = await harness();
  try {
    let body = modeRecord();
    for (let index = 0; index < 60; index += 1) body += userRecord(`h${index}`, `历史 ${index}`);
    await writeFile(h.path, body);
    await h.service.subscribe(5, CONVERSATION, 1, 'req-1');
    const snapshot = h.snapshots.at(-1)!.event;
    assert.equal(snapshot.messages.length > 0, true);
    const cursor = snapshot.earlierCursor;
    if (cursor !== undefined) {
      const page = await h.service.loadEarlier(5, CONVERSATION, 1, cursor);
      assert.equal(page.ok && page.atHead, true);
      assert.equal(page.ok && page.messages.every((m) => m.seq < snapshot.messages[0]!.seq), true);
    }
    // A stale generation and an unsubscribed client are both refused, with a
    // reason rather than silence.
    const stale = await h.service.loadEarlier(5, CONVERSATION, 99, cursor ?? 0);
    assert.equal(stale.ok, false);
    const stranger = await h.service.loadEarlier(9, CONVERSATION, 1, 0);
    assert.equal(stranger.ok, false);
  } finally { await h.dispose(); }
});

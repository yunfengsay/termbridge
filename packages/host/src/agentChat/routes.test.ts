import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameType, parseFrame, type ControlMessage } from '@termbridge/protocol';
import { HerdrBridge, type HerdrSession } from '../herdr.js';
import { HISTORY_WINDOW_BYTES } from './conversation.js';
import { createAgentChatRouter } from './routes.js';

// These exercise the real router over real encoded frames, because the bug this
// guards against — a field the Host never echoes — is invisible to a service
// unit test. Every assertion below reads the frame a client would receive.
//
// Herdr's `kind: 'path'` session reference points the locator straight at a
// synthetic transcript, so no fake filesystem or home override is needed.

const SESSION = '99999999-9999-4999-8999-999999999999';

const record = (uuid: string, role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role, uuid, sessionId: SESSION, timestamp: '2026-09-14T05:00:00.000Z',
    message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
  }) + '\n';

interface Harness {
  router: ReturnType<typeof createAgentChatRouter>;
  frames: ControlMessage[];
  path: string;
  dispose(): Promise<void>;
}

/**
 * Writes a transcript comfortably larger than one history window, so the opening
 * read really is a tail and `earlierCursor` really points at unread history. A
 * fixture that fits in the window would report `atHead` and quietly skip the
 * paging path these tests exist to cover.
 */
async function harness(options: { paged?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tb-chat-routes-'));
  const path = join(root, 'transcript.jsonl');
  const filler = '·'.repeat(2_000);
  const turns = options.paged === false ? 2 : Math.ceil((HISTORY_WINDOW_BYTES * 1.5) / (2 * filler.length));
  let body = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }) + '\n';
  for (let index = 0; index < turns; index += 1) {
    body += record(`u${index}`, 'user', `第 ${index} 条提问 ${filler}`);
    body += record(`a${index}`, 'assistant', `第 ${index} 条回答 ${filler}`);
  }
  await writeFile(path, body);

  // A bridge with no socket: nothing here dials Herdr, and the session map is
  // the same public surface the Host's own snapshot refresh writes to.
  const herdr = new HerdrBridge({ onOutput: () => {}, onExit: () => {}, socketPath: join(root, 'absent.sock') });
  const session = {
    id: 'herdr:wT:p1', paneId: 'wT:p1', workspaceId: 'wT', workspace: 'test', name: 'test agent',
    command: 'test', agent: 'claude', agentSessionId: SESSION,
    agentSessionRef: { agent: 'claude', kind: 'path', source: 'herdr:claude', value: path },
    status: 'idle', cols: 80, rows: 24, createdAt: 0, revision: 1, viewers: [], watching: false,
  } as unknown as HerdrSession;
  herdr.sessions.set(session.id, session);

  const frames: ControlMessage[] = [];
  const router = createAgentChatRouter({
    hostId: 'host-routes', herdr,
    send: (_clientId, frame) => {
      const parsed = parseFrame(frame);
      if (parsed.type === FrameType.Control) frames.push(parsed.msg);
    },
  });
  return { router, frames, path, dispose: async () => { router.stop(); await rm(root, { recursive: true, force: true }); } };
}

const CONVERSATION = 'herdr:wT:p1';
const last = <T extends ControlMessage['t']>(frames: ControlMessage[], t: T) =>
  [...frames].reverse().find((frame) => frame.t === t) as Extract<ControlMessage, { t: T }> | undefined;

test('an earlier page comes back carrying the generation it was asked for', async () => {
  const h = await harness();
  try {
    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub', conversationId: CONVERSATION, generation: 6 });
    const snapshot = last(h.frames, 'agent_chat_snapshot')!;
    assert.equal(snapshot.generation, 6);
    assert.equal(snapshot.status, 'ready');
    assert.equal(typeof snapshot.earlierCursor, 'number');

    await h.router.handle(3, {
      t: 'agent_chat_earlier', requestId: 'e1', conversationId: CONVERSATION,
      generation: 6, cursor: snapshot.earlierCursor!,
    });
    const page = last(h.frames, 'agent_chat_earlier_result')!;
    // Without this field the shell discards the page and "load earlier" does nothing.
    assert.equal(page.generation, 6);
    assert.equal(page.requestId, 'e1');
    assert.equal(page.conversationId, CONVERSATION);
    assert.equal(page.error, undefined);
    assert.equal(page.messages.length > 0, true);
    assert.equal(page.messages.every((message) => message.seq < snapshot.messages[0]!.seq), true);
  } finally { await h.dispose(); }
});

test('a page asked for under an abandoned generation is refused and labelled with it', async () => {
  const h = await harness();
  try {
    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub-1', conversationId: CONVERSATION, generation: 1 });
    const cursor = last(h.frames, 'agent_chat_snapshot')!.earlierCursor!;
    // The user switched away and came back: same conversation, new generation.
    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub-2', conversationId: CONVERSATION, generation: 2 });

    await h.router.handle(3, { t: 'agent_chat_earlier', requestId: 'late', conversationId: CONVERSATION, generation: 1, cursor });
    const stale = last(h.frames, 'agent_chat_earlier_result')!;
    // Echoing the request's own generation is what lets the shell drop this by
    // the same rule it uses for every other event.
    assert.equal(stale.generation, 1);
    assert.equal(stale.messages.length, 0);
    assert.match(stale.error ?? '', /切换掉/);

    await h.router.handle(3, { t: 'agent_chat_earlier', requestId: 'current', conversationId: CONVERSATION, generation: 2, cursor });
    const fresh = last(h.frames, 'agent_chat_earlier_result')!;
    assert.equal(fresh.generation, 2);
    assert.equal(fresh.error, undefined);
    assert.equal(fresh.messages.length > 0, true);
  } finally { await h.dispose(); }
});

test('a page asked for after unsubscribing is refused rather than answered', async () => {
  const h = await harness();
  try {
    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub', conversationId: CONVERSATION, generation: 4 });
    const cursor = last(h.frames, 'agent_chat_snapshot')!.earlierCursor!;
    await h.router.handle(3, { t: 'agent_chat_unsubscribe', conversationId: CONVERSATION });

    await h.router.handle(3, { t: 'agent_chat_earlier', requestId: 'after', conversationId: CONVERSATION, generation: 4, cursor });
    const refused = last(h.frames, 'agent_chat_earlier_result')!;
    assert.equal(refused.generation, 4);
    assert.equal(refused.messages.length, 0);
    assert.match(refused.error ?? '', /没有订阅/);

    // Another connection's subscription is no help either: pages are per client.
    await h.router.handle(9, { t: 'agent_chat_subscribe', requestId: 'other', conversationId: CONVERSATION, generation: 1 });
    await h.router.handle(3, { t: 'agent_chat_earlier', requestId: 'borrowed', conversationId: CONVERSATION, generation: 4, cursor });
    assert.match(last(h.frames, 'agent_chat_earlier_result')!.error ?? '', /没有订阅/);
  } finally { await h.dispose(); }
});

test('the router reports the subscription an upload has to be authorized by', async () => {
  const h = await harness({ paged: false });
  try {
    // This is the predicate the Host consults for session_upload, so the wiring
    // through the router — not just the service — is what matters here.
    assert.equal(h.router.hasSubscriber(3, CONVERSATION), false);

    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub', conversationId: CONVERSATION, generation: 1 });
    assert.equal(h.router.hasSubscriber(3, CONVERSATION), true);
    assert.equal(h.router.hasSubscriber(4, CONVERSATION), false);

    await h.router.handle(3, { t: 'agent_chat_unsubscribe', conversationId: CONVERSATION });
    assert.equal(h.router.hasSubscriber(3, CONVERSATION), false);
  } finally { await h.dispose(); }
});

test('a control key needs a live subscription on the generation it names', async () => {
  const h = await harness({ paged: false });
  try {
    // No subscription at all: naming the conversation is not authorization.
    await h.router.handle(3, { t: 'agent_chat_key', requestId: 'k0', conversationId: CONVERSATION, generation: 1, key: 'escape' });
    assert.equal(last(h.frames, 'agent_chat_key_result')!.ok, false);

    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub', conversationId: CONVERSATION, generation: 4 });

    // A key from a generation the client has moved past is refused, so one
    // queued before switching conversations cannot land on the current one.
    await h.router.handle(3, { t: 'agent_chat_key', requestId: 'k1', conversationId: CONVERSATION, generation: 3, key: 'ctrl-c' });
    assert.equal(last(h.frames, 'agent_chat_key_result')!.ok, false);

    // Another connection holds nothing here.
    await h.router.handle(9, { t: 'agent_chat_key', requestId: 'k2', conversationId: CONVERSATION, generation: 4, key: 'escape' });
    assert.equal(last(h.frames, 'agent_chat_key_result')!.ok, false);

    // Unsubscribing revokes it immediately.
    await h.router.handle(3, { t: 'agent_chat_unsubscribe', conversationId: CONVERSATION });
    await h.router.handle(3, { t: 'agent_chat_key', requestId: 'k3', conversationId: CONVERSATION, generation: 4, key: 'escape' });
    assert.equal(last(h.frames, 'agent_chat_key_result')!.ok, false);
  } finally { await h.dispose(); }
});

test('a listing reports this conversation as chattable through the real router', async () => {
  const h = await harness({ paged: false });
  try {
    await h.router.handle(3, { t: 'agent_chat_list', requestId: 'list' });
    const listed = last(h.frames, 'agent_chat_list_result')!;
    assert.equal(listed.conversations.length, 1);
    assert.deepEqual(
      { chat: listed.conversations[0]!.chat, provider: listed.conversations[0]!.provider, paneId: listed.conversations[0]!.paneId },
      { chat: true, provider: 'claude', paneId: 'wT:p1' },
    );
  } finally { await h.dispose(); }
});

test('a dropped connection releases its subscription, so later pages are refused', async () => {
  const h = await harness();
  try {
    await h.router.handle(3, { t: 'agent_chat_subscribe', requestId: 'sub', conversationId: CONVERSATION, generation: 8 });
    const cursor = last(h.frames, 'agent_chat_snapshot')!.earlierCursor!;
    h.router.dropClient(3);
    await h.router.handle(3, { t: 'agent_chat_earlier', requestId: 'gone', conversationId: CONVERSATION, generation: 8, cursor });
    assert.match(last(h.frames, 'agent_chat_earlier_result')!.error ?? '', /没有订阅/);
  } finally { await h.dispose(); }
});

test('the router ignores control messages that are not its own', async () => {
  const h = await harness({ paged: false });
  try {
    assert.equal(await h.router.handle(3, { t: 'session_list' }), false);
    assert.equal(await h.router.handle(3, { t: 'brain_snapshot' }), false);
    assert.equal(h.frames.length, 0);
  } finally { await h.dispose(); }
});

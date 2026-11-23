import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RealtimeConversationCallbacks, RealtimeTranscriptionCallbacks } from '@termbridge/voice';
import { SilentCall } from './silentCall.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture(execute: (text: string, signal: AbortSignal) => Promise<string> = async (text) => `result:${text}`) {
  const events: Array<[string, unknown]> = [];
  const streams: Array<{ cb: RealtimeTranscriptionCallbacks; closed: boolean; finished: boolean }> = [];
  const callbacks: RealtimeConversationCallbacks = {
    onReady: () => events.push(['ready', true]),
    onTranscript: (text) => events.push(['transcript', text]),
    onTurnSubmitted: (text) => events.push(['submitted', text]),
    onText: (text) => events.push(['answer', text]),
    onAudio: () => { throw new Error('Silent call must never produce audio'); },
    onResponseStarted: () => events.push(['started', true]),
    onResponseFinished: (status) => events.push(['done', status]),
    onError: (error) => events.push(['error', error.message]),
    onFinished: () => events.push(['closed', true]),
    onToolCall: async () => { throw new Error('No realtime model tool router'); },
  };
  const call = new SilentCall({ callbacks, execute, settleMs: 1, transcribe: (cb) => {
    const state = { cb, closed: false, finished: false };
    streams.push(state);
    queueMicrotask(() => cb.onReady?.());
    return { append() {}, commit() {}, finish() { state.finished = true; },
      close() { state.closed = true; } };
  } });
  const speech = (text: string) => {
    call.append(new Uint8Array(3200));
    const stream = streams.at(-1)!;
    call.commit();
    assert.equal(stream.finished, true);
    stream.cb.onText(text, true);
    stream.cb.onFinished();
  };
  return { call, streams, events, speech };
}

test('silent call: repeated speech -> advanced executor -> text, never audio; ASR sessions rotate', async () => {
  const f = fixture();
  try {
    await tick();
    f.speech('最近的 Agent');
    await tick();
    f.speech('继续执行');
    await tick();
    assert.deepEqual(f.events.filter(([t]) => t === 'answer').map(([, v]) => v), ['result:最近的 Agent', 'result:继续执行']);
    assert.equal(f.streams.length, 2);
    assert.equal(f.events.filter(([t]) => t === 'ready').length, 1);
  } finally { f.call.close(); }
});

test('silent call keeps listening while execution runs; queued speech executes sequentially', async () => {
  let resolve!: (answer: string) => void;
  let count = 0;
  const f = fixture(async (text) => ++count === 1 ? new Promise<string>((done) => { resolve = done; }) : text);
  try {
    await tick(); f.speech('first'); await tick();
    f.speech('second'); await tick();
    assert.equal(count, 1);
    assert.ok(f.events.some(([t, v]) => t === 'transcript' && v === 'second'));
    resolve('first done'); await tick();
    assert.equal(count, 2);
  } finally { f.call.close(); }
});

test('hangup aborts execution, releases recognition and suppresses late replies', async () => {
  let signal!: AbortSignal;
  let resolve!: (answer: string) => void;
  const f = fixture(async (_text, s) => { signal = s; return new Promise<string>((done) => { resolve = done; }); });
  await tick(); f.speech('work'); await tick();
  f.call.append(new Uint8Array(3200));
  f.call.close();
  assert.equal(signal.aborted, true);
  assert.equal(f.streams.at(-1)?.closed, true);
  resolve('late'); await tick();
  f.streams.at(-1)!.cb.onText('late transcript', true);
  assert.equal(f.events.filter(([t]) => t === 'answer').length, 0);
  assert.equal(f.events.filter(([t]) => t === 'closed').length, 1);
});

test('recognition failure closes instead of silently falling back to spoken realtime', async () => {
  const f = fixture(); await tick();
  f.streams[0].cb.onError(new Error('offline'));
  assert.equal(f.streams[0].closed, true);
  assert.ok(f.events.some(([t]) => t === 'error'));
  assert.ok(f.events.some(([t]) => t === 'closed'));
});

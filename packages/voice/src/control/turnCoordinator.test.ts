import assert from 'node:assert/strict';
import test from 'node:test';
import { TurnCoordinator, type TurnClock, type TurnDecision } from './turnCoordinator.js';
class Clock implements TurnClock {
  time = 0; sequence = 0; timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  later = (fn: () => void, ms: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  cancel = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) { this.time += ms; for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(id); timer.fn(); } }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
test('an empty ASR final cannot block the following complete question indefinitely', async () => {
  const clock = new Clock(), commits: string[] = [];
  const turn = new TurnCoordinator(async () => 'respond', text => commits.push(text), () => {}, clock);
  turn.speechStart('noise'); turn.speechStop('noise'); turn.transcript('noise', '');
  turn.speechStart('owner'); turn.transcript('owner', '现在有多少 Agent 在运行？'); turn.speechStop('owner', 1400);
  clock.advance(400); await settle();
  assert.deepEqual(commits, ['现在有多少 Agent 在运行？']);
  turn.close();
});
test('a late empty final releases only its own placeholder, never the active speech', async () => {
  const clock = new Clock(), commits: string[] = [];
  const turn = new TurnCoordinator(async () => 'respond', text => commits.push(text), () => {}, clock);
  turn.speechStart('noise'); turn.speechStop('noise');
  turn.speechStart('owner'); turn.transcript('owner', '帮我看看现在的任务');
  turn.transcript('noise', ''); clock.advance(9000); await settle();
  assert.equal(commits.length, 0);
  turn.speechStop('owner', 1400); clock.advance(400); await settle();
  assert.deepEqual(commits, ['帮我看看现在的任务']); turn.close();
});
test('not-addressed speech never dispatches or clarifies and next turn starts cleanly', async () => {
  const clock = new Clock(), commits: string[] = [], reasons: string[] = [];
  let questions = 0;
  const turn = new TurnCoordinator(async ({ segments }) => segments[0] === '和队友说话' ? 'ignore' : 'respond',
    text => commits.push(text), reason => reasons.push(reason), clock, () => { questions++; });
  turn.speechStart('a'); turn.transcript('a', '和队友说话'); turn.speechStop('a'); clock.advance(3000); await settle();
  clock.advance(10000); await settle();
  assert.equal(questions, 0); assert.equal(turn.pendingText, ''); assert.deepEqual(reasons, ['not_addressed']);
  turn.speechStart('b'); turn.transcript('b', '助手看看最新任务'); turn.speechStop('b'); clock.advance(3000); await settle();
  assert.deepEqual(commits, ['助手看看最新任务']); turn.close();
});
test('a pause is not submission; fragments/revisions commit once without rewriting', async () => {
  const clock = new Clock(); const commits: string[] = []; let calls = 0;
  const turn = new TurnCoordinator(async ({ segments }) => { calls++; return segments.length === 2 ? 'respond' : 'wait'; }, text => commits.push(text), () => {}, clock);
  turn.speechStart('a'); turn.speechStop('a'); turn.transcript('a', '我最近的');
  clock.advance(3000); await settle(); assert.equal(calls, 1); assert.equal(commits.length, 0);
  clock.advance(20_000); await settle(); assert.equal(calls, 1, 'unchanged context must not poll a paid model');
  turn.speechStart('b'); turn.transcript('b', 'Agent是什么'); turn.speechStop('b');
  clock.advance(3000); await settle(); assert.deepEqual(commits, ['我最近的 Agent是什么']);
  turn.transcript('a', '我最近的'); turn.transcript('b', 'Agent是什么');
  clock.advance(3000); await settle(); assert.equal(commits.length, 1);
});
test('new speech and hangup reject a late judge even if it ignores cancellation', async () => {
  const clock = new Clock(); const finish: ((value: TurnDecision) => void)[] = []; let commits = 0; const signals: AbortSignal[] = [];
  const turn = new TurnCoordinator(({ signal }) => { signals.push(signal); return new Promise(resolve => finish.push(resolve)); }, () => { commits++; }, () => {}, clock);
  turn.speechStart('a'); turn.transcript('a', '查一下正在运行的 Agent'); turn.speechStop('a'); clock.advance(2000);
  turn.speechStart('b'); finish[0]('respond'); await settle(); assert.equal(commits, 0); assert(signals[0].aborted);
  turn.transcript('b', '先别查'); turn.speechStop('b'); clock.advance(3000);
  turn.close(); finish[1]('respond'); await settle(); assert.equal(commits, 0);
  assert.equal(clock.timers.size, 0, 'hangup releases the deadline even if a judge ignores abort');
});

test('rejected interruption preserves the preceding thought; budget never becomes permission', async () => {
  const clock = new Clock(); const commits: string[] = []; const reasons: string[] = []; let calls = 0;
  const turn = new TurnCoordinator(async ({ segments }) => {
    calls++; return segments.at(-1) === '完成问题' ? 'respond' : 'wait';
  }, text => commits.push(text), reason => reasons.push(reason), clock);
  turn.speechStart('a'); turn.transcript('a', '我最近的'); turn.speechStop('a');
  clock.advance(3000); await settle();
  turn.speechStart('interruption'); turn.speechStop('interruption'); turn.rejectItem('interruption');
  turn.speechStart('b'); turn.transcript('b', '完成问题'); turn.speechStop('b');
  clock.advance(3000); await settle(); assert.deepEqual(commits, ['我最近的 完成问题']);
  for (let i = 0; i < 13; i++) {
    turn.speechStart(`new-${i}`); turn.transcript(`new-${i}`, '正在想问题'); turn.speechStop(`new-${i}`);
    clock.advance(3000); await settle();
  }
  assert.equal(calls, 12); assert(reasons.includes('budget')); assert.equal(commits.length, 1);
  turn.close(); assert.equal(clock.timers.size, 0);
});
test('late preceding ASR final is joined, but judge timeout never authorizes tools', async () => {
  const clock = new Clock(); let calls = 0; let reason = ''; let commits = 0;
  const turn = new TurnCoordinator(async () => { calls++; return new Promise(() => {}); }, () => { commits++; }, value => { reason = value; }, clock);
  turn.speechStart('a'); turn.speechStop('a'); turn.speechStart('b'); turn.transcript('b', 'Agent 是什么'); turn.speechStop('b');
  clock.advance(4000); assert.equal(calls, 0);
  turn.transcript('a', '我最近的'); clock.advance(1); assert.equal(calls, 1);
  clock.advance(3500); await settle(); clock.advance(250); clock.advance(3500); await settle();
  assert.equal(reason, 'judge_unavailable'); assert.equal(commits, 0); assert.equal(calls, 2); turn.close();
});

test('cancelled late ASR cannot resurrect a task and an expired thought does not capture a new topic', async () => {
  const clock = new Clock(); const seen: string[][] = []; const commits: string[] = [];
  const turn = new TurnCoordinator(async ({ segments }) => {
    seen.push([...segments]); return segments.at(-1) === '我最近的' ? 'wait' : 'respond';
  }, text => commits.push(text), () => {}, clock);
  turn.speechStart('cancelled'); turn.speechStop('cancelled'); turn.cancel();
  turn.transcript('cancelled', '这条已取消，不准执行'); clock.advance(4000); await settle();
  assert.equal(seen.length, 0); assert.equal(clock.timers.size, 0);
  turn.speechStart('unfinished'); turn.transcript('unfinished', '我最近的'); turn.speechStop('unfinished');
  clock.advance(3000); await settle(); clock.advance(31_000);
  turn.speechStart('new'); turn.transcript('new', '查询构建日志'); turn.speechStop('new');
  clock.advance(3000); await settle();
  assert.deepEqual(commits, ['查询构建日志']); assert.deepEqual(seen.at(-1), ['查询构建日志']);
  turn.close();
});

test('long incomplete pause asks once, spends no polling tokens, and keeps the original through clarification', async () => {
  const clock = new Clock(); const questions: string[] = []; const commits: string[] = [];
  const inputs: { segments: readonly string[]; clarification?: string }[] = [];
  const turn = new TurnCoordinator(async input => {
    inputs.push(input);
    return input.segments.length === 1 ? { decision: 'wait', clarification: '你想问最近的哪方面？' } : 'respond';
  }, text => commits.push(text), () => {}, clock, input => questions.push(input.question));
  turn.speechStart('a'); turn.transcript('a', '我最近的'); turn.speechStop('a');
  clock.advance(3000); await settle(); assert.equal(questions.length, 0);
  clock.advance(4999); assert.equal(questions.length, 0);
  clock.advance(1); assert.deepEqual(questions, ['你想问最近的哪方面？']);
  clock.advance(10_000); await settle(); assert.equal(questions.length, 1); assert.equal(inputs.length, 1);
  assert.equal(commits.length, 0, 'asking is not task authorization');
  turn.speechStart('b'); turn.transcript('b', 'Agent是什么'); turn.speechStop('b');
  clock.advance(3000); await settle();
  assert.deepEqual(commits, ['我最近的 Agent是什么']);
  assert.equal(inputs[1].clarification, questions[0]);
  turn.close(); assert.equal(clock.timers.size, 0);
});

test('continued speech, completed questions and hangup revoke the delayed clarification', async () => {
  for (const action of ['speech', 'complete', 'cancel', 'close'] as const) {
    const clock = new Clock(); let questions = 0;
    const turn = new TurnCoordinator(async ({ segments }) => segments.at(-1) === '完成问题' ? 'respond' : 'wait',
      () => {}, () => {}, clock, () => { questions++; });
    turn.speechStart('a'); turn.transcript('a', '我最近的'); turn.speechStop('a');
    clock.advance(3000); await settle();
    if (action === 'speech') turn.speechStart('b');
    if (action === 'complete') { turn.transcript('a', '完成问题'); clock.advance(3000); await settle(); }
    if (action === 'cancel') turn.cancel();
    if (action === 'close') turn.close();
    clock.advance(10_000); await settle(); assert.equal(questions, 0, action);
    turn.close(); assert.equal(clock.timers.size, 0);
  }
});

test('a communication check after clarification commits both raw fragments exactly once', async () => {
  const clock = new Clock(); const questions: string[] = []; const commits: string[] = [];
  const turn = new TurnCoordinator(async input => {
    if (input.segments.length === 1) return { decision: 'wait', clarification: '您想让我做什么呢？' };
    assert.deepEqual(input.segments, ['你现在在听', '在听我说话吗？']);
    assert.equal(input.clarification, questions[0]);
    assert.equal(input.clarificationAfterSegment, 1);
    return { decision: 'respond', intent: '确认交流是否正常' };
  }, text => commits.push(text), () => {}, clock, ({ question }) => questions.push(question));
  turn.speechStart('first'); turn.transcript('first', '你现在在听'); turn.speechStop('first');
  clock.advance(3000); await settle(); clock.advance(5000);
  assert.equal(questions.length, 1);
  turn.speechStart('second'); turn.transcript('second', '在听我说话吗？'); turn.speechStop('second');
  clock.advance(3000); await settle();
  assert.deepEqual(commits, ['你现在在听 在听我说话吗？']);
  clock.advance(9000); await settle(); assert.equal(questions.length, 1);
  turn.close(); assert.equal(clock.timers.size, 0);
});

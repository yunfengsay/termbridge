import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryTracker, DELIVERY_OBSERVE_WINDOW_MS, normalizePrompt } from './delivery.js';
import { mayResend } from './types.js';

function tracker(now = { value: 1_000 }) {
  return { clock: now, tracker: new DeliveryTracker('herdr:wA:p1', () => now.value) };
}

test('only a record written after the send cursor can confirm it', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '重跑测试', 500);
  sends.markDelivered('r1');
  // The same words appear earlier in history. That is not this send.
  assert.equal(sends.observe(120, '重跑测试', 'old'), undefined);
  const receipt = sends.observe(500, '重跑测试', 'new');
  assert.equal(receipt?.delivery.state, 'observed');
  assert.equal(receipt?.delivery.messageId, 'new');
  assert.equal(receipt?.clientId, 7);
  // The matcher is consumed: a later identical record confirms nothing.
  assert.equal(sends.observe(900, '重跑测试', 'later'), undefined);
  assert.equal(sends.size, 0);
});

test('a record written before the send cannot confirm it, whatever its offset', () => {
  // A file first found after the send gives no offset to compare against, so
  // the send's cursor is 0 and the record's own time has to decide.
  const { clock, tracker: sends } = tracker({ value: 1_000_000 });
  sends.accept('r1', 7, '继续', 0);
  assert.equal(sends.observe(40, '继续', 'old', clock.value - 60_000), undefined);
  // Within the rounding slack, and with no time at all, it still counts.
  assert.equal(sends.observe(80, '继续', 'new', clock.value - 1_500)?.delivery.state, 'observed');
  sends.accept('r2', 7, '继续', 0);
  assert.equal(sends.observe(120, '继续', 'untimed', null)?.delivery.requestId, 'r2');
});

test('abandoning settles every waiting send as uncertain with the reason', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '部署', 10);
  sends.markDelivered('r1');
  sends.accept('r2', 9, '回滚', 10);
  const settled = sends.abandon('记录不可用');
  assert.deepEqual(settled.map((outcome) => [outcome.clientId, outcome.delivery.requestId, outcome.delivery.state, outcome.delivery.error]),
    [[7, 'r1', 'uncertain', '记录不可用'], [9, 'r2', 'uncertain', '记录不可用']]);
  // Nothing is left to confirm or to report twice.
  assert.equal(sends.size, 0);
  assert.equal(sends.observe(20, '部署', 'm1'), undefined);
  assert.deepEqual(sends.abandon('再来一次'), []);
});

test('two identical prompts are confirmed once each, oldest first', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '继续', 100);
  sends.accept('r2', 7, '继续', 140);
  const first = sends.observe(150, '继续', 'm1');
  const second = sends.observe(190, '继续', 'm2');
  assert.equal(first?.delivery.requestId, 'r1');
  assert.equal(second?.delivery.requestId, 'r2');
  assert.equal(sends.observe(240, '继续', 'm3'), undefined);
});

test('each client is told only about its own send', () => {
  const { tracker: sends } = tracker();
  sends.accept('r-windows', 7, '部署', 10);
  sends.accept('r-phone', 9, '回滚', 10);
  assert.equal(sends.observe(20, '回滚', 'm1')?.clientId, 9);
  assert.equal(sends.observe(30, '部署', 'm2')?.clientId, 7);
});

test('a disconnected client stops being matched', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '继续', 10);
  sends.dropClient(7);
  assert.equal(sends.observe(20, '继续', 'm1'), undefined);
});

test('an unknown write outcome is never presented as resendable', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '继续', 10);
  const uncertain = sends.markUncertain('r1', 'Herdr 未返回结果')!;
  assert.equal(uncertain.delivery.state, 'uncertain');
  assert.equal(mayResend(uncertain.delivery), false);
  assert.equal(sends.observe(20, '继续', 'm1'), undefined);

  sends.accept('r2', 7, '继续', 10);
  const failed = sends.markFailed('r2', '这个连接没有订阅该会话')!;
  assert.equal(failed.delivery.state, 'failed');
  assert.equal(mayResend(failed.delivery), true);
});

test('the receipt chain reports accepted then delivered, and delivered only once', () => {
  const { tracker: sends } = tracker();
  assert.equal(sends.accept('r1', 7, '继续', 10).delivery.state, 'accepted');
  assert.equal(sends.markDelivered('r1')?.delivery.state, 'delivered');
  assert.equal(sends.markDelivered('r1'), undefined);
  assert.equal(sends.markFailed('unknown-request', 'x'), undefined);
});

test('losing the ability to confirm a send is reported, never left pending forever', () => {
  const clock = { value: 1_000 };
  const { tracker: sends } = tracker(clock);
  sends.accept('r1', 7, '继续', 10);
  sends.markDelivered('r1');
  clock.value += DELIVERY_OBSERVE_WINDOW_MS + 1;
  assert.equal(sends.observe(20, '继续', 'm1'), undefined);
  const expired = sends.expire();
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.clientId, 7);
  assert.equal(expired[0]!.delivery.state, 'uncertain');
  assert.equal(expired[0]!.delivery.requestId, 'r1');
  assert.match(expired[0]!.delivery.error ?? '', /确认窗口/);
  // The state is terminal and the client must not resend it on its own.
  assert.equal(mayResend(expired[0]!.delivery), false);
  assert.equal(sends.size, 0);
  // Expiring again reports nothing: a receipt is emitted exactly once.
  assert.deepEqual(sends.expire(), []);

  const rewound = (() => {
    sends.accept('r2', 7, '继续', 10);
    sends.accept('r3', 9, '另一条', 10);
    return sends.resetForRewind();
  })();
  assert.deepEqual(rewound.map((o) => [o.clientId, o.delivery.requestId, o.delivery.state]),
    [[7, 'r2', 'uncertain'], [9, 'r3', 'uncertain']]);
  assert.match(rewound[0]!.delivery.error ?? '', /轮转或截断/);
  assert.equal(sends.observe(20, '继续', 'm2'), undefined);
  assert.equal(sends.size, 0);
  assert.deepEqual(sends.resetForRewind(), []);
});

test('a send still inside its window is left alone by expiry', () => {
  const clock = { value: 1_000 };
  const { tracker: sends } = tracker(clock);
  sends.accept('r1', 7, '继续', 10);
  clock.value += DELIVERY_OBSERVE_WINDOW_MS - 1;
  assert.deepEqual(sends.expire(), []);
  assert.equal(sends.size, 1);
  // At the boundary it is still confirmable; one tick past it is not.
  assert.equal(sends.observe(20, '继续', 'm1')?.delivery.state, 'observed');

  sends.accept('r2', 7, '继续', 10);
  clock.value += DELIVERY_OBSERVE_WINDOW_MS + 1;
  assert.equal(sends.expire().length, 1);
});

test('a disconnected client is dropped quietly — nobody is left to receive a receipt', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '继续', 10);
  sends.dropClient(7);
  assert.deepEqual(sends.expire(), []);
  assert.deepEqual(sends.resetForRewind(), []);
});

test('prompt normalization tolerates line endings and trailing spaces only', () => {
  assert.equal(normalizePrompt('一行  \r\n二行\t\n'), '一行\n二行');
  assert.notEqual(normalizePrompt('继续 实现'), normalizePrompt('继续实现'));
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '第一行\r\n第二行  ', 0);
  assert.equal(sends.observe(5, '第一行\n第二行', 'm1')?.delivery.state, 'observed');
});

test('a substring or superstring of the prompt never confirms it', () => {
  const { tracker: sends } = tracker();
  sends.accept('r1', 7, '部署到生产', 0);
  assert.equal(sends.observe(5, '部署', 'm1'), undefined);
  assert.equal(sends.observe(6, '部署到生产环境', 'm2'), undefined);
  assert.equal(sends.observe(7, '部署到生产', 'm3')?.delivery.state, 'observed');
});

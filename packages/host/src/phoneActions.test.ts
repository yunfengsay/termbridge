import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPhoneActionEvent,
  phoneActionEventFromStatus,
  phoneActionEventView,
  phoneActionFromToolCall,
  phonePhotoEditWorkerTask,
  phoneActionSystemEvent,
} from './phoneActions.js';

test('rebuilds a deterministic completion event from a durable phone result', () => {
  const origin = { requestId: 'request-1', callId: 'call-1', toolResultId: 'tool-1' };
  const status = {
    actionId: 'phone-tool-1',
    action: 'calendar.list',
    state: 'completed',
    summary: '已读取 1 个日历事件',
    events: [{ eventId: '298', title: '教师节' }],
  };
  const event = phoneActionEventFromStatus(origin, 'samsung', status, 123);
  assert.equal(event?.state, 'completed');
  assert.equal(event?.deviceId, 'samsung');
  assert.deepEqual(event?.data, { events: status.events });
  assert.equal(event?.eventId, phoneActionEventFromStatus(origin, 'samsung', status, 456)?.eventId);
  assert.equal(isPhoneActionEvent(event), true);
});

test('rejects malformed recovered phone results', () => {
  const origin = { requestId: 'request-1', callId: 'call-1', toolResultId: 'tool-1' };
  assert.equal(phoneActionEventFromStatus(origin, 'samsung', {
    actionId: 'phone-tool-1', action: 'calendar.list', state: 'made_up', summary: 'bad',
  }), undefined);
});

test('normalizes MessagePack bigint values before persisting recovered phone results', () => {
  const event = phoneActionEventFromStatus(
    { requestId: 'request-1', callId: 'call-1', toolResultId: 'tool-1' },
    'samsung',
    {
      actionId: 'phone-tool-1',
      action: 'calendar.create',
      state: 'denied',
      summary: 'missing permission',
      updatedAt: 1_725_399_944_000n,
      providerId: 9_007_199_254_740_993n,
      nested: [{ count: 2n }],
    },
    123,
  );
  assert.deepEqual(event?.data, {
    updatedAt: 1_725_399_944_000,
    providerId: '9007199254740993',
    nested: [{ count: 2 }],
  });
  assert.doesNotThrow(() => JSON.stringify(event));
});

test('photo edit requests support an explicit bounded multi-selection', () => {
  assert.deepEqual(phoneActionFromToolCall({
    callId: 'photo',
    name: 'phone_action',
    arguments: {
      action: 'photo.edit',
      instructions: '提高亮度并去掉路人',
      maxItems: 12,
    },
  }), {
    action: 'photo.edit',
    instructions: '提高亮度并去掉路人',
    maxItems: 3,
  });
  assert.equal(phoneActionFromToolCall({
    callId: 'photo', name: 'phone_action',
    arguments: { action: 'photo.edit', instructions: '统一调色', maxItems: 999 },
  }).maxItems, 3);
});

test('photo count and fetch expose bounded metadata and content contracts', () => {
  assert.deepEqual(phoneActionFromToolCall({
    callId: 'photo-count',
    name: 'phone_action',
    arguments: {
      action: 'photo.count',
      startsAt: '2026-09-04T00:00:00+08:00',
      endsAt: '2026-09-05T00:00:00+08:00',
    },
  }), {
    action: 'photo.count',
    startsAt: '2026-09-04T00:00:00+08:00',
    endsAt: '2026-09-05T00:00:00+08:00',
    collection: 'camera',
  });
  assert.deepEqual(phoneActionFromToolCall({
    callId: 'photo-fetch',
    name: 'phone_action',
    arguments: {
      action: 'photo.fetch',
      startsAt: '2026-09-01T00:00:00+08:00',
      endsAt: '2026-09-05T00:00:00+08:00',
      collection: 'all',
      instructions: '按旅行地点整理并给出三张照片的摘要',
      maxItems: 50,
    },
  }), {
    action: 'photo.fetch',
    startsAt: '2026-09-01T00:00:00+08:00',
    endsAt: '2026-09-05T00:00:00+08:00',
    instructions: '按旅行地点整理并给出三张照片的摘要',
    collection: 'all',
    maxItems: 3,
  });
  assert.throws(() => phoneActionFromToolCall({
    callId: 'photo-fetch-wide',
    name: 'phone_action',
    arguments: {
      action: 'photo.fetch',
      startsAt: '2026-01-01T00:00:00+08:00',
      endsAt: '2026-09-05T00:00:00+08:00',
      instructions: '整理',
    },
  }), /cannot exceed 31 days/);
  assert.throws(() => phoneActionFromToolCall({
    callId: 'photo-count-local-time',
    name: 'phone_action',
    arguments: {
      action: 'photo.count',
      startsAt: '2026-09-04T00:00:00',
      endsAt: '2026-09-05T00:00:00',
    },
  }), /explicit offsets/);
});

test('speaker route action requires one explicit boolean and remains JSON safe', () => {
  assert.deepEqual(phoneActionFromToolCall({
    callId: 'speaker-on', name: 'phone_action', arguments: { action: 'call.speaker.set', enabled: true },
  }), { action: 'call.speaker.set', enabled: true });
  assert.throws(() => phoneActionFromToolCall({
    callId: 'speaker-missing', name: 'phone_action', arguments: { action: 'call.speaker.set' },
  }), /enabled is required/);
});

test('phone actions reject incomplete or overly broad mutations', () => {
  assert.throws(() => phoneActionFromToolCall({
    callId: 'photo', name: 'phone_action', arguments: { action: 'photo.edit' },
  }), /instructions is required/);
  assert.throws(() => phoneActionFromToolCall({
    callId: 'calendar', name: 'phone_action', arguments: { action: 'calendar.update', eventId: '42' },
  }), /changed field/);
  assert.throws(() => phoneActionFromToolCall({
    callId: 'unknown', name: 'phone_action', arguments: { action: 'photo.read_all' },
  }), /Unsupported phone action/);
});

test('calendar creation derives a bounded default end when the user only gives a start time', () => {
  assert.deepEqual(phoneActionFromToolCall({
    callId: 'calendar-create',
    name: 'phone_action',
    arguments: {
      action: 'calendar.create',
      title: '给苏和加灰度权限',
      startsAt: '2026-09-04T10:00:00+08:00',
    },
  }), {
    action: 'calendar.create',
    title: '给苏和加灰度权限',
    startsAt: '2026-09-04T10:00:00+08:00',
    endsAt: '2026-09-04T02:30:00.000Z',
  });

  assert.equal(phoneActionFromToolCall({
    callId: 'calendar-create-long',
    name: 'phone_action',
    arguments: {
      action: 'calendar.create',
      title: '方案评审',
      startsAt: '2026-09-04T10:00:00+08:00',
      durationMinutes: 90,
    },
  }).endsAt, '2026-09-04T03:30:00.000Z');
});

test('phone photo selection becomes a compact native card and trusted realtime event', () => {
  const event = {
    eventId: 'event-1',
    actionId: 'action-1',
    requestId: 'request-1',
    callId: 'call-1',
    toolResultId: 'tool-1',
    deviceId: 'device-1234567890',
    action: 'photo.edit' as const,
    state: 'running' as const,
    summary: '已选择 3 张照片',
    createdAt: 42,
    data: { selectedCount: 3, assets: [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }] },
  };
  assert.equal(isPhoneActionEvent(event), true);
  assert.equal(phoneActionEventView(event).items[0]?.status, 'running');
  assert.match(phoneActionEventView(event).items[0]?.detail || '', /3 photos/);
  assert.match(phoneActionSystemEvent(event), /trusted Host notification/);
  assert.match(phoneActionSystemEvent(event), /never claim the photos were edited/i);
  assert.match(phoneActionSystemEvent(event), /device-1234567890/);
  assert.match(phoneActionSystemEvent(event), /tb peer photo publish/);
});

test('a selected multi-photo batch becomes one bounded worker task', () => {
  const task = phonePhotoEditWorkerTask({
    eventId: 'event-2',
    actionId: 'action-2',
    requestId: 'request-2',
    callId: 'call-2',
    toolResultId: 'tool-2',
    deviceId: 'phone-2',
    action: 'photo.edit',
    state: 'running',
    summary: '已选择 2 张照片',
    createdAt: 43,
    data: {
      instructions: '统一调成冷色调',
      assets: [
        { assetId: 'asset-a', name: 'a.jpg', mime: 'image/jpeg' },
        { assetId: 'asset-b', name: 'b.png', mime: 'image/png' },
      ],
    },
  });
  assert.match(task || '', /统一调成冷色调/);
  assert.match(task || '', /asset-a/);
  assert.match(task || '', /asset-b/);
  assert.match(task || '', /tb peer photo pull/);
  assert.match(task || '', /tb peer photo publish/);
  assert.equal(phonePhotoEditWorkerTask({
    eventId: 'event-3', actionId: 'action-3', requestId: 'request-3', callId: 'call-3',
    toolResultId: 'tool-3', deviceId: 'phone-3', action: 'photo.edit', state: 'completed',
    summary: 'done', createdAt: 44,
  }), undefined);
});

test('an automatic photo grant uses the same bounded encrypted worker path', () => {
  const task = phonePhotoEditWorkerTask({
    eventId: 'event-fetch', actionId: 'action-fetch', requestId: 'request-fetch', callId: 'call-fetch',
    toolResultId: 'tool-fetch', deviceId: 'phone-fetch', action: 'photo.fetch', state: 'running',
    summary: '已读取 3 张照片', createdAt: 45,
    data: {
      instructions: '为新加坡旅行整理内容',
      assets: [
        { assetId: 'asset-1', name: '1.jpg', mime: 'image/jpeg' },
        { assetId: 'asset-2', name: '2.jpg', mime: 'image/jpeg' },
        { assetId: 'asset-3', name: '3.jpg', mime: 'image/jpeg' },
        { assetId: 'asset-4', name: '4.jpg', mime: 'image/jpeg' },
      ],
    },
  });
  assert.match(task || '', /bounded photos granted by the user/i);
  assert.doesNotMatch(task || '', /asset-4/);
  assert.match(task || '', /tb peer photo pull/);
  assert.match(task || '', /analysis-only work does not publish/i);
});

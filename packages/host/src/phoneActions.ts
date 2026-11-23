import { createHash } from 'node:crypto';
import type { RealtimeToolCall } from '@termbridge/voice';
import type { VoiceToolView } from './voiceTools.js';
import { jsonSafeValue } from './jsonSafe.js';

export const PHONE_ACTIONS = [
  'alarm.create',
  'calendar.list',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'todo.list',
  'todo.create',
  'todo.update',
  'todo.complete',
  'todo.delete',
  'photo.count',
  'photo.fetch',
  'photo.edit',
  'call.speaker.set',
  'screen.capture',
] as const;

export type PhoneActionName = typeof PHONE_ACTIONS[number];

export interface PhoneActionRequest {
  action: PhoneActionName;
  deviceId?: string;
  title?: string;
  notes?: string;
  description?: string;
  location?: string;
  scheduledAt?: string;
  startsAt?: string;
  endsAt?: string;
  dueAt?: string;
  eventId?: string;
  todoId?: string;
  repeatDays?: string[];
  instructions?: string;
  collection?: 'camera' | 'all' | 'screenshots';
  maxItems?: number;
  enabled?: boolean;
}

export interface PhoneActionEvent {
  eventId: string;
  actionId: string;
  requestId: string;
  callId: string;
  toolResultId: string;
  deviceId: string;
  action: PhoneActionName;
  state: 'awaiting_user' | 'running' | 'completed' | 'denied' | 'failed' | 'cancelled' | 'expired';
  summary: string;
  createdAt: number;
  data?: Record<string, unknown>;
  error?: string;
}

export interface PhoneActionRecoveryOrigin {
  requestId: string;
  callId: string;
  toolResultId: string;
}

/** Rebuild a normal Host event from the phone's durable result after a lost push event. */
export function phoneActionEventFromStatus(
  origin: PhoneActionRecoveryOrigin,
  deviceId: string,
  status: Record<string, unknown>,
  now = Date.now(),
): PhoneActionEvent | undefined {
  const actionId = boundedString(status.actionId, 128);
  const action = boundedString(status.action, 64) as PhoneActionName;
  const state = boundedString(status.state, 64) as PhoneActionEvent['state'];
  const summary = boundedString(status.summary, 1_000);
  const error = boundedString(status.error, 1_000) || undefined;
  const states: PhoneActionEvent['state'][] = [
    'awaiting_user', 'running', 'completed', 'denied', 'failed', 'cancelled', 'expired',
  ];
  if (!actionId || !PHONE_ACTIONS.includes(action) || !states.includes(state) || !summary) return undefined;
  // MessagePack decodes Android's integral values as bigint. Everything after
  // this boundary is persisted as JSON (Brain state and realtime events), so
  // normalize the entire payload once instead of letting a harmless count or
  // timestamp make recovery fail before the phone result is acknowledged.
  const data = Object.fromEntries(Object.entries(status)
    .filter(([key]) => !['actionId', 'action', 'state', 'summary', 'error'].includes(key))
    .map(([key, value]) => [key, jsonSafeValue(value)]));
  const digest = createHash('sha256')
    .update(JSON.stringify({ actionId, action, state, summary, data, error }))
    .digest('hex')
    .slice(0, 32);
  return {
    eventId: `phone-recovery-${digest}`,
    actionId,
    requestId: origin.requestId,
    callId: origin.callId,
    toolResultId: origin.toolResultId,
    deviceId,
    action,
    state,
    summary,
    createdAt: now,
    ...(Object.keys(data).length > 0 ? { data } : {}),
    ...(error ? { error } : {}),
  };
}

export function phoneActionFromToolCall(call: RealtimeToolCall): PhoneActionRequest {
  const action = stringValue(call.arguments.action);
  if (!PHONE_ACTIONS.includes(action as PhoneActionName)) {
    throw new Error(`Unsupported phone action ${action || '(missing)'}`);
  }
  const request: PhoneActionRequest = {
    action: action as PhoneActionName,
    ...optionalStringFields(call.arguments, [
      'deviceId', 'title', 'notes', 'description', 'location', 'scheduledAt', 'startsAt', 'endsAt',
      'dueAt', 'eventId', 'todoId', 'instructions',
    ]),
  };
  const repeatDays = Array.isArray(call.arguments.repeatDays)
    ? call.arguments.repeatDays.map(stringValue).filter(Boolean)
    : [];
  if (repeatDays.length > 0) {
    const allowed = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
    if (repeatDays.some((day) => !allowed.has(day))) throw new Error('repeatDays contains an invalid weekday');
    request.repeatDays = [...new Set(repeatDays)].slice(0, 7);
  }
  if (request.action === 'photo.edit' || request.action === 'photo.fetch') {
    request.maxItems = integerValue(call.arguments.maxItems, MAX_PHOTO_ITEMS, 1, MAX_PHOTO_ITEMS);
  }
  if (request.action === 'photo.count' || request.action === 'photo.fetch') {
    const collection = stringValue(call.arguments.collection) || 'camera';
    if (!PHOTO_COLLECTIONS.includes(collection as PhoneActionRequest['collection'])) {
      throw new Error('collection must be camera, all, or screenshots');
    }
    request.collection = collection as PhoneActionRequest['collection'];
  }
  if (request.action === 'call.speaker.set') {
    if (typeof call.arguments.enabled !== 'boolean') throw new Error('enabled is required');
    request.enabled = call.arguments.enabled;
  }
  if (request.action === 'calendar.create' && request.startsAt && !request.endsAt) {
    request.endsAt = calendarEndTime(
      request.startsAt,
      integerValue(call.arguments.durationMinutes, DEFAULT_CALENDAR_DURATION_MINUTES, 5, 24 * 60),
    );
  }
  validateRequiredFields(request);
  return request;
}

export function phoneActionView(result: Record<string, unknown>): VoiceToolView | undefined {
  const actionId = boundedString(result.actionId, 128);
  const action = boundedString(result.action, 64);
  if (!actionId || !action) return undefined;
  const state = boundedString(result.state, 64) || 'awaiting_user';
  const summary = boundedString(result.summary, 600) || actionLabel(action as PhoneActionName);
  const outputs = numberValue(result.outputCount);
  const count = numberValue(result.count);
  const selected = Array.isArray(result.assets) ? result.assets.length : numberValue(result.selectedCount);
  const detail = outputs > 0 ? `${summary} · ${outputs} outputs`
    : selected > 0 ? `${summary} · ${selected} photos`
      : action === 'photo.count' ? `${summary} · ${count} photos` : summary;
  return {
    kind: 'receipt',
    title: action.startsWith('photo.') ? 'Photos' : 'Phone action',
    items: [{
      id: actionId,
      title: actionLabel(action as PhoneActionName),
      detail,
      status: state,
    }],
  };
}

export function phoneActionEventView(event: PhoneActionEvent): VoiceToolView {
  return phoneActionView({
    ...(event.data ?? {}),
    actionId: event.actionId,
    deviceId: event.deviceId,
    action: event.action,
    state: event.state,
    summary: phoneActionOutcomeSummary(event),
  })!;
}

function phoneActionOutcomeSummary(event: PhoneActionEvent): string {
  if (event.error) return event.error;
  return event.action === 'alarm.create' && event.state === 'completed'
    ? '已收到你的确认，并已打开系统时钟。点击闹钟卡片可查看；是否已保存以时钟应用为准。'
    : event.summary;
}

export function phoneActionSystemEvent(event: PhoneActionEvent): string {
  const data = JSON.stringify({
    actionId: event.actionId,
    deviceId: event.deviceId,
    action: event.action,
    state: event.state,
    summary: phoneActionOutcomeSummary(event),
    ...(event.data ? { data: event.data } : {}),
    ...(event.error ? { error: event.error } : {}),
  }).slice(0, 12_000);
  return [
    '<termbridge_system_event type="phone_action">',
    'This is a trusted Host notification, not literal user speech. Briefly report the phone action outcome. If data.worker is present, the Host already dispatched the photo worker: do not call dispatch_agent again. Otherwise, if photo assetIds and instructions are present, dispatch an appropriate registered worker Agent. Its task must pull every granted asset with tb peer photo pull and perform only the requested inspection or edit. It must publish with tb peer photo publish only when the user requested image outputs. Never claim the photos were edited or processing completed merely because access was granted.',
    data,
    '</termbridge_system_event>',
  ].join('\n');
}

export function phonePhotoEditWorkerTask(event: PhoneActionEvent): string | undefined {
  if (!['photo.edit', 'photo.fetch'].includes(event.action) || event.state !== 'running' || !event.data) return undefined;
  const assets = Array.isArray(event.data.assets) ? event.data.assets.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Record<string, unknown>;
    const assetId = boundedString(value.assetId, 128);
    if (!assetId) return [];
    return [{
      assetId,
      name: boundedString(value.name, 160) || assetId,
      mime: boundedString(value.mime, 128) || 'image/*',
    }];
  }).slice(0, MAX_PHOTO_ITEMS) : [];
  const instructions = boundedString(event.data.instructions, 4_000);
  if (assets.length === 0 || !instructions) return undefined;
  return [
    event.action === 'photo.fetch'
      ? 'Process the bounded photos granted by the user from their Android library.'
      : 'Edit the photos explicitly selected by the user on their Android phone.',
    `Requested work: ${instructions}`,
    `Phone action: ${JSON.stringify({ actionId: event.actionId, deviceId: event.deviceId, assets })}`,
    'For every asset, run `tb peer photo pull <action-id> <asset-id> <local-output> --device <device-id>`.',
    'Inspect or edit every pulled photo according to the request. Never access any other phone media.',
    event.action === 'photo.edit'
      ? 'Publish all edited outputs in one batch with `tb peer photo publish <action-id> <edited-file...> --device <device-id>`.'
      : 'If the user requested edited image outputs, publish them in one batch with `tb peer photo publish <action-id> <edited-file...> --device <device-id>`; analysis-only work does not publish.',
    'Do not report an edit as complete until the publish command confirms the full batch reached the Android gallery.',
  ].join('\n');
}

export function isPhoneActionEvent(value: unknown): value is PhoneActionEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PhoneActionEvent>;
  return Boolean(
    boundedString(event.eventId, 160)
    && boundedString(event.actionId, 128)
    && boundedString(event.requestId, 128)
    && boundedString(event.callId, 128)
    && boundedString(event.toolResultId, 128)
    && boundedString(event.deviceId, 128)
    && PHONE_ACTIONS.includes(event.action as PhoneActionName)
    && ['awaiting_user', 'running', 'completed', 'denied', 'failed', 'cancelled', 'expired'].includes(event.state || '')
    && boundedString(event.summary, 1_000)
    && typeof event.createdAt === 'number'
    && Number.isSafeInteger(event.createdAt)
    && event.createdAt >= 0
  );
}

function validateRequiredFields(request: PhoneActionRequest): void {
  switch (request.action) {
    case 'alarm.create':
      requireField(request.scheduledAt, 'scheduledAt');
      break;
    case 'calendar.list':
      requireField(request.startsAt, 'startsAt');
      requireField(request.endsAt, 'endsAt');
      break;
    case 'calendar.create':
      requireField(request.title, 'title');
      requireField(request.startsAt, 'startsAt');
      requireField(request.endsAt, 'endsAt');
      break;
    case 'calendar.update':
      requireField(request.eventId, 'eventId');
      if (!request.title && !request.description && !request.location && !request.startsAt && !request.endsAt) {
        throw new Error('calendar.update needs at least one changed field');
      }
      break;
    case 'calendar.delete':
      requireField(request.eventId, 'eventId');
      break;
    case 'todo.create':
      requireField(request.title, 'title');
      break;
    case 'todo.update':
      requireField(request.todoId, 'todoId');
      if (!request.title && !request.notes && !request.dueAt) {
        throw new Error('todo.update needs at least one changed field');
      }
      break;
    case 'todo.complete':
    case 'todo.delete':
      requireField(request.todoId, 'todoId');
      break;
    case 'photo.edit':
      requireField(request.instructions, 'instructions');
      break;
    case 'photo.count':
      validatePhotoWindow(request);
      break;
    case 'photo.fetch':
      validatePhotoWindow(request);
      requireField(request.instructions, 'instructions');
      break;
    case 'call.speaker.set':
      if (typeof request.enabled !== 'boolean') throw new Error('enabled is required');
      break;
    case 'todo.list':
      break;
  }
}

function actionLabel(action: PhoneActionName): string {
  switch (action) {
    case 'alarm.create': return 'Create alarm';
    case 'calendar.list': return 'Read calendar window';
    case 'calendar.create': return 'Create calendar event';
    case 'calendar.update': return 'Update calendar event';
    case 'calendar.delete': return 'Delete calendar event';
    case 'todo.list': return 'Read to-dos';
    case 'todo.create': return 'Create to-do';
    case 'todo.update': return 'Update to-do';
    case 'todo.complete': return 'Complete to-do';
    case 'todo.delete': return 'Delete to-do';
    case 'photo.count': return 'Count photos in a time window';
    case 'photo.fetch': return 'Fetch a bounded photo batch';
    case 'photo.edit': return 'Select photos to edit';
    case 'call.speaker.set': return 'Change Voice Call speaker output';
    case 'screen.capture': return 'Capture current phone screen';
  }
}

function optionalStringFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = boundedString(source[field], field === 'instructions' ? 4_000 : 1_000);
    if (value) result[field] = value;
  }
  return result;
}

function requireField(value: string | undefined, name: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)
    : '';
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function calendarEndTime(startsAt: string, durationMinutes: number): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(startsAt)) {
    throw new Error('startsAt must be ISO 8601 with an explicit offset');
  }
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) throw new Error('startsAt must be a valid ISO 8601 time');
  return new Date(start + durationMinutes * 60_000).toISOString();
}

function validatePhotoWindow(request: PhoneActionRequest): void {
  requireField(request.startsAt, 'startsAt');
  requireField(request.endsAt, 'endsAt');
  if (![request.startsAt!, request.endsAt!].every((value) => /(?:Z|[+-]\d{2}:\d{2})$/u.test(value))) {
    throw new Error('photo time window must use ISO 8601 times with explicit offsets');
  }
  const start = Date.parse(request.startsAt!);
  const end = Date.parse(request.endsAt!);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('photo time window must contain valid ISO 8601 times with endsAt after startsAt');
  }
  if (end - start > MAX_PHOTO_WINDOW_MS) throw new Error('photo time window cannot exceed 31 days');
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

const DEFAULT_CALENDAR_DURATION_MINUTES = 30;
const MAX_PHOTO_ITEMS = 3;
const MAX_PHOTO_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const PHOTO_COLLECTIONS: Array<PhoneActionRequest['collection']> = ['camera', 'all', 'screenshots'];

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { desktopGeometry, sourcePoint, zoomAround } from './geometry.js';
import { DesktopRequests } from './rfbRequests.js';

/** Exercise the production viewer, including native-dialog blur, without touching a real desktop. */
function fixture(animationFrames = true) {
  const nodes = new Map<string, any>(), events = new Map<string, Function>();
  const messages: any[] = [], sent: number[][] = [], viewers: any[] = [];
  const intervals = new Map<number, Function>(); let alpha = 0;
  const timers = new Map<number, Function>(); let timer = 0, sequence = 0;
  function element(id: string) {
    if (!nodes.has(id)) nodes.set(id, { clientWidth: 412, clientHeight: 700, style: { setProperty() {} },
      classList: { toggle() {} }, textContent: '', value: '', addEventListener(type: string, fn: Function) { events.set(`${id}:${type}`, fn); }, replaceChildren() {},
      querySelector() { return { width: 1280, height: 720, getContext() { return { getImageData() { return { data: [0, 0, 0, alpha] }; } }; } }; }, setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 412, height: 700 }; } });
    return nodes.get(id);
  }
  class RFB {
    listeners = new Map<string, Function>(); keys: any[] = []; credentials: any;
    constructor() { viewers.push(this); }
    addEventListener(type: string, listener: Function) { this.listeners.set(type, listener); }
    emit(type: string, detail: any = {}) { this.listeners.get(type)?.({ detail }); }
    disconnect() { this.emit('disconnect'); }
    sendCredentials(value: any) { this.credentials = value; }
    sendKey(...args: any[]) { this.keys.push(args); }
    focus() {}
  }
  const window: any = { DesktopNative: { postMessage(raw: string) { messages.push(JSON.parse(raw)); } }, addEventListener(type: string, fn: Function) { events.set(type, fn); } };
  const context = vm.createContext({ window, document: { getElementById: element, createElement: element,
    body: element('body'), documentElement: element('root'), addEventListener() {} }, RFB,
    openDesktop: async () => ({ open: { t: 'desktop_open', id: `request-${++sequence}` }, finish: async () => ({
      async seal(bytes: Uint8Array) { sent.push([...bytes]); return { t: 'desktop_data' }; },
      async open(message: any) { return message.bytes; }, close() {},
    }) }), MutationObserver: class { observe() {} },
    setTimeout(fn: Function) { timers.set(++timer, fn); return timer; }, clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: Function) { intervals.set(++timer, fn); return timer; }, clearInterval(id: number) { intervals.delete(id); }, requestAnimationFrame(fn: Function) { if (animationFrames) fn(); return 1; }, cancelAnimationFrame() {},
    TextEncoder, TextDecoder, Uint8Array, console, desktopGeometry, sourcePoint, zoomAround, DesktopRequests });
  const source = readFileSync(new URL('./viewer.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  async function connect() {
    await window.Desktop.start({});
    const id = messages.filter(m => m.t === 'desktop_open').at(-1).id;
    window.Desktop.receive({ t: 'desktop_ready', id }); await flush();
    window.Desktop.receive({ t: 'desktop_data', id, bytes: new Uint8Array([1, ...new TextEncoder().encode(JSON.stringify({ event: 'backend', mode: 'system' }))]) }); await flush();
    viewers.at(-1).emit('credentialsrequired', { types: ['username', 'password'] });
    return id;
  }
  return { window, messages, sent, viewers, events, element, connect, flush, timers, intervals, paint() { alpha = 255; } };
}

test('desktop toolbar zoom and Option-scroll preserve pointer coordinates without remote scrolling', async () => {
  const f = fixture(); await f.connect(); f.viewers[0].emit('connect');
  f.window.Desktop.ui({ action: 'zoom', value: 200 });
  await f.flush();
  assert.equal(f.messages.filter(m => m.t === 'desktop_state').at(-1).zoom, 200);
  const before = f.sent.length;
  f.events.get('touch:wheel')!({ preventDefault() {}, altKey: true, deltaX: 40, deltaY: 0 });
  f.element('touch').onpointerdown({ pointerType: 'mouse', pointerId: 1, button: 0, clientX: 206, clientY: 350, preventDefault() {} });
  f.element('touch').onpointerup({ pointerType: 'mouse', pointerId: 1, button: 0, clientX: 206, clientY: 350 });
  await f.flush();
  const pointers = f.sent.slice(before).filter(p => p[0] === 0 && p[1] === 5);
  assert.equal(pointers.length, 2, 'Panning the local viewport must not send scroll buttons to the Mac');
  assert.deepEqual(pointers.map(p => p[2]), [1, 0]);
  const initial = desktopGeometry(1280, 720, 412, 700);
  const zoomed = zoomAround(initial, 2, 206, 350);
  const panned = desktopGeometry(1280, 720, 412, 700, 2, zoomed.panX - 40, zoomed.panY);
  const expected = sourcePoint(panned, 206, 350)!;
  assert.equal((pointers[0][3] << 8) | pointers[0][4], expected.x);
  assert.equal((pointers[0][5] << 8) | pointers[0][6], expected.y);
  f.window.Desktop.disconnected('fixture: port refused');
  assert.equal(f.element('status').textContent, 'fixture: port refused');
});

test('native state stays current when an occluded WebView suspends animation frames', async () => {
  const f = fixture(false); await f.connect();
  f.viewers[0].emit('connect'); f.paint();
  for (const poll of [...f.intervals.values()]) poll();
  await f.flush();
  assert.equal(f.messages.filter(m => m.t === 'desktop_state').at(-1)?.connected, true);
  f.window.Desktop.disconnected('fixture failure'); await f.flush();
  const state = f.messages.filter(m => m.t === 'desktop_state').at(-1);
  assert.equal(state.connected, false);
  assert.equal(state.retry, true);
  assert.equal(state.status, 'fixture failure');
});

test('native login blur and pointer events cannot corrupt the RFB authentication exchange', async () => {
  const f = fixture(); await f.connect();
  f.events.get('blur')!();
  f.element('touch').onpointermove({ pointerType: 'mouse', clientX: 100, clientY: 350 });
  await f.flush();
  assert.equal(f.sent.filter(packet => packet[0] === 0).length, 0, 'No RFB input may precede authentication');
  f.viewers[0].emit('connect');
  f.events.get('blur')!(); await f.flush();
  assert.equal(f.sent.filter(packet => packet[0] === 0).length, 1, 'Release must still work after authentication');
});

test('credentials show progress and only an authenticated connection reports success', async () => {
  const f = fixture(), id = await f.connect();
  f.window.Desktop.ui({ action: 'credentials', requestId: id, value: { username: 'fixture', password: 'fixture-password' } });
  assert.equal(f.element('status').textContent, '正在验证 Mac 账户…');
  assert.equal(f.messages.filter(m => m.t === 'desktop_auth').length, 0);
  f.viewers[0].emit('connect');
  assert.equal(f.messages.find(m => m.t === 'desktop_auth')?.state, 'authenticated');
  assert.equal(f.messages.find(m => m.t === 'desktop_auth')?.requestId, id);
});

test('stale credentials and late authentication callbacks cannot affect a replacement viewer', async () => {
  const f = fixture(), old = await f.connect(), current = await f.connect();
  f.window.Desktop.ui({ action: 'credentials', requestId: old, value: { username: 'old', password: 'old' } });
  assert.equal(f.viewers[1].credentials, undefined);
  f.viewers[0].emit('connect'); f.viewers[0].emit('securityfailure');
  assert.equal(f.messages.some(m => m.t === 'desktop_auth' && m.state === 'authenticated'), false);
  f.window.Desktop.ui({ action: 'credentials', requestId: current, value: { username: 'new', password: 'new' } });
  assert.equal(f.viewers[1].credentials.username, 'new');
});

test('rejection preserves actionable failure text after disconnect and never reports success', async () => {
  const f = fixture(); await f.connect(); f.viewers[0].emit('securityfailure');
  assert.match(f.element('status').textContent, /登录失败/);
  assert.equal(f.messages.some(m => m.state === 'authenticated'), false);
  assert.deepEqual(f.messages.filter(m => m.t === 'desktop_auth').map(m => m.state), ['rejected', 'closed']);
});

test('login timeout is visible and stops a pending credential attempt', async () => {
  const f = fixture(), id = await f.connect();
  f.window.Desktop.ui({ action: 'credentials', requestId: id, value: { username: 'fixture', password: 'fixture' } });
  for (const fn of [...f.timers.values()]) fn();
  assert.match(f.element('status').textContent, /登录未完成/);
  assert.equal(f.messages.at(-2)?.state === 'closed' || f.messages.some(m => m.t === 'desktop_auth' && m.state === 'closed'), true);
});


test('authentication alone keeps the waiting surface until opaque desktop pixels are painted', async () => {
  const f = fixture(); await f.connect(); f.viewers[0].emit('connect');
  for (const poll of f.intervals.values()) poll();
  assert.equal(f.element('empty').hidden, false);
  assert.equal(f.element('status').textContent, '正在接收桌面画面…');
  f.paint(); for (const poll of [...f.intervals.values()]) poll();
  assert.equal(f.element('empty').hidden, true);
  assert.equal(f.element('status').textContent, '已连接');
  // A real black frame has opaque alpha and must be accepted as a valid desktop.
});

test('missing first-frame data becomes a visible retryable error and old polling is retired', async () => {
  const f = fixture(); await f.connect(); f.viewers[0].emit('connect');
  for (const timeout of [...f.timers.values()]) timeout();
  assert.match(f.element('status').textContent, /画面接收超时/);
  assert.equal(f.element('empty').hidden, false);
  assert.equal(f.intervals.size, 0);
});

test('ongoing frame bytes renew the first-frame timeout, while heartbeat messages do not', async () => {
  const f = fixture(), id = await f.connect(); f.viewers[0].emit('connect');
  const oldTimers = [...f.timers.keys()];
  f.window.Desktop.receive({ t: 'desktop_data', id, bytes: new Uint8Array([0, 1, 2, 3]) }); await f.flush();
  assert.ok(oldTimers.every(timer => !f.timers.has(timer)));
  const newTimers = [...f.timers.keys()];
  f.window.Desktop.receive({ t: 'desktop_data', id, bytes: new Uint8Array([1, ...new TextEncoder().encode('{"event":"pong"}')]) }); await f.flush();
  assert.deepEqual([...f.timers.keys()], newTimers);
});

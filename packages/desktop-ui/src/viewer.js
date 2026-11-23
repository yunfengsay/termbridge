import RFB from './streamingRfb.js';
import { desktopGeometry, sourcePoint, zoomAround } from './geometry.js';
import { DesktopRequests } from './rfbRequests.js';
import { openDesktop } from '../../protocol/src/desktopCrypto.ts';

const $ = id => document.getElementById(id);
const viewport = $('viewport'), screen = $('screen'), touch = $('touch');
let viewportTimer, geometry;
let active, serial = 0, width = 1280, height = 720, zoom = 1, panX = 0, panY = 0;
let attention, backend = 'native', preferredBackend = 'auto', lastPoint = { x: 0, y: 0 };
let frameRate = 10;
let dragMode = false, scrollMode = true, mouseMask = 0;
let connected = false, retry = false, displays = [], nativeControls = false, uiQueued = false, lastState;
function publish() {
  // Native lifecycle/error state must not wait for a visible animation frame.
  // WebKit suspends rAF for an occluded window, including a locked local Mac.
  if (uiQueued) return;
  uiQueued = true;
  Promise.resolve().then(() => { uiQueued = false; const state = { t: 'desktop_state', connected: connected && active?.frameReady === true, retry,
    status: $('status').textContent, backend: preferredBackend, displays, displayId: active?.displayId ?? displays[0]?.id ?? 0,
    fps: frameRate, zoom: Math.round(zoom * 100), drag: dragMode, scroll: scrollMode };
    const serialized = JSON.stringify(state); if (serialized !== lastState) { lastState = serialized; native(state); }
  });
}
function status(text) {
  if (/Screen Recording permission/i.test(text)) text = '请在 Mac 的系统设置中允许屏幕录制，然后重新连接。';
  if (/Accessibility permission/i.test(text)) text = '请在 Mac 的系统设置中允许辅助功能，以便操作电脑。';
  $('status').textContent = text;
  $('empty-message').textContent = text;
  const visible = connected && active?.frameReady === true;
  $('empty').hidden = visible;
  screen.style.visibility = visible ? 'visible' : 'hidden';
  publish();
}
const native = message => {
  if (window.DesktopNative?.postMessage) window.DesktopNative.postMessage(JSON.stringify(message));
  else if (window.webkit?.messageHandlers?.desktop) window.webkit.messageHandlers.desktop.postMessage(message);
};
const fit = () => Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
function layout() {
  if (!viewport.clientWidth || !viewport.clientHeight) return;
  geometry = desktopGeometry(width, height, viewport.clientWidth, viewport.clientHeight, zoom, panX, panY);
  ({ panX, panY } = geometry);
  screen.style.width = `${width}px`; screen.style.height = `${height}px`;
  screen.style.transform = `translate(${geometry.left}px,${geometry.top}px) scale(${geometry.scale})`;
  $('fit').textContent = `${Math.round(zoom * 100)}%`; publish();
  const session = active;
  if (connected && session?.requests) {
    const key = JSON.stringify(geometry.rect);
    if (key !== session.viewportKey) {
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(() => { if (active === session && connected) session.requests.refresh(); }, 80);
    }
  }
}
function point(x, y, clampOutside = false) {
  const bounds = viewport.getBoundingClientRect();
  return geometry && sourcePoint(geometry, x - bounds.left, y - bounds.top, clampOutside);
}
function send(kind, bytes) {
  const session = active;
  if (!session?.cipher || session.closed) return;
  if (++session.queued > 128) { stop('连接过慢，请重新连接'); return; }
  session.send = session.send.then(async () => {
    if (session !== active || session.closed) return;
    const payload = new Uint8Array(bytes.length + 1); payload[0] = kind; payload.set(bytes, 1);
    native(await session.cipher.seal(payload));
  }).catch(() => stop('桌面连接已中断')).finally(() => session.queued--);
}
function command(op, args = {}) {
  if (backend === 'system' && active?.rfb && !['start', 'ping', 'close', 'ack', 'stream', 'viewport'].includes(op)) {
    if (!connected) return; // RFB input is illegal until authentication and ServerInit complete.
    const key = symbol => active?.rfb?.sendKey(symbol);
    if (op === 'text') { for (const char of args.text) { const cp = char.codePointAt(0); key(cp <= 255 ? cp : 0x01000000 + cp); } }
    else if (op === 'key') active.rfb.sendKey(({ 53: 0xff1b, 36: 0xff0d, 48: 0xff09, 51: 0xff08 })[args.code], undefined, args.down);
    else if (op === 'space') {
      active.rfb.sendKey(0xffe3, 'ControlLeft', true);
      key(args.direction === 'previous' ? 0xff51 : args.direction === 'next' ? 0xff53 : 0xff52);
      active.rfb.sendKey(0xffe3, 'ControlLeft', false);
    } else if (op === 'release') rawPointer(lastPoint, 0);
    else if (op === 'scroll') {
      for (const [delta, positive, negative] of [[args.dy, 8, 16], [args.dx, 32, 64]]) {
        for (let n = 0; n < Math.min(10, Math.ceil(Math.abs(delta) / 30)); n++) { rawPointer(lastPoint, delta > 0 ? positive : negative); rawPointer(lastPoint, 0); }
      }
    }
    return;
  }
  send(1, new TextEncoder().encode(JSON.stringify({ ...args, op })));
}
function rawPointer(p, mask) { if (!connected) return; send(0, new Uint8Array([5, mask, p.x >> 8, p.x & 255, p.y >> 8, p.y & 255])); }
function pointer(x, y, mask = mouseMask) {
  const p = point(x, y, mouseMask !== 0); if (!p) { if (!mask) rawPointer(lastPoint, 0); return; } lastPoint = p; rawPointer(p, mask);
}
function click(x, y, right = false) { pointer(x, y, right ? 4 : 1); pointer(x, y, 0); }
function release() { mouseMask = 0; clearTimeout(hold); fingers.clear(); gesture = undefined; command('release'); }
function stop(reason = '连接已结束') {
  const session = active; active = undefined; serial++; clearTimeout(viewportTimer);
  mouseMask = 0; clearTimeout(hold); fingers.clear(); gesture = undefined;
  attention = undefined; $('highlight').hidden = true;
  if (session) {
    native({ t: 'desktop_auth', requestId: session.handshake?.open.id, state: 'closed' });
    session.closed = true; session.requests?.close(); clearTimeout(session.loginTimer); clearTimeout(session.frameTimeout); clearInterval(session.framePoll);
    clearInterval(session.heartbeat); clearTimeout(session.handshakeTimer); session.cipher?.close();
    session.channel.readyState = 3; session.rfb?.disconnect();
  }
  connected = false; retry = true; status(reason); $('reconnect').hidden = false;
}
const createChannel = () => ({
  readyState: 1, binaryType: 'arraybuffer', protocol: '', onmessage: null, onopen: null, onerror: null, onclose: null,
  send(bytes) { if (active?.channel !== this || this.readyState !== 1) return;
    try { if (active.requests) active.requests.write(new Uint8Array(bytes)); else send(0, new Uint8Array(bytes)); }
    catch { command('close'); stop('桌面输入协议不兼容，请更新 Host 后重新连接'); }
  }, close() { this.readyState = 3; },
});
function frameProgress(session, length = 0) {
  if (!connected || session.frameReady) return;
  session.frameBytes = (session.frameBytes || 0) + length;
  clearTimeout(session.frameTimeout);
  session.frameTimeout = setTimeout(() => {
    if (active === session) { command('close'); stop('桌面画面接收超时，请检查网络并更新 Mac 上的 Host 后重新连接。'); }
  }, 30000);
  const progress = Math.floor(session.frameBytes / (512 * 1024));
  if (session.frameProgress !== progress) {
    session.frameProgress = progress;
    status(progress ? `正在接收桌面画面（${(progress / 2).toFixed(1)} MB）…` : '正在接收桌面画面…');
  }
}
function awaitFirstFrame(session) {
  frameProgress(session);
  session.framePoll = setInterval(() => {
    if (active !== session) return;
    const canvas = screen.querySelector('canvas');
    // RFB pixels are opaque, including a genuinely black desktop. An allocated,
    // transparent canvas only proves ServerInit, not that a frame was painted.
    if (!canvas?.width || !canvas?.height) return;
    const pixel = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    if (pixel[3] !== 255) return;
    session.frameReady = true; clearTimeout(session.frameTimeout); clearInterval(session.framePoll);
    status(attention?.title || '已连接');
  }, 250);
}
function event(message) {
  if (message.event === 'backend') { backend = message.mode; if (active) { active.streaming = message.streaming === 1; active.flowControl = message.flowControl === 1; } }
  else if (message.event === 'display') { attention = undefined; $('highlight').hidden = true; width = message.width; height = message.height; zoom = 1; panX = panY = 0; layout(); }
  else if (message.event === 'displays') {
    displays = message.displays ?? [];
    $('displays').replaceChildren(...displays.map(display => {
      const option = document.createElement('option'); option.value = String(display.id); option.textContent = display.name;
      if (display.id === active?.displayId) option.selected = true;
      return option;
    }));
  } else if (message.event === 'error') { connected = false; retry = true; status(message.error || '桌面操作失败'); $('reconnect').hidden = false; }
  else if (message.event === 'attention') focusRegion(message);
  if (message.event === 'display' && active) { active.displayId = message.displayId; $('displays').value = String(message.displayId); }
  publish();
}
function focusRegion(message) {
  const r = message.region;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return;
  attention = message;
  zoom = Math.max(1, Math.min(6, Math.min(1 / r.width, 1 / r.height) * 0.8));
  panX = viewport.clientWidth / 2 - (r.x + r.width / 2) * width * fit() * zoom;
  panY = viewport.clientHeight / 2 - (r.y + r.height / 2) * height * fit() * zoom;
  const highlight = $('highlight'); highlight.hidden = false;
  Object.assign(highlight.style, { left: `${r.x * width}px`, top: `${r.y * height}px`, width: `${r.width * width}px`, height: `${r.height * height}px` });
  status(message.title || '请查看高亮区域'); layout();
}
window.Desktop = {
  configure(options) {
    if ([10, 20, 30].includes(options.fps)) setFrameRate(options.fps);
    nativeControls = options.nativeControls === true;
    document.body.classList.toggle('native-controls', nativeControls);
    for (const key of ['background', 'foreground', 'muted', 'accent']) {
      if (/^#[a-f0-9]{6}$/i.test(options[key] ?? '')) document.documentElement.style.setProperty('--' + key, options[key]);
    }
    if (options.appearance === 'dark' || options.appearance === 'light') document.documentElement.style.colorScheme = options.appearance;
    layout(); publish();
  },
  ui(message) {
    if (message.action === 'fps') { setFrameRate(message.value); return; }
    if (message.action === 'cancelLogin') { command('close'); stop('已取消登录'); return; }
    if (message.action === 'credentials') {
      const requestId = message.requestId;
      message = message.value ?? {};
      if (requestId && requestId !== active?.handshake?.open.id) return;
      if (typeof message.password === 'string' && message.password.length <= 1024 && typeof message.username === 'string' && message.username.length <= 256) {
        const session = active;
        if (!session?.rfb || session.closed || connected) return;
        status('正在验证 Mac 账户…');
        clearTimeout(session.loginTimer);
        session.loginTimer = setTimeout(() => { if (active === session) { command('close'); stop('Mac 登录未完成，请检查屏幕共享权限后重试'); } }, 30000);
        session.rfb.sendCredentials({ username: message.username, password: message.password });
      }
      return;
    }
    if (message.action === 'backend' && ['auto', 'native', 'system'].includes(message.value)) {
      preferredBackend = message.value; native({ t: 'desktop_reconnect' }); return;
    }
    if (message.action === 'reconnect') { native({ t: 'desktop_reconnect' }); return; }
    if (message.action === 'fit') { zoom = 1; panX = panY = 0; layout(); return; }
    if (message.action === 'zoom' && Number.isFinite(message.value) && geometry) {
      const nextZoom = Math.max(1, Math.min(6, message.value / 100));
      const next = zoomAround(geometry, nextZoom, viewport.clientWidth / 2, viewport.clientHeight / 2);
      panX = next.panX; panY = next.panY; zoom = nextZoom; layout(); return;
    }
    if (message.action === 'drag') { release(); dragMode = !dragMode; publish(); return; }
    if (message.action === 'scrollMode') { release(); scrollMode = !scrollMode; publish(); return; }
    if (!connected) return;
    if (message.action === 'display' && displays.some(d => d.id === message.value)) {
      release(); command('display', { displayId: message.value });
    } else if (['previous', 'next', 'overview'].includes(message.action)) command('space', { direction: message.action });
    else if (message.action === 'text' && typeof message.value === 'string' && message.value.length <= 16000) command('text', { text: message.value });
    else if (message.action === 'key' && [53, 36, 48, 51].includes(message.value)) {
      command('key', { code: message.value, down: true }); command('key', { code: message.value, down: false });
    }
  },
  async start(settings) {
    if (active) stop();
    const id = ++serial; backend = 'native'; connected = false; retry = false; displays = []; $('reconnect').hidden = true; status('正在连接桌面…');
    const session = { id, closed: false, channel: createChannel(), send: Promise.resolve(), receive: Promise.resolve(), queued: 0 };
    active = session;
    session.handshakeTimer = setTimeout(() => { if (active === session) stop('电脑未响应桌面连接，请更新 Host 后重试'); }, 12000);
    try {
      session.handshake = await openDesktop(settings.secret, settings.hostId, settings.deviceId ?? '');
      if (active !== session) return;
      native(session.handshake.open);
    } catch (error) { if (active === session) stop(error.message); }
  },
  receive(message) {
    const session = active;
    if (!session || message.id !== session.handshake?.open.id) return;
    session.receive = session.receive.then(async () => {
      if (active !== session || session.closed) return;
      if (message.t === 'desktop_closed') { stop(message.reason); return; }
      if (message.t === 'desktop_ready') {
        clearTimeout(session.handshakeTimer);
        if (session.cipher) throw new Error('Duplicate desktop handshake');
        session.cipher = await session.handshake.finish(message);
        if (active !== session) { session.cipher.close(); return; }
        session.rfb = new RFB(screen, session.channel, {});
        session.rfb.onDesktopInit = (frameWidth, frameHeight) => {
          if (active !== session || !session.streaming) return;
          width = frameWidth; height = frameHeight; layout();
          if (backend === 'system') command('stream', { width, height });
          session.requests = new DesktopRequests(bytes => send(0, bytes), () => geometry.rect, backend === 'system', rect => {
            const key = JSON.stringify(rect);
            if (key !== session.viewportKey) { session.viewportKey = key; command('viewport', rect); }
          }, frameRate);
        };
        session.rfb.onDesktopFrame = () => { if (active === session) session.requests?.rendered(); };
        session.rfb.background = 'transparent';
        session.rfb.scaleViewport = false; session.rfb.clipViewport = false; session.rfb.resizeSession = false;
        session.rfb.addEventListener('credentialsrequired', e => {
          if (active !== session) return;
          status('请登录 Mac 屏幕共享');
          native({ t: 'desktop_credentials', requestId: session.handshake.open.id, username: e.detail.types.includes('username') });
        });
        session.rfb.addEventListener('securityfailure', () => {
          if (active !== session) return;
          native({ t: 'desktop_auth', requestId: session.handshake.open.id, state: 'rejected' });
          command('close'); stop('Mac 屏幕共享登录失败，请核对 Mac 账户及共享访问权限，再点重新连接。');
        });
        session.rfb.addEventListener('connect', () => { if (active !== session) return; clearTimeout(session.loginTimer);
          native({ t: 'desktop_auth', requestId: session.handshake.open.id, state: 'authenticated' }); connected = true; retry = false; syncFramebuffer(); awaitFirstFrame(session); });
        session.rfb.addEventListener('disconnect', () => { if (active === session) stop('桌面连接已结束'); });
        command('start', { backend: preferredBackend, streaming: 1, flowControl: 1 }); session.heartbeat = setInterval(() => command('ping'), 7000);
      } else if (message.t === 'desktop_data') {
        const bytes = await session.cipher.open(message);
        if (active !== session) return;
        if (bytes[0] === 0) { frameProgress(session, bytes.length - 1); session.channel.onmessage?.({ data: bytes.slice(1).buffer }); }
        else if (bytes[0] === 1) event(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
        else throw new Error('Invalid desktop packet');
        if (active === session && session.flowControl) command('ack', { sequence: message.sequence });
      }
    }).catch(() => { if (active === session) stop('桌面连接校验失败，请重新连接'); });
  },
  close() { command('close'); },
  disconnected(reason = 'Host 已断开连接') { stop(reason); },
};

function setFrameRate(value) {
  if (![10, 20, 30].includes(value)) return;
  frameRate = value; active?.requests?.setFrameRate(value); $('fps').value = String(value); publish();
}
$('fps').onchange = () => setFrameRate(Number($('fps').value));

$('displays').onchange = () => { release(); $('highlight').hidden = true; command('display', { displayId: Number($('displays').value) }); };
$('previous').onclick = () => command('space', { direction: 'previous' });
$('next').onclick = () => command('space', { direction: 'next' });
$('overview').onclick = () => command('space', { direction: 'overview' });
$('fit').onclick = () => { zoom = 1; panX = panY = 0; layout(); };
$('drag').onclick = () => { dragMode = !dragMode; $('drag').ariaPressed = String(dragMode); publish(); };
$('scroll').onclick = () => { scrollMode = !scrollMode; $('scroll').textContent = scrollMode ? '双指滚动' : '双指平移'; publish(); };
$('keyboard').onclick = () => { $('typing').hidden = !$('typing').hidden; if (!$('typing').hidden) $('text').focus(); };
$('type').onsubmit = e => { e.preventDefault(); if ($('text').value) command('text', { text: $('text').value }); $('text').value = ''; };
for (const [id, code] of [['escape', 53], ['enter', 36], ['tab', 48], ['backspace', 51]]) $(id).onclick = () => { command('key', { code, down: true }); command('key', { code, down: false }); };
$('reconnect').onclick = () => native({ t: 'desktop_reconnect' });
window.addEventListener('resize', layout);
window.addEventListener('blur', release);
// Native Activity/scene lifecycle owns connection teardown. WebView visibility can
// change temporarily while the keyboard or a system surface is shown.
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
touch.oncontextmenu = e => e.preventDefault();
touch.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.altKey) { panX -= e.deltaX; panY -= e.deltaY; layout(); return; }
  command('scroll', { dx: Math.max(-2000, Math.min(2000, -e.deltaX)), dy: Math.max(-2000, Math.min(2000, -e.deltaY)) });
}, { passive: false });

const fingers = new Map(); let gesture, hold;
const center = () => { const p = [...fingers.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, distance: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) }; };
touch.onpointerdown = e => {
  e.preventDefault(); touch.setPointerCapture(e.pointerId); active?.rfb?.focus();
  if (e.pointerType === 'mouse') { if (!point(e.clientX, e.clientY)) return; mouseMask |= e.button === 2 ? 4 : e.button === 1 ? 2 : 1; pointer(e.clientX, e.clientY); return; }
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (fingers.size === 1) {
    gesture = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, drag: dragMode, multi: false, at: Date.now() };
    if (dragMode) { mouseMask = 1; pointer(e.clientX, e.clientY); }
    hold = setTimeout(() => { if (gesture && !gesture.moved && fingers.size === 1) { gesture.drag = true; mouseMask = 1; pointer(gesture.x, gesture.y); } }, 350);
  } else if (fingers.size === 2) {
    clearTimeout(hold); if (mouseMask) { mouseMask = 0; pointer(e.clientX, e.clientY); }
    const c = center(); gesture = { multi: true, start: c, last: c, zoom, geometry, panX, panY, moved: false, mode: '', at: Date.now() };
  }
};
touch.onpointermove = e => {
  if (e.pointerType === 'mouse') { pointer(e.clientX, e.clientY); return; }
  if (!fingers.has(e.pointerId) || !gesture) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.multi) {
    if (fingers.size !== 2) return;
    const c = center(), ratio = c.distance / Math.max(1, gesture.start.distance);
    if (!gesture.mode && Math.abs(ratio - 1) > 0.06) gesture.mode = 'pinch';
    if (!gesture.mode && Math.hypot(c.x - gesture.start.x, c.y - gesture.start.y) > 8) gesture.mode = scrollMode ? 'scroll' : 'pan';
    if (!gesture.mode) return;
    gesture.moved = true;
    if (gesture.mode === 'pinch') {
      const nextZoom = Math.max(1, Math.min(6, gesture.zoom * ratio)), rect = viewport.getBoundingClientRect();
      const next = zoomAround(gesture.geometry, nextZoom, gesture.start.x - rect.left, gesture.start.y - rect.top, c.x - rect.left, c.y - rect.top);
      panX = next.panX; panY = next.panY;
      zoom = nextZoom; layout();
    } else if (gesture.mode === 'scroll') command('scroll', { dx: Math.round((c.x - gesture.last.x) * 2), dy: Math.round((c.y - gesture.last.y) * 2) });
    else { panX += c.x - gesture.last.x; panY += c.y - gesture.last.y; layout(); }
    gesture.last = c;
  } else {
    if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8) { gesture.moved = true; clearTimeout(hold); }
    if (gesture.drag) pointer(e.clientX, e.clientY);
    else if (gesture.moved) { panX += e.clientX - gesture.lastX; panY += e.clientY - gesture.lastY; layout(); }
    gesture.lastX = e.clientX; gesture.lastY = e.clientY;
  }
};
function pointerEnd(e, cancelled = false) {
  clearTimeout(hold);
  if (e.pointerType === 'mouse') { mouseMask &= ~(e.button === 2 ? 4 : e.button === 1 ? 2 : 1); pointer(e.clientX, e.clientY); return; }
  fingers.delete(e.pointerId);
  if (!gesture) return;
  if (!cancelled && !gesture.moved && !gesture.drag && Date.now() - gesture.at < 700) {
    if (gesture.multi && fingers.size === 1) { click(gesture.start.x, gesture.start.y, true); gesture.moved = true; }
    else if (!gesture.multi) click(e.clientX, e.clientY);
  }
  if (mouseMask) { mouseMask = 0; pointer(e.clientX, e.clientY); }
  if (!fingers.size) gesture = undefined;
}
touch.onpointerup = e => pointerEnd(e);
touch.onpointercancel = e => { pointerEnd(e, true); release(); };
function syncFramebuffer() {
  if (backend !== 'system') return;
  const canvas = screen.querySelector('canvas');
  if (canvas?.width > 0 && canvas?.height > 0) { width = canvas.width; height = canvas.height; layout(); }
}
new MutationObserver(syncFramebuffer).observe(screen, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
layout(); native({ t: 'desktop_loaded' });

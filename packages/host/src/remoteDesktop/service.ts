import { acceptDesktop, desktopBytes, type ControlMessage, type DesktopCipher, type DesktopOpen, type DesktopPacket } from '@termbridge/protocol';
import type { ToolResponse } from '../bridge.js';
import { NativeDesktop, type DesktopEvent } from './native.js';
import { DesktopRfb } from './rfb.js';
import { SystemSharing } from './systemSharing.js';
import { randomUUID } from 'node:crypto';

type Session = {
  clientId: number; deviceId: string; id: string; cipher: DesktopCipher; receive: Promise<void>; send: Promise<void>;
  system?: SystemSharing; rfb?: DesktopRfb; generation?: number; displayId?: number; pendingFrame?: DesktopEvent;
  queuedIn: number; queuedOut: number; lastSeen: number; started: boolean;
  streaming?: boolean; flowControl?: boolean; acks: Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
};
const encoder = new TextEncoder();
/** One input owner. Serial queues are bounded; retirement invalidates state before awaiting native teardown. */
export class RemoteDesktopService {
  private session?: Session;
  private opening = false;
  private openingClient?: number;
  private epoch = 0;
  private closed = false;
  private retiring: Promise<void> = Promise.resolve();
  private seen = new Map<string, number>();
  private watchdog: NodeJS.Timeout;
  private attention?: { id: string; title: string; displayId: number; region: Record<string, number>; expiresAt: number; deviceId?: string; shown?: boolean; notified?: boolean };
  private subscribers = new Map<number, { deviceId: string; foreground: boolean }>();
  constructor(private readonly native: Pick<NativeDesktop, 'request' | 'onEvent' | 'close' | 'reset'>, private readonly options: {
    systemSharing?: () => SystemSharing; hostId: string; secret: () => string | undefined; send: (clientId: number, message: ControlMessage) => void;
    /** Resolves only after the transport accepts this packet, propagating backpressure to capture. */
    sendData?: (clientId: number, message: DesktopPacket) => Promise<void>;
  }) {
    native.onEvent = event => this.onNative(event);
    this.watchdog = setInterval(() => {
      if (this.session && Date.now() - this.session.lastSeen > 20_000) this.drop(this.session.clientId, 'Desktop connection expired');
    }, 5_000); this.watchdog.unref();
  }

  async local(op: string, args: Record<string, unknown>): Promise<ToolResponse> {
    await this.retiring;
    if (op === 'attention') return this.focus(args);
    if (this.session && !['status', 'displays', 'capture', 'inspect'].includes(op) && !(op === 'press' && args.authorized === true)) return { ok: false, error: 'Desktop input is owned by a mobile viewer; close it before local automation, or authorize an exact inspected control press' };
    const result = await this.native.request(op, args);
    if (op === 'status' && result.ok) {
      let systemSharingAvailable = false;
      if (this.options.systemSharing) {
        const probe = this.options.systemSharing();
        systemSharingAvailable = await probe.connect(async () => {}, () => {}); probe.close();
      }
      return { ...result, data: { ...(result.data as object), systemSharingAvailable,
        desktopClients: [...this.subscribers.values()], viewing: !!this.session } };
    }
    return result;
  }

  handle(clientId: number, message: ControlMessage): boolean {
    if (this.closed) return message.t.startsWith('desktop_');
    if (message.t === 'desktop_subscribe') {
      if (typeof message.deviceId === 'string' && message.deviceId.length > 0 && message.deviceId.length <= 128 && this.subscribers.size < 128) this.subscribers.set(clientId, { deviceId: message.deviceId, foreground: message.foreground === true });
      const attention = this.attention;
      if (attention && !this.session && !attention.shown && !attention.notified && attention.expiresAt > Date.now() && (!attention.deviceId || attention.deviceId === message.deviceId)) {
        try { this.options.send(clientId, { t: 'desktop_attention', id: attention.id }); attention.deviceId = message.deviceId; attention.notified = true; } catch { /* Retry on the next subscriber connection. */ }
      }
      return true;
    }
    if (message.t === 'desktop_open') { void this.open(clientId, message); return true; }
    if (message.t !== 'desktop_data') return false;
    const session = this.session;
    if (!session || session.clientId !== clientId || session.id !== message.id) return true;
    if (++session.queuedIn > 128) { this.drop(clientId, 'Desktop input queue exceeded limit'); return true; }
    session.receive = session.receive.then(async () => {
      if (this.session !== session) return;
      const data = await session.cipher.open(message as DesktopPacket);
      session.lastSeen = Date.now();
      if (data[0] === 0) {
        if (session.system) session.system.receive(data.subarray(1));
        else {
          if (!session.rfb) throw new Error('Desktop handshake not complete');
          session.rfb.receive(data.subarray(1));
        }
      } else if (data[0] === 1) {
        if (data.length > 20_000) throw new Error('Desktop command too large');
        const command = JSON.parse(new TextDecoder().decode(data.subarray(1))) as Record<string, unknown>;
        await this.command(session, command);
      } else throw new Error('Invalid desktop packet type');
    }).catch(() => this.drop(clientId, 'Desktop session failed; reconnect to continue'))
      .finally(() => { session.queuedIn--; });
    return true;
  }

  private async open(clientId: number, message: DesktopOpen): Promise<void> {
    const reject = (reason: string) => { try { this.options.send(clientId, { t: 'desktop_closed', id: message.id, reason }); } catch { /* Disconnected or congested transport. */ } };
    if (this.opening || this.session) { reject('Desktop is already in use; close the current viewer first'); return; }
    this.opening = true;
    this.openingClient = clientId;
    const epoch = ++this.epoch;
    try {
      await this.retiring;
      const now = Date.now();
      for (const [id, expiry] of this.seen) if (expiry < now) this.seen.delete(id);
      if (this.seen.has(message.id) || this.seen.size >= 1024) throw new Error('Replayed desktop handshake');
      const { ready, cipher } = await acceptDesktop(this.options.secret() ?? '', this.options.hostId, message);
      if (epoch !== this.epoch || this.closed) { cipher.close(); return; }
      this.seen.set(message.id, now + 300_000);
      const session: Session = { clientId, deviceId: message.deviceId, id: message.id, cipher, receive: Promise.resolve(), send: Promise.resolve(), queuedIn: 0, queuedOut: 0, lastSeen: now, started: false, acks: new Map() };
      this.session = session;
      this.options.send(clientId, ready);
    } catch {
      if (this.session?.id === message.id) this.drop(clientId);
      reject('Desktop authentication unavailable or failed');
    }
    finally { this.opening = false; this.openingClient = undefined; }
  }

  private async command(session: Session, command: Record<string, unknown>): Promise<void> {
    if (command.op === 'ack') {
      if (!session.flowControl || !Number.isInteger(command.sequence)) throw new Error('Invalid desktop acknowledgement');
      const sequence = command.sequence as number;
      const ack = session.acks.get(sequence);
      if (!ack || sequence !== session.acks.keys().next().value) throw new Error('Unexpected desktop acknowledgement');
      session.acks.delete(sequence); clearTimeout(ack.timer); ack.resolve(); return;
    }
    if (command.op === 'ping') { this.json(session, { event: 'pong' }); return; }
    if (command.op === 'close') { this.drop(session.clientId, 'Desktop closed'); return; }
    if (command.op === 'start' || command.op === 'display') {
      if (command.op === 'start' && session.started) throw new Error('Desktop already started');
      if (command.op === 'start') { session.streaming = command.streaming === 1; session.flowControl = command.flowControl === 1; }
      if (command.backend === 'system' && !this.options.systemSharing) { this.json(session, { event: 'error', error: '当前 Host 不支持 macOS 系统屏幕共享' }); return; }
      if (command.op === 'start' && this.options.systemSharing && ['auto', 'system'].includes(String(command.backend))) {
        const sharing = this.options.systemSharing(); session.system = sharing;
        // Announce before the server's first RFB bytes, so the viewer routes all
        // input to the same system-owned session (including the lock screen).
        this.json(session, { event: 'backend', mode: 'system', streaming: session.streaming ? 1 : 0, flowControl: session.flowControl ? 1 : 0 });
        const available = await sharing.connect(bytes => this.send(session, 0, bytes), () => this.drop(session.clientId, '系统屏幕共享连接已结束'));
        if (this.session !== session) { sharing.close(); return; }
        if (available) {
          session.started = true;
          this.json(session, { event: 'displays', displays: [{ id: 0, name: 'Mac 屏幕' }] });
          return;
        }
        sharing.close(); session.system = undefined;
        this.json(session, { event: 'backend', mode: 'native', streaming: session.streaming ? 1 : 0, flowControl: session.flowControl ? 1 : 0 });
        if (command.backend === 'system') {
          this.json(session, { event: 'error', error: '请在 Mac 的系统设置 → 通用 → 共享中开启屏幕共享，允许你的账户访问，再重新连接。' });
          return;
        }
      }
      if (session.system) {
        this.json(session, { event: 'error', error: '系统共享使用 Mac 提供的完整画面；可缩放和平移查看。' }); return;
      }
      if (command.op === 'start') this.json(session, { event: 'backend', mode: 'native', streaming: session.streaming ? 1 : 0, flowControl: session.flowControl ? 1 : 0 });
      session.generation = undefined; session.pendingFrame = undefined;
      session.rfb?.discardFrame();
      const pendingDisplay = this.attentionFor(session)?.displayId;
      // Capture ceiling; the viewer paces RFB requests and the existing ACK window bounds production.
      const result = await this.native.request('start', { displayId: command.displayId ?? pendingDisplay, maxWidth: command.maxWidth ?? 1920, fps: 30 });
      if (this.session !== session) return;
      if (!result.ok) { this.json(session, { event: 'error', error: result.error }); return; }
      const data = result.data as { width: number; height: number; generation: number; displayId: number };
      session.started = true; session.generation = data.generation; session.displayId = data.displayId;
      this.json(session, { event: 'display', ...data });
      if (!session.rfb) session.rfb = new DesktopRfb(data.width, data.height, {
        send: bytes => { void this.send(session, 0, bytes); },
        sendFrame: bytes => this.send(session, 0, bytes), streaming: session.streaming,
        input: event => {
          if (this.session !== session || session.generation === undefined) return;
          const generation = session.generation;
          // Native requests preserve pipe order, including multi-event drags. Failure invalidates the owner.
          void this.native.request(event.op, { ...event.args, generation, displayId: session.displayId })
            .then(result => { if (!result.ok && this.session === session && session.generation === generation) this.drop(session.clientId, result.error ?? 'Desktop input failed'); });
        },
        close: reason => this.drop(session.clientId, reason),
      });
      const frame = session.pendingFrame; session.pendingFrame = undefined;
      if (frame) this.onNative(frame);
      const displays = await this.native.request('displays');
      this.json(session, { event: 'displays', ...(displays.data as object) });
      const attention = this.attentionFor(session);
      if (attention && attention.displayId === data.displayId) { attention.shown = true; this.json(session, { event: 'attention', ...attention }); }
      return;
    }
    if (!session.started) throw new Error('Desktop not started');
    if (command.op === 'stream' && session.streaming && session.system) {
      session.system.enableFrames(Number(command.width), Number(command.height)); return;
    }
    if (command.op === 'viewport' && session.streaming) {
      const { x, y, width, height } = command;
      if (![x, y, width, height].every(n => typeof n === 'number' && Number.isInteger(n)) || Number(x) < 0 || Number(y) < 0 || Number(width) < 1 || Number(height) < 1 || Number(x) + Number(width) > 8192 || Number(y) + Number(height) > 8192) throw new Error('Invalid desktop viewport');
      session.system?.setViewport({ x: Number(x), y: Number(y), width: Number(width), height: Number(height) }); return;
    }
    if (session.system) { if (command.op === 'release') return; throw new Error('System sharing input must use RFB'); }
    if (!['text', 'key', 'space', 'release', 'scroll'].includes(String(command.op))) throw new Error('Unsupported desktop command');
    if (command.op === 'release' || command.op === 'space') session.rfb?.resetInput();
    const result = await this.native.request(String(command.op), { ...command, generation: session.generation });
    if (!result.ok) this.json(session, { event: 'error', error: result.error });
  }

  private onNative(event: DesktopEvent): void {
    const session = this.session;
    if (!session || session.system) return;
    if (event.event === 'closed' || (event.event === 'error' && event.generation === session.generation)) { this.drop(session.clientId, 'Desktop capture stopped'); return; }
    if (event.event !== 'frame') return;
    if (session.generation === undefined) {
      if (Number(event.generation) >= Number(session.pendingFrame?.generation ?? -1)) session.pendingFrame = event;
      return;
    }
    if (event.generation !== session.generation) return;
    if (typeof event.data !== 'string' || typeof event.width !== 'number' || typeof event.height !== 'number') { this.drop(session.clientId, 'Invalid desktop frame'); return; }
    const generation = session.generation;
    session.rfb?.offerFrame(event.width, event.height, Buffer.from(desktopBytes(event.data, 4_194_303)), () => {
      if (this.session === session) void this.native.request('ack', { generation });
    });
  }

  private json(session: Session, message: Record<string, unknown>): void { this.send(session, 1, encoder.encode(JSON.stringify(message))); }
  private attentionFor(session: Session) {
    return this.attention && this.attention.expiresAt > Date.now() && (!this.attention.deviceId || this.attention.deviceId === session.deviceId) ? this.attention : undefined;
  }
  private async focus(args: Record<string, unknown>): Promise<ToolResponse> {
    const region = args.region as Record<string, number> | undefined;
    if (!Number.isInteger(args.displayId) || Number(args.displayId) < 1 || !region ||
        !['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && region[key] >= 0 && region[key] <= 1) ||
        region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) return { ok: false, error: 'Attention requires a display ID and a normalized rectangle within that display' };
    const attention = { id: randomUUID(), displayId: Number(args.displayId), region, title: String(args.title ?? '请查看桌面高亮区域').slice(0, 128), expiresAt: Date.now() + 300_000,
      deviceId: typeof args.deviceId === 'string' ? args.deviceId : undefined, shown: false, notified: false };
    const session = this.session;
    if (session && attention.deviceId && attention.deviceId !== session.deviceId) return { ok: false, error: 'Another device currently owns the desktop viewer' };
    this.attention = attention;
    if (session?.system) return { ok: false, error: 'Region highlighting requires the direct desktop connection; system sharing uses its own display layout' };
    if (session) {
      session.receive = session.receive.then(async () => {
        if (this.session !== session) return;
        if (session.displayId !== attention.displayId) await this.command(session, { op: session.started ? 'display' : 'start', displayId: attention.displayId });
        else { attention.shown = true; this.json(session, { event: 'attention', ...attention }); }
      }).catch(() => this.drop(session.clientId, 'Could not focus desktop region'));
      return { ok: true, data: { id: attention.id, state: 'delivered_to_viewer', expiresAt: attention.expiresAt } };
    }
    const devices = new Map<string, { clientId: number; foreground: boolean }>();
    for (const [clientId, subscriber] of this.subscribers) {
      if (args.deviceId && args.deviceId !== subscriber.deviceId) continue;
      if (!devices.get(subscriber.deviceId)?.foreground) devices.set(subscriber.deviceId, { clientId, foreground: subscriber.foreground });
    }
    if (devices.size > 1) { this.attention = undefined; return { ok: false, error: 'Multiple desktop clients online; choose --device' }; }
    const target = [...devices.values()][0];
    if (target) attention.deviceId = [...devices.keys()][0];
    if (target) { this.options.send(target.clientId, { t: 'desktop_attention', id: attention.id }); attention.notified = true; }
    return { ok: true, data: { id: attention.id, state: target ? 'notification_sent' : 'ready_for_next_viewer', expiresAt: attention.expiresAt } };
  }
  private send(session: Session, kind: number, data: Uint8Array): Promise<void> {
    if (this.session !== session) return Promise.resolve();
    if (session.queuedOut + data.length > 8 * 1024 * 1024) { this.drop(session.clientId, 'Desktop viewer is too slow'); return Promise.resolve(); }
    session.queuedOut += data.length;
    session.send = session.send.then(async () => {
      const pending: Promise<void>[] = [];
      for (let offset = 0; offset < data.length; offset += 65535) {
        if (this.session !== session) return;
        const payload = new Uint8Array(Math.min(65535, data.length - offset) + 1); payload[0] = kind; payload.set(data.subarray(offset, offset + 65535), 1);
        const packet = await session.cipher.seal(payload);
        if (this.session === session) {
          const acknowledged = session.flowControl ? new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { session.acks.delete(packet.sequence); reject(new Error('Desktop viewer stalled')); }, 15_000); timer.unref();
            session.acks.set(packet.sequence, { resolve, reject, timer });
          }) : Promise.resolve();
          // Keep writes ordered, but pipeline up to eight encrypted fragments
          // (512 KiB). Waiting per fragment multiplies WAN RTT by frame size.
          // Observe rejection immediately, including retirement during a write.
          void acknowledged.catch(() => {});
          pending.push(acknowledged);
          await (this.options.sendData ? this.options.sendData(session.clientId, packet) : this.options.send(session.clientId, packet));
          if (pending.length >= 8) await pending.shift();
        }
      }
      await Promise.all(pending);
    }).catch(() => { if (this.session === session) this.drop(session.clientId, 'Desktop transport failed'); }).finally(() => { session.queuedOut -= data.length; });
    return session.send;
  }

  drop(clientId: number, reason = 'Desktop disconnected'): void {
    this.subscribers.delete(clientId);
    if (this.openingClient === clientId) this.epoch++;
    const session = this.session;
    if (!session || session.clientId !== clientId) return;
    this.session = undefined; session.cipher.close(); session.system?.close(); session.rfb?.close();
    for (const ack of session.acks.values()) { clearTimeout(ack.timer); ack.reject(new Error('Desktop closed')); }
    session.acks.clear();
    try { this.options.send(clientId, { t: 'desktop_closed', id: session.id, reason: reason.slice(0, 256) }); } catch { /* transport gone */ }
    this.retiring = this.native.reset();
  }
  async close(): Promise<void> { this.closed = true; this.epoch++; clearInterval(this.watchdog); if (this.session) this.drop(this.session.clientId); await this.retiring; await this.native.close(); }
}

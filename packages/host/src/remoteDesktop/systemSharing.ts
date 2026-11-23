import net from 'node:net';
import { SystemFrames } from './systemFrames.js';
import type { DesktopRect } from './frameEncoding.js';

/** Loopback-only transport to macOS's own login-window-capable screen sharing service.
 * Authentication stays inside RFB; neither credentials nor pixels become tool results.
 */
export class SystemSharing {
  private socket?: net.Socket;
  private closed = false;
  private frames?: SystemFrames;
  private output?: (bytes: Uint8Array) => Promise<void>;
  enableFrames(width: number, height: number): void {
    if (this.frames || !this.output) throw new Error('Invalid desktop stream transition');
    this.frames = new SystemFrames(width, height, bytes => this.output!(bytes));
  }
  setViewport(rect: DesktopRect): void { this.frames?.setViewport(rect); }
  async connect(onBytes: (bytes: Uint8Array) => Promise<void>, onClose: () => void, port = 5900): Promise<boolean> {
    if (this.closed) return false;
    this.output = onBytes;
    return new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      this.socket = socket;
      let settled = false, connected = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { socket.destroy(); finish(false); }, 1200);
      socket.setNoDelay(true);
      socket.once('connect', () => { connected = true; finish(true); });
      socket.on('data', bytes => {
        socket.pause();
        void (this.frames ? this.frames.receive(bytes) : onBytes(bytes)).then(() => { if (!this.closed && this.socket === socket) socket.resume(); }, () => socket.destroy());
      });
      socket.on('error', () => { finish(false); });
      socket.once('close', () => { finish(false); if (connected && !this.closed) onClose(); });
    });
  }
  receive(bytes: Uint8Array): void {
    if (this.closed || !this.socket || this.socket.destroyed) throw new Error('System screen sharing disconnected');
    if (this.socket.writableLength + bytes.length > 1024 * 1024) throw new Error('System screen sharing input congested');
    this.socket.write(bytes);
  }
  close(): void { this.closed = true; this.frames?.close(); this.socket?.destroy(); this.socket = undefined; }
}

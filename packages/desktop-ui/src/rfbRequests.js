/** Post-ServerInit client messages only. Authentication bytes never enter this parser. */
export class DesktopRequests {
  constructor(send, viewport, system, onViewport, fps = 10, clock = { now: () => performance.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) }) {
    this.send = send; this.viewport = viewport; this.system = system; this.onViewport = onViewport;
    this.pending = new Uint8Array(); this.refreshInFlight = false; this.queuedUpdate = undefined;
    this.clock = clock; this.lastUpdate = -Infinity; this.timer = undefined; this.closed = false;
    this.setFrameRate(fps);
  }
  setFrameRate(fps) {
    if (![10, 20, 30].includes(fps)) return;
    this.fps = fps;
    if (this.timer !== undefined) {
      this.clock.clear(this.timer); this.timer = undefined;
      this.update(true);
    }
  }
  close() {
    this.closed = true; this.clock.clear(this.timer); this.timer = undefined;
    this.queuedUpdate = undefined; this.pending = new Uint8Array();
  }
  write(bytes) {
    if (this.closed) return;
    const all = new Uint8Array(this.pending.length + bytes.length); all.set(this.pending); all.set(bytes, this.pending.length); this.pending = all;
    if (all.length > 65536) throw new Error('Desktop input limit');
    while (this.pending.length) {
      const type = this.pending[0], view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
      let size;
      if (type === 0) size = 20;
      else if (type === 2) { if (view.byteLength < 4) return; size = 4 + view.getUint16(2) * 4; }
      else if (type === 3) size = 10;
      else if (type === 4) size = 8;
      else if (type === 5) size = 6;
      else if (type === 6) { if (view.byteLength < 8) return; size = 8 + view.getUint32(4); }
      else throw new Error('Unsupported desktop input extension');
      if (size > 65536) throw new Error('Desktop input limit');
      if (view.byteLength < size) return;
      let packet = this.pending.slice(0, size); this.pending = this.pending.slice(size);
      if (type === 2 && this.system) {
        // Raw pixels travel only over Mac loopback, then the Host emits Tight JPEG.
        packet = new Uint8Array([2, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255, 33]); // Raw, DesktopSize (-223)
      } else if (type === 3) {
        this.update(packet[1] !== 0); continue;
      }
      this.send(packet);
    }
  }
  update(incremental) {
    if (this.closed) return;
    if (this.refreshInFlight) {
      // False means a full refresh and takes priority. Coordinates are sampled
      // only when sending, so moving twenty times stores one latest request.
      this.queuedUpdate = (this.queuedUpdate ?? true) && incremental; return;
    }
    // Pace only frame requests. Keyboard/pointer packets never wait for a frame.
    // A full viewport refresh may wake an idle incremental request immediately.
    this.clock.clear(this.timer); this.timer = undefined;
    const delay = 1000 / this.fps - (this.clock.now() - this.lastUpdate);
    if (incremental && delay > 0) {
      this.timer = this.clock.set(() => { this.timer = undefined; this.update(true); }, delay);
      return;
    }
    this.lastUpdate = this.clock.now();
    const rect = this.viewport(), packet = new Uint8Array(10), view = new DataView(packet.buffer);
    packet[0] = 3; packet[1] = incremental ? 1 : 0;
    view.setUint16(2, rect.x); view.setUint16(4, rect.y); view.setUint16(6, rect.width); view.setUint16(8, rect.height);
    if (!incremental) this.refreshInFlight = true;
    this.onViewport(rect); this.send(packet);
  }
  rendered() {
    this.refreshInFlight = false;
    const update = this.queuedUpdate; this.queuedUpdate = undefined;
    if (update !== undefined) this.update(update);
  }
  // A pending incremental update may wait indefinitely on an idle Mac. A full
  // refresh is allowed to wake it; further full requests wait for rendering.
  refresh() { this.update(false); }
}

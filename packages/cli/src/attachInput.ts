export type AttachInputEvent = { type: 'input'; data: Buffer } | { type: 'prompt' | 'cancel' | 'detach' };

/** Local detach controls must never consume bytes inside a bracketed paste. */
export class AttachInput {
  confirming = false;
  private pasted = false;
  private tail = '';

  feed(data: Buffer, connected: boolean): AttachInputEvent[] {
    if (this.confirming) {
      // Track delimiters across chunks here too: a pasted single `d` must not
      // approve detach when the terminal delivers the paste byte by byte.
      let paste = this.pasted;
      for (const byte of data) {
        this.track(byte);
        paste ||= this.pasted;
      }
      if (paste || data.length !== 1) return [];
      const key = data.toString().toLowerCase();
      if (key === 'd' || key === 'y') { this.confirming = false; return [{ type: 'detach' }]; }
      if (['c', 'n', '\r', '\n', '\x03', '\x1d'].includes(key)) {
        this.confirming = false; return [{ type: 'cancel' }];
      }
      return [];
    }
    const events: AttachInputEvent[] = [];
    const bytes: number[] = [];
    for (const byte of data) {
      if (!this.pasted && (byte === 0x1d || (byte === 0x03 && !connected))) {
        if (bytes.length && connected) events.push({ type: 'input', data: Buffer.from(bytes) });
        this.confirming = true;
        this.tail = '';
        events.push({ type: 'prompt' });
        return events;
      }
      bytes.push(byte);
      this.track(byte);
    }
    if (bytes.length && connected) events.push({ type: 'input', data: Buffer.from(bytes) });
    return events;
  }

  private track(byte: number): void {
    this.tail = (this.tail + String.fromCharCode(byte)).slice(-6);
    if (this.tail === '\x1b[200~') this.pasted = true;
    if (this.tail === '\x1b[201~') this.pasted = false;
  }
}

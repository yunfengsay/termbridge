export type FramePriority = 'high' | 'bulk';

export interface PrioritySink {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
}

const OPEN_STATE = 1; // WebSocket.OPEN
const HIGH_WATER_BYTES = 256 * 1024;
const BULK_DRAIN_BUDGET_BYTES = 128 * 1024;

/**
 * 2-lane outbound scheduler modeled after MTProto priority separation:
 * interactive terminal/chat/control frames jump ahead of bulk file, desktop,
 * and proxy-tunnel payloads whenever the WebSocket send buffer backs up.
 */
export class PriorityRelaySender {
  private high: Buffer[] = [];
  private bulk: Buffer[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly getSink: () => PrioritySink | undefined) {}

  enqueue(envelope: Buffer, priority: FramePriority = 'high'): void {
    const sink = this.getSink();
    if (!sink || sink.readyState !== OPEN_STATE) return;

    if (priority === 'high') {
      if (this.high.length === 0 && (this.bulk.length === 0 || sink.bufferedAmount < HIGH_WATER_BYTES * 2)) {
        sink.send(envelope);
        return;
      }
      this.high.push(envelope);
      this.scheduleDrain();
      return;
    }

    if (this.high.length === 0 && this.bulk.length === 0 && sink.bufferedAmount < HIGH_WATER_BYTES) {
      sink.send(envelope);
      return;
    }
    this.bulk.push(envelope);
    this.scheduleDrain();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const sink = this.getSink();
    if (!sink || sink.readyState !== OPEN_STATE) {
      this.clear();
      return;
    }

    // Always drain all interactive frames first.
    while (this.high.length > 0) {
      sink.send(this.high.shift()!);
    }

    // Drain bulk frames within a per-tick budget while buffer stays below high water.
    let sentBulkBytes = 0;
    while (
      this.bulk.length > 0 &&
      sink.bufferedAmount < HIGH_WATER_BYTES &&
      sentBulkBytes < BULK_DRAIN_BUDGET_BYTES
    ) {
      const frame = this.bulk.shift()!;
      sink.send(frame);
      sentBulkBytes += frame.length;
    }

    if (this.high.length > 0 || this.bulk.length > 0) {
      this.scheduleDrain();
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.high.length = 0;
    this.bulk.length = 0;
  }

  get pendingHigh(): number { return this.high.length; }
  get pendingBulk(): number { return this.bulk.length; }

  private scheduleDrain(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 4);
    this.timer.unref?.();
  }
}

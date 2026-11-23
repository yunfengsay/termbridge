import type { RealtimeConversation, RealtimeConversationCallbacks, RealtimeTranscription,
  RealtimeTranscriptionCallbacks } from '@termbridge/voice';

interface SilentCallOptions {
  callbacks: RealtimeConversationCallbacks;
  transcribe(callbacks: RealtimeTranscriptionCallbacks): RealtimeTranscription;
  execute(text: string, signal: AbortSignal): Promise<string>;
  settleMs?: number;
}

/** A visible, continuously listening call, but ASR -> execution model, never Omni/TTS. */
export class SilentCall implements RealtimeConversation {
  private closed = false;
  private ready = false;
  private current?: { stream: RealtimeTranscription; bytes: number };
  private readonly streams = new Set<RealtimeTranscription>();
  private readonly timers = new Map<RealtimeTranscription, ReturnType<typeof setTimeout>>();
  private readonly segments: Array<{ text: string; done: boolean }> = [];
  private readonly queue: string[] = [];
  private draft = '';
  private settling?: ReturnType<typeof setTimeout>;
  private readonly connecting: ReturnType<typeof setTimeout>;
  private executing?: AbortController;

  constructor(private readonly options: SilentCallOptions) {
    this.connecting = setTimeout(() => this.fail(new Error('Speech connection timed out')), 15_000);
    // Defer construction so the Host registers this call before provider callbacks.
    queueMicrotask(() => {
      if (this.closed) return;
      try { this.openSegment(); } catch (error) { this.fail(error as Error); }
    });
  }

  private openSegment() {
    const segment = { text: '', done: false };
    this.segments.push(segment);
    const stream = this.options.transcribe({
      onReady: () => {
        if (this.closed || this.ready) return;
        this.ready = true;
        clearTimeout(this.connecting);
        this.options.callbacks.onReady();
      },
      onText: (text, final) => {
        if (this.closed) return;
        if (final) segment.text = text;
        this.options.callbacks.onTranscript(text, final);
      },
      onError: (error) => this.fail(error),
      onFinished: () => {
        if (this.closed) return;
        clearTimeout(this.timers.get(stream));
        this.timers.delete(stream);
        this.streams.delete(stream);
        if (this.current?.stream === stream) this.current = undefined;
        segment.done = true;
        while (this.segments[0]?.done) {
          const text = this.segments.shift()!.text.trim();
          if (text) this.draft = [this.draft, text].filter(Boolean).join(' ');
        }
        this.scheduleTurn();
      },
    });
    this.streams.add(stream);
    this.current = { stream, bytes: 0 };
  }

  append(pcm: Uint8Array): void {
    if (this.closed) return;
    clearTimeout(this.settling);
    if (!this.current) this.openSegment();
    this.current!.bytes += pcm.length;
    this.current!.stream.append(pcm);
  }

  commit(): void {
    const segment = this.current;
    if (this.closed || !segment?.bytes) return;
    this.current = undefined;
    // Rotate ASR sessions per local utterance; a call must not hit the one-minute ASR limit.
    this.timers.set(segment.stream, setTimeout(() => this.fail(new Error('Speech recognition timed out')), 15_000));
    segment.stream.commit();
    segment.stream.finish();
  }

  private scheduleTurn() {
    clearTimeout(this.settling);
    if (this.closed || this.current?.bytes || this.segments.length || !this.draft) return;
    this.settling = setTimeout(() => {
      const text = this.draft;
      this.draft = '';
      this.enqueue(text);
    }, this.options.settleMs ?? 1_000);
  }

  private enqueue(text: string) {
    if (this.closed || !text.trim()) return;
    if (text.length > 16_000) { this.fail(new Error('Spoken request is too long')); return; }
    if (this.queue.length >= 8) { this.fail(new Error('Too many pending spoken requests')); return; }
    this.queue.push(text);
    void this.runNext();
  }

  private async runNext() {
    if (this.closed || this.executing || !this.queue.length) return;
    const text = this.queue.shift()!;
    const controller = new AbortController();
    this.executing = controller;
    const callbacks = this.options.callbacks;
    callbacks.onTurnSubmitted(text);
    callbacks.onResponseStarted();
    try {
      const answer = await this.options.execute(text, controller.signal);
      if (!this.closed && !controller.signal.aborted) callbacks.onText(answer, true);
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) callbacks.onText('执行失败，请重试。', true);
    } finally {
      this.executing = undefined;
      if (!this.closed) {
        callbacks.onResponseFinished(controller.signal.aborted ? 'interrupted' : 'completed');
        void this.runNext();
      }
    }
  }

  cancelResponse(): void {
    this.queue.length = 0;
    this.draft = '';
    clearTimeout(this.settling);
    this.executing?.abort(new Error('Call execution cancelled'));
  }
  injectUserMessage(text: string): void { this.enqueue(text); }
  // This lane cannot enable audio; switching back creates a normal realtime call.
  setOutputAudioEnabled(_enabled: boolean): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connecting);
    this.cancelResponse();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.segments.length = 0;
    this.options.callbacks.onFinished();
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.options.callbacks.onError(error);
    this.close();
  }
}

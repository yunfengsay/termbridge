import { randomUUID } from 'node:crypto';
import { WebSocket, type ClientOptions, type RawData } from 'ws';

export interface RealtimeTranscriptionCallbacks {
  onReady?(): void;
  onText(text: string, final: boolean): void;
  onError(error: Error): void;
  onFinished(): void;
}

export interface RealtimeTranscription {
  append(pcm16: Uint8Array): void;
  commit(): void;
  finish(): void;
  close(): void;
}

export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
}

export type RealtimeSocketFactory = (url: string, options: ClientOptions) => RealtimeSocket;

interface QwenRealtimeEvent {
  type?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  error?: { message?: string };
}

export interface BailianRealtimeTranscriptionOptions {
  apiKey: string;
  url: string;
  model: string;
  locale?: string;
  hints?: string[];
  callbacks: RealtimeTranscriptionCallbacks;
  socketFactory?: RealtimeSocketFactory;
  maxAudioBytes?: number;
}

const OPEN = 1;
const DEFAULT_MAX_AUDIO_BYTES = 16_000 * 2 * 60;

/** One manual-mode Qwen ASR session. Local VAD decides sentence boundaries. */
export class BailianRealtimeTranscription implements RealtimeTranscription {
  private readonly socket: RealtimeSocket;
  private readonly callbacks: RealtimeTranscriptionCallbacks;
  private readonly pending: string[] = [];
  private readonly maxAudioBytes: number;
  private ready = false;
  private closed = false;
  private finishing = false;
  private audioBytes = 0;

  constructor(options: BailianRealtimeTranscriptionOptions) {
    this.callbacks = options.callbacks;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    const endpoint = new URL(options.url);
    endpoint.searchParams.set('model', options.model);
    const factory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.socket = factory(endpoint.toString(), {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    this.socket.on('open', () => {
      this.sendNow({
        type: 'session.update',
        event_id: eventId(),
        session: {
          modalities: ['text'],
          input_audio_format: 'pcm',
          sample_rate: 16_000,
          input_audio_transcription: {
            ...(languageCode(options.locale) ? { language: languageCode(options.locale) } : {}),
            corpus: { text: (options.hints?.length ? options.hints : ['发送']).slice(0, 64).join('、').slice(0, 2048) },
          },
          turn_detection: null,
        },
      });
    });
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', (_code, reason) => {
      if (!this.closed) this.fail(new Error(`Realtime voice connection closed${reason.length ? `: ${reason}` : ''}`));
    });
  }

  append(pcm16: Uint8Array): void {
    if (this.closed || this.finishing) return;
    if (pcm16.length === 0 || pcm16.length % 2 !== 0 || pcm16.length > 64 * 1024) {
      this.fail(new Error('Invalid realtime PCM audio chunk'));
      return;
    }
    this.audioBytes += pcm16.length;
    if (this.audioBytes > this.maxAudioBytes) {
      this.fail(new Error('Realtime voice session reached its 60 second audio limit'));
      return;
    }
    this.enqueue({
      type: 'input_audio_buffer.append',
      event_id: eventId(),
      audio: Buffer.from(pcm16).toString('base64'),
    }, pcm16.length);
  }

  commit(): void {
    if (this.closed || this.finishing) return;
    this.enqueue({ type: 'input_audio_buffer.commit', event_id: eventId() });
  }

  finish(): void {
    if (this.closed || this.finishing) return;
    this.finishing = true;
    this.enqueue({ type: 'session.finish', event_id: eventId() });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.socket.close(1000, 'voice session closed');
  }

  private handleMessage(raw: RawData): void {
    let event: QwenRealtimeEvent;
    try {
      event = JSON.parse(raw.toString()) as QwenRealtimeEvent;
    } catch {
      this.fail(new Error('Realtime voice service returned invalid data'));
      return;
    }
    switch (event.type) {
      case 'session.updated':
        this.ready = true;
        this.flush();
        this.callbacks.onReady?.();
        break;
      case 'conversation.item.input_audio_transcription.text':
        this.callbacks.onText(`${event.text || ''}${event.stash || ''}`, false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.callbacks.onText(event.transcript?.trim() || '', true);
        break;
      case 'conversation.item.input_audio_transcription.failed':
      case 'error':
        this.fail(new Error(event.error?.message || 'Realtime voice recognition failed'));
        break;
      case 'session.finished':
        this.closed = true;
        this.callbacks.onFinished();
        this.socket.close(1000, 'voice session finished');
        break;
      default:
        break;
    }
  }

  private enqueue(event: object, _audioBytes = 0): void {
    const queued = JSON.stringify(event);
    if (!this.ready) {
      this.pending.push(queued);
      return;
    }
    this.socket.send(queued);
  }

  private sendNow(event: object): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(event));
  }

  private flush(): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    for (const event of this.pending.splice(0)) this.socket.send(event);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.callbacks.onError(error);
    this.socket.close(1011, 'voice session failed');
  }
}

function eventId(): string {
  return `event_${randomUUID()}`;
}

function languageCode(locale: string | undefined): string | undefined {
  const language = locale?.split(/[-_]/, 1)[0]?.toLowerCase();
  return language && /^[a-z]{2,3}$/.test(language) ? language : undefined;
}

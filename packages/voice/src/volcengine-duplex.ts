import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  RealtimeConversation,
  RealtimeConversationCallbacks,
  RealtimeToolCall,
  RealtimeToolDefinition,
} from './omni-realtime.js';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtime.js';
import { reconcileTechnicalTranscript } from './transcript-vocabulary.js';

export interface VolcengineDuplexConversationOptions {
  apiKey: string;
  url?: string;
  model?: string;
  speaker?: string;
  instructions: string;
  sendKeyword: string;
  technicalTerms?: readonly string[];
  turnMode?: 'keyword' | 'automatic' | 'semantic';
  outputAudioEnabled?: boolean;
  tools?: RealtimeToolDefinition[];
  callbacks: RealtimeConversationCallbacks;
  socketFactory?: RealtimeSocketFactory;
  maxAudioBytes?: number;
}

interface DuplexEvent {
  type?: string;
  event_id?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  message?: string;
  status_code?: string | number;
  tts_type?: string;
  item?: DuplexItem;
  items?: DuplexItem[];
  usage?: DuplexUsage;
  response?: { usage?: DuplexUsage };
  error?: { code?: string | number; message?: string };
}

interface DuplexItem {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  text?: string;
}

interface DuplexUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_text_tokens?: number;
  input_audio_tokens?: number;
  output_text_tokens?: number;
  output_audio_tokens?: number;
  input_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  output_tokens_details?: { text_tokens?: number; audio_tokens?: number };
}

const OPEN = 1;
const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const DEFAULT_MODEL = '1.2.6.1';
const DEFAULT_SPEAKER = 'zh_female_vv_jupiter_bigtts';
const DEFAULT_MAX_AUDIO_BYTES = 16_000 * 2 * 60 * 30;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const AUDIO_FRAME_BYTES = 640;

/** Current Volcengine Seeduplex 3.0 JSON-event realtime protocol. */
export class VolcengineDuplexConversation implements RealtimeConversation {
  private readonly socket: RealtimeSocket;
  private readonly callbacks: RealtimeConversationCallbacks;
  private readonly model: string;
  private readonly speaker: string;
  private readonly sendKeyword: string;
  private readonly technicalTerms: readonly string[];
  private readonly turnMode: 'keyword' | 'automatic' | 'semantic';
  private readonly maxAudioBytes: number;
  private readonly pending: Array<{ json: string; audioBytes: number }> = [];
  private readonly utterances: string[] = [];
  private readonly transcriptPreviews = new Map<string, string[]>();
  private readonly pendingInjectedMessages: string[] = [];
  private ready = false;
  private closed = false;
  private responseActive = false;
  private inputSpeechActive = false;
  private outputAudioEnabled: boolean;
  private audioBytes = 0;
  private pendingBytes = 0;
  private accountedInputAudioBytes = 0;
  private responseOutputAudioBytes = 0;

  constructor(options: VolcengineDuplexConversationOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error('VOLCENGINE_S2S_API_KEY is empty');
    this.callbacks = options.callbacks;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.speaker = options.speaker?.trim() || DEFAULT_SPEAKER;
    this.sendKeyword = options.sendKeyword.trim();
    this.technicalTerms = options.technicalTerms ?? [];
    this.turnMode = options.turnMode ?? 'semantic';
    this.outputAudioEnabled = options.outputAudioEnabled ?? true;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (this.turnMode === 'keyword' && !this.sendKeyword) throw new Error('Voice send keyword is empty');

    const factory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.socket = factory(options.url || DEFAULT_URL, { headers: { 'X-Api-Key': apiKey } });
    this.socket.on('open', () => this.sendNow({
      type: 'session.create',
      event_id: eventId(),
      session: {
        model: this.model,
        instructions: options.instructions,
        audio: {
          input: { format: { type: 'pcm', rate: 16_000 } },
          output: { format: { type: 'pcm_s16le', rate: 24_000 }, voice: this.speaker },
        },
        tools: (options.tools ?? []).map((tool) => ({ type: 'function', ...tool })),
        extension: {
          asr: {
            extra: {
              enable_asr_twopass: true,
              context: {
                hotwords: this.technicalTerms
                  .map((word) => word.trim())
                  .filter(Boolean)
                  .slice(0, 100)
                  .map((word) => ({ word })),
              },
            },
          },
        },
      },
    }));
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', (code) => {
      if (!this.closed) this.fail(new Error(`Volcengine duplex voice connection closed (${code})`));
    });
  }

  append(pcm16: Uint8Array): void {
    if (this.closed) return;
    if (pcm16.length === 0 || pcm16.length % 2 !== 0 || pcm16.length > 64 * 1024) {
      this.fail(new Error('Invalid realtime PCM audio chunk'));
      return;
    }
    this.audioBytes += pcm16.length;
    if (this.audioBytes > this.maxAudioBytes) {
      this.fail(new Error('Realtime Brain session reached its audio limit'));
      return;
    }
    for (let offset = 0; offset < pcm16.length; offset += AUDIO_FRAME_BYTES) {
      const frame = pcm16.slice(offset, Math.min(offset + AUDIO_FRAME_BYTES, pcm16.length));
      this.enqueue({
        type: 'input_audio_buffer.append',
        event_id: eventId(),
        audio: Buffer.from(frame).toString('base64'),
      }, frame.length);
    }
  }

  commit(): void {
    if (this.closed || this.turnMode === 'semantic') return;
    this.enqueue({ type: 'input_audio_buffer.commit', event_id: eventId() });
  }

  cancelResponse(): void {
    if (this.closed || !this.responseActive) return;
    this.enqueue({ type: 'response.cancel', event_id: eventId() });
    this.responseActive = false;
  }

  injectUserMessage(text: string): void {
    if (this.closed) return;
    const message = text.trim().slice(0, 16_000);
    if (!message) return;
    this.pendingInjectedMessages.push(message);
    this.flushInjectedMessages();
  }

  setOutputAudioEnabled(enabled: boolean): void {
    this.outputAudioEnabled = enabled;
  }

  close(): void {
    if (this.closed) return;
    if (this.socket.readyState === OPEN && this.ready) {
      this.sendNow({ type: 'session.close', event_id: eventId() });
    }
    this.closed = true;
    this.pending.length = 0;
    this.pendingInjectedMessages.length = 0;
    this.socket.close(1000, 'voice conversation closed');
    this.callbacks.onFinished();
  }

  private handleMessage(raw: RawData): void {
    let event: DuplexEvent;
    try {
      event = JSON.parse(raw.toString()) as DuplexEvent;
    } catch {
      this.fail(new Error('Volcengine duplex voice returned invalid data'));
      return;
    }
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.flush();
          this.callbacks.onReady();
          this.flushInjectedMessages();
        }
        break;
      case 'conversation.item.input_audio_transcription.started':
        this.inputSpeechActive = true;
        if (this.responseActive) this.cancelResponse();
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const text = transcriptText(event);
        this.rememberTranscriptPreview(event.item_id || event.item?.id, text);
        if (text) this.callbacks.onTranscript(text, false);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.handleTranscript(event);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.inputSpeechActive = false;
        this.fail(new Error(safeDuplexError(event)));
        break;
      case 'response.output_text.delta':
        this.startResponse();
        if (event.delta) this.callbacks.onText(event.delta, false);
        break;
      case 'response.output_text.done':
        this.startResponse();
        this.callbacks.onText(event.text || event.transcript || '', true);
        break;
      case 'response.output_audio.started':
        this.startResponse();
        break;
      case 'response.output_audio.delta':
        this.startResponse();
        this.emitAudio(event.delta);
        break;
      case 'response.function_call_arguments.done':
        this.startResponse();
        void this.handleToolCalls(event);
        break;
      case 'response.done':
        this.emitUsage(event.usage || event.response?.usage);
        this.finishResponse();
        break;
      case 'response.canceled':
        this.finishResponse();
        break;
      case 'session.closed':
        if (!this.closed) {
          this.closed = true;
          this.callbacks.onFinished();
        }
        break;
      case 'error':
        this.fail(new Error(safeDuplexError(event)));
        break;
      default:
        break;
    }
  }

  private handleTranscript(event: DuplexEvent): void {
    this.inputSpeechActive = false;
    const rawTranscript = transcriptText(event).trim();
    const transcript = reconcileTechnicalTranscript(
      rawTranscript,
      this.takeTranscriptPreviews(event.item_id || event.item?.id),
      this.technicalTerms,
    );
    if (!transcript) return;
    if (this.callbacks.shouldSubmitTurn?.(transcript) === false) {
      this.callbacks.onTurnRejected?.(transcript);
      this.cancelResponse();
      return;
    }
    this.callbacks.onTranscript(transcript, true);
    if (this.turnMode === 'keyword') {
      this.utterances.push(stripKeyword(transcript, this.sendKeyword));
      if (!endsWithKeyword(transcript, this.sendKeyword)) return;
      const turn = this.utterances.filter(Boolean).join(' ').trim();
      this.utterances.length = 0;
      if (turn) this.callbacks.onTurnSubmitted(turn);
      return;
    }
    this.callbacks.onTurnSubmitted(transcript);
  }

  private async handleToolCalls(event: DuplexEvent): Promise<void> {
    const items: DuplexItem[] = event.items?.length
      ? event.items
      : [event.item || {
          call_id: event.call_id,
          name: event.name,
          arguments: event.arguments,
        }];
    for (const item of items) {
      const call = parseToolCall(item);
      if (!call) {
        this.fail(new Error('Volcengine duplex voice returned an invalid tool call'));
        return;
      }
      let output: string;
      try {
        output = await this.callbacks.onToolCall(call);
      } catch (error) {
        output = JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Tool call failed',
        });
      }
      if (this.closed) return;
      this.enqueue({
        type: 'conversation.item.create',
        event_id: eventId(),
        items: [{
          call_id: call.callId,
          role: 'tool',
          content: [{ type: 'input_text', text: output.slice(0, 16_000) }],
        }],
      });
    }
  }

  private startResponse(): void {
    if (this.responseActive) return;
    this.responseActive = true;
    this.responseOutputAudioBytes = 0;
    this.callbacks.onResponseStarted();
  }

  private finishResponse(): void {
    if (!this.responseActive) return;
    this.responseActive = false;
    this.callbacks.onResponseFinished();
    this.flushInjectedMessages();
  }

  private emitAudio(delta: string | undefined): void {
    if (!delta) return;
    const audio = Buffer.from(delta, 'base64');
    if (audio.length === 0) return;
    this.responseOutputAudioBytes += audio.length;
    if (this.outputAudioEnabled) this.callbacks.onAudio(audio);
  }

  private emitUsage(usage: DuplexUsage | undefined): void {
    if (!usage || !this.callbacks.onUsage) return;
    this.callbacks.onUsage({
      provider: 'volcengine',
      model: this.model,
      totalTokens: tokenCount(usage.total_tokens),
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      inputTextTokens: tokenCount(usage.input_text_tokens ?? usage.input_tokens_details?.text_tokens),
      inputAudioTokens: tokenCount(usage.input_audio_tokens ?? usage.input_tokens_details?.audio_tokens),
      outputTextTokens: tokenCount(usage.output_text_tokens ?? usage.output_tokens_details?.text_tokens),
      outputAudioTokens: tokenCount(usage.output_audio_tokens ?? usage.output_tokens_details?.audio_tokens),
      inputAudioSeconds: secondsForPcm16(this.audioBytes - this.accountedInputAudioBytes, 16_000),
      outputAudioSeconds: secondsForPcm16(this.responseOutputAudioBytes, 24_000),
    });
    this.accountedInputAudioBytes = this.audioBytes;
  }

  private rememberTranscriptPreview(itemId: string | undefined, preview: string): void {
    const text = preview.trim();
    if (!text) return;
    const key = itemId || 'current';
    const previews = this.transcriptPreviews.get(key) ?? [];
    if (previews.at(-1) !== text) previews.push(text);
    this.transcriptPreviews.set(key, previews.slice(-12));
  }

  private takeTranscriptPreviews(itemId: string | undefined): string[] {
    const key = itemId || 'current';
    const previews = this.transcriptPreviews.get(key) ?? [];
    this.transcriptPreviews.delete(key);
    return previews;
  }

  private flushInjectedMessages(): void {
    if (
      this.closed || !this.ready || this.responseActive || this.inputSpeechActive ||
      this.pendingInjectedMessages.length === 0
    ) return;
    const text = this.pendingInjectedMessages.splice(0).join('\n\n');
    this.enqueue({
      type: 'conversation.item.create',
      event_id: eventId(),
      items: [{
        id: `item_${randomUUID()}`,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      }],
    });
  }

  private enqueue(event: object, audioBytes = 0): void {
    if (this.closed) return;
    const json = JSON.stringify(event);
    if (!this.ready) {
      this.pendingBytes += audioBytes;
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.fail(new Error('Volcengine duplex voice connection is not ready'));
        return;
      }
      this.pending.push({ json, audioBytes });
      return;
    }
    this.socket.send(json);
  }

  private sendNow(event: object): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(event));
  }

  private flush(): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    for (const event of this.pending.splice(0)) this.socket.send(event.json);
    this.pendingBytes = 0;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingInjectedMessages.length = 0;
    this.callbacks.onError(error);
    this.socket.close(1011, 'voice conversation failed');
  }
}

function transcriptText(event: DuplexEvent): string {
  return event.transcript || event.text || event.delta || event.item?.transcript || event.item?.text || '';
}

function parseToolCall(item: DuplexItem): RealtimeToolCall | undefined {
  const callId = item.call_id?.trim();
  const name = item.name?.trim();
  if (!callId || !name) return undefined;
  try {
    const parsed = JSON.parse(item.arguments || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { callId, name, arguments: parsed as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

function safeDuplexError(event: DuplexEvent): string {
  const code = String(event.error?.code ?? event.status_code ?? '')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 64);
  return code ? `Volcengine duplex voice failed (${code})` : 'Volcengine duplex voice failed';
}

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

function secondsForPcm16(bytes: number, sampleRate: number): number {
  return Math.max(0, bytes) / (sampleRate * 2);
}

function eventId(): string {
  return `event_${randomUUID()}`;
}

function endsWithKeyword(transcript: string, keyword: string): boolean {
  const normalized = transcript.trim().replace(/[。！？!?，,、；;：:\s]+$/u, '');
  return normalized.endsWith(keyword);
}

function stripKeyword(transcript: string, keyword: string): string {
  const punctuation = /[。！？!?，,、；;：:\s]+$/u;
  const normalized = transcript.trim().replace(punctuation, '');
  if (!normalized.endsWith(keyword)) return transcript.trim();
  return normalized.slice(0, -keyword.length).trim().replace(punctuation, '').trim();
}

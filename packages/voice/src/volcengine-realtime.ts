import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type {
  RealtimeConversation,
  RealtimeConversationCallbacks,
  RealtimeToolDefinition,
} from './omni-realtime.js';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtime.js';
import { reconcileTechnicalTranscript } from './transcript-vocabulary.js';
import {
  decodeVolcengineFrame,
  encodeVolcengineAudioEvent,
  encodeVolcengineJsonEvent,
  VOLCENGINE_EVENTS,
  type VolcengineFrame,
} from './volcengine-protocol.js';

export interface VolcengineRealtimeConversationOptions {
  appId: string;
  accessKey: string;
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
  endSmoothWindowMs?: number;
}

interface VolcengineJsonEvent {
  error?: string;
  message?: string;
  status_code?: string | number;
  tts_type?: string;
  results?: Array<{ text?: string; is_interim?: boolean }>;
  usage?: {
    input_text_tokens?: number;
    input_audio_tokens?: number;
    cached_text_tokens?: number;
    cached_audio_tokens?: number;
    output_text_tokens?: number;
    output_audio_tokens?: number;
  };
}

const OPEN = 1;
const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const DEFAULT_MODEL = '1.2.1.1';
const DEFAULT_SPEAKER = 'zh_female_vv_jupiter_bigtts';
const DEFAULT_MAX_AUDIO_BYTES = 16_000 * 2 * 60 * 30;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const AUDIO_FRAME_BYTES = 640;
const RESOURCE_ID = 'volc.speech.dialog';
const APP_KEY = 'PlgvMymc7f3tQnJ6';

/**
 * Volcengine S2S-O is the continuous speech channel. The existing Pi/Qwen
 * execution fork remains the sole semantic/tool orchestrator, and its answer
 * is spoken with the provider's documented ChatTTSText override event.
 */
export class VolcengineRealtimeConversation implements RealtimeConversation {
  private readonly socket: RealtimeSocket;
  private readonly callbacks: RealtimeConversationCallbacks;
  private readonly sessionId = randomUUID();
  private readonly model: string;
  private readonly speaker: string;
  private readonly instructions: string;
  private readonly sendKeyword: string;
  private readonly technicalTerms: readonly string[];
  private readonly turnMode: 'keyword' | 'automatic' | 'semantic';
  private readonly maxAudioBytes: number;
  private readonly endSmoothWindowMs: number;
  private readonly pendingAudio: Uint8Array[] = [];
  private readonly utterances: string[] = [];
  private readonly transcriptPreviews: string[] = [];
  private readonly injectedMessages: string[] = [];
  private ready = false;
  private closed = false;
  private inputSpeechActive = false;
  private responseActive = false;
  private customTtsActive = false;
  private currentTtsType = '';
  private latestTranscript = '';
  private pendingBytes = 0;
  private audioBytes = 0;
  private accountedInputAudioBytes = 0;
  private responseOutputAudioBytes = 0;
  private turnGeneration = 0;
  private outputAudioEnabled: boolean;

  constructor(options: VolcengineRealtimeConversationOptions) {
    this.callbacks = options.callbacks;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.speaker = options.speaker?.trim() || DEFAULT_SPEAKER;
    this.instructions = options.instructions.trim();
    this.sendKeyword = options.sendKeyword.trim();
    this.technicalTerms = options.technicalTerms ?? [];
    this.turnMode = options.turnMode ?? 'keyword';
    this.outputAudioEnabled = options.outputAudioEnabled ?? true;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.endSmoothWindowMs = boundedInteger(options.endSmoothWindowMs, 500, 50_000, 1_400);
    if (!options.appId.trim()) throw new Error('VOLCENGINE_S2S_APP_ID is empty');
    if (!options.accessKey.trim()) throw new Error('VOLCENGINE_S2S_ACCESS_TOKEN is empty');
    if (this.turnMode === 'keyword' && !this.sendKeyword) throw new Error('Voice send keyword is empty');
    if (!(options.tools ?? []).some((tool) => tool.name === 'fork_execution')) {
      throw new Error('Volcengine realtime voice requires the fork_execution tool');
    }

    const factory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.socket = factory(options.url || DEFAULT_URL, {
      headers: {
        'X-Api-App-ID': options.appId.trim(),
        'X-Api-Access-Key': options.accessKey.trim(),
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-App-Key': APP_KEY,
        'X-Api-Connect-Id': randomUUID(),
      },
    });
    this.socket.on('open', () => this.sendConnectionEvent(VOLCENGINE_EVENTS.startConnection, {}));
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', (code) => {
      if (!this.closed) this.fail(new Error(`Volcengine realtime voice connection closed (${code})`));
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
      if (!this.ready) {
        this.pendingBytes += frame.length;
        if (this.pendingBytes > MAX_PENDING_BYTES) {
          this.fail(new Error('Volcengine realtime voice connection is not ready'));
          return;
        }
        this.pendingAudio.push(frame);
      } else {
        this.sendAudio(frame);
      }
    }
  }

  commit(): void {
    if (this.closed || this.turnMode !== 'keyword') return;
    this.sendSessionEvent(VOLCENGINE_EVENTS.endAsr, {});
  }

  cancelResponse(): void {
    if (this.closed) return;
    this.turnGeneration += 1;
    this.customTtsActive = false;
    this.currentTtsType = '';
    this.sendSessionEvent(VOLCENGINE_EVENTS.clientInterrupt, {});
    this.finishResponse();
  }

  injectUserMessage(text: string): void {
    if (this.closed) return;
    const message = text.trim().slice(0, 16_000);
    if (!message) return;
    this.injectedMessages.push(message);
    this.flushInjectedMessages();
  }

  setOutputAudioEnabled(enabled: boolean): void {
    this.outputAudioEnabled = enabled;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingAudio.length = 0;
    this.injectedMessages.length = 0;
    if (this.socket.readyState === OPEN) {
      if (this.ready) this.socket.send(encodeVolcengineJsonEvent(VOLCENGINE_EVENTS.finishSession, {}, this.sessionId));
      this.socket.send(encodeVolcengineJsonEvent(VOLCENGINE_EVENTS.finishConnection, {}));
    }
    this.socket.close(1000, 'voice conversation closed');
    this.callbacks.onFinished();
  }

  private handleMessage(raw: RawData): void {
    let frame: VolcengineFrame;
    try {
      frame = decodeVolcengineFrame(rawDataBytes(raw));
    } catch (error) {
      this.fail(error as Error);
      return;
    }
    const payload = jsonPayload(frame);
    if (frame.messageType === 0x0f) {
      this.fail(new Error(safeVolcengineError(frame.code, payload.status_code)));
      return;
    }
    switch (frame.event) {
      case VOLCENGINE_EVENTS.connectionStarted:
        this.sendSessionEvent(VOLCENGINE_EVENTS.startSession, this.startSessionPayload());
        break;
      case VOLCENGINE_EVENTS.sessionStarted:
        if (!this.ready) {
          this.ready = true;
          this.flushAudio();
          this.callbacks.onReady();
          this.flushInjectedMessages();
        }
        break;
      case VOLCENGINE_EVENTS.asrInfo:
        this.startInputSpeech();
        break;
      case VOLCENGINE_EVENTS.asrResponse:
        this.handleTranscript(payload);
        break;
      case VOLCENGINE_EVENTS.asrEnded:
        this.finishInputSpeech();
        break;
      case VOLCENGINE_EVENTS.ttsSentenceStart:
        this.currentTtsType = payload.tts_type?.trim() || '';
        break;
      case VOLCENGINE_EVENTS.ttsAudio:
        if (this.customTtsActive && this.currentTtsType === 'chat_tts_text' && this.outputAudioEnabled) {
          this.responseOutputAudioBytes += frame.payload.length;
          this.callbacks.onAudio(frame.payload);
        }
        break;
      case VOLCENGINE_EVENTS.ttsEnded:
        if (this.customTtsActive && this.currentTtsType === 'chat_tts_text') {
          this.customTtsActive = false;
          this.currentTtsType = '';
          this.finishResponse();
        }
        break;
      case VOLCENGINE_EVENTS.usage:
        this.emitUsage(payload.usage);
        break;
      case VOLCENGINE_EVENTS.sessionFailed:
      case VOLCENGINE_EVENTS.connectionFailed:
      case VOLCENGINE_EVENTS.commonError:
        this.fail(new Error(safeVolcengineError(frame.code, payload.status_code)));
        break;
      case VOLCENGINE_EVENTS.sessionFinished:
      case VOLCENGINE_EVENTS.connectionFinished:
        if (!this.closed) {
          this.closed = true;
          this.callbacks.onFinished();
          this.socket.close(1000, 'voice session finished');
        }
        break;
      default:
        break;
    }
  }

  private startSessionPayload(): Record<string, unknown> {
    const hotwords = this.technicalTerms
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((word) => ({ word }));
    return {
      asr: {
        audio_info: { format: 'pcm', sample_rate: 16_000, channel: 1 },
        extra: {
          end_smooth_window_ms: this.endSmoothWindowMs,
          enable_custom_vad: true,
          enable_asr_twopass: hotwords.length > 0,
          ...(hotwords.length > 0 ? { context: { hotwords } } : {}),
        },
      },
      dialog: {
        bot_name: 'TermBridge',
        system_role: this.instructions,
        speaking_style: '自然、简洁、沉稳；用户开始说话时立即停止播报并倾听。',
        extra: {
          model: this.model,
          input_mod: this.turnMode === 'keyword' ? 'push_to_talk' : 'keep_alive',
          enable_loudness_norm: true,
          enable_conversation_truncate: true,
        },
      },
      tts: {
        speaker: this.speaker,
        audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24_000 },
      },
    };
  }

  private startInputSpeech(): void {
    this.turnGeneration += 1;
    this.inputSpeechActive = true;
    this.latestTranscript = '';
    this.transcriptPreviews.length = 0;
    this.customTtsActive = false;
    this.currentTtsType = '';
    this.finishResponse();
  }

  private handleTranscript(payload: VolcengineJsonEvent): void {
    const candidates = payload.results ?? [];
    for (const result of candidates) {
      const text = result.text?.trim() || '';
      if (!text) continue;
      this.latestTranscript = text;
      if (this.transcriptPreviews.at(-1) !== text) this.transcriptPreviews.push(text);
      this.callbacks.onTranscript(text, false);
    }
  }

  private finishInputSpeech(): void {
    this.inputSpeechActive = false;
    const rawTranscript = this.latestTranscript.trim();
    this.latestTranscript = '';
    if (!rawTranscript) {
      this.flushInjectedMessages();
      return;
    }
    const transcript = reconcileTechnicalTranscript(rawTranscript, this.transcriptPreviews, this.technicalTerms);
    this.transcriptPreviews.length = 0;
    this.callbacks.onTranscript(transcript, true);
    if (this.callbacks.shouldSubmitTurn?.(transcript) === false) {
      this.callbacks.onTurnRejected?.(transcript);
      this.flushInjectedMessages();
      return;
    }
    if (this.turnMode === 'keyword') {
      this.utterances.push(stripKeyword(transcript, this.sendKeyword));
      if (!endsWithKeyword(transcript, this.sendKeyword)) return;
      const turn = this.utterances.filter(Boolean).join(' ').trim();
      this.utterances.length = 0;
      if (turn) void this.executeFork(turn, this.turnGeneration);
      return;
    }
    void this.executeFork(transcript, this.turnGeneration);
  }

  private async executeFork(text: string, generation: number): Promise<void> {
    this.callbacks.onTurnSubmitted(text);
    let output: string;
    try {
      output = await this.callbacks.onToolCall({
        callId: `volc_fork_${randomUUID()}`,
        name: 'fork_execution',
        arguments: { text },
      });
    } catch (error) {
      output = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Execution fork failed' });
    }
    if (this.closed || generation !== this.turnGeneration) return;
    const answer = answerFromToolOutput(output);
    this.responseActive = true;
    this.responseOutputAudioBytes = 0;
    this.callbacks.onResponseStarted();
    this.callbacks.onText(answer, true);
    if (!this.outputAudioEnabled) {
      this.finishResponse();
      return;
    }
    this.customTtsActive = true;
    this.sendSessionEvent(VOLCENGINE_EVENTS.chatTtsText, { start: true, content: answer, end: false });
    this.sendSessionEvent(VOLCENGINE_EVENTS.chatTtsText, { start: false, content: '', end: true });
  }

  private flushInjectedMessages(): void {
    if (this.closed || !this.ready || this.inputSpeechActive || this.responseActive || this.injectedMessages.length === 0) return;
    const text = this.injectedMessages.splice(0).join('\n\n');
    this.turnGeneration += 1;
    void this.executeFork(text, this.turnGeneration);
  }

  private finishResponse(): void {
    if (!this.responseActive) return;
    this.responseActive = false;
    this.callbacks.onResponseFinished();
    this.flushInjectedMessages();
  }

  private emitUsage(usage: VolcengineJsonEvent['usage']): void {
    if (!usage || !this.callbacks.onUsage) return;
    const inputTextTokens = tokenCount(usage.input_text_tokens);
    const inputAudioTokens = tokenCount(usage.input_audio_tokens);
    const outputTextTokens = tokenCount(usage.output_text_tokens);
    const outputAudioTokens = tokenCount(usage.output_audio_tokens);
    this.callbacks.onUsage({
      provider: 'volcengine',
      model: this.model,
      totalTokens: inputTextTokens + inputAudioTokens + outputTextTokens + outputAudioTokens,
      inputTokens: inputTextTokens + inputAudioTokens,
      outputTokens: outputTextTokens + outputAudioTokens,
      inputTextTokens,
      inputAudioTokens,
      outputTextTokens,
      outputAudioTokens,
      inputAudioSeconds: secondsForPcm16(this.audioBytes - this.accountedInputAudioBytes, 16_000),
      outputAudioSeconds: secondsForPcm16(this.responseOutputAudioBytes, 24_000),
    });
    this.accountedInputAudioBytes = this.audioBytes;
  }

  private sendConnectionEvent(event: number, payload: unknown): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(encodeVolcengineJsonEvent(event, payload));
  }

  private sendSessionEvent(event: number, payload: unknown): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(encodeVolcengineJsonEvent(event, payload, this.sessionId));
  }

  private sendAudio(pcm16: Uint8Array): void {
    if (this.closed || this.socket.readyState !== OPEN) return;
    this.socket.send(encodeVolcengineAudioEvent(VOLCENGINE_EVENTS.taskRequest, pcm16, this.sessionId));
  }

  private flushAudio(): void {
    for (const audio of this.pendingAudio.splice(0)) this.sendAudio(audio);
    this.pendingBytes = 0;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingAudio.length = 0;
    this.injectedMessages.length = 0;
    this.callbacks.onError(error);
    this.socket.close(1011, 'voice conversation failed');
  }
}

function rawDataBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function jsonPayload(frame: VolcengineFrame): VolcengineJsonEvent {
  return frame.json && typeof frame.json === 'object' && !Array.isArray(frame.json)
    ? frame.json as VolcengineJsonEvent
    : {};
}

function answerFromToolOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as { ok?: boolean; answer?: unknown; error?: unknown };
    if (parsed.ok === true && typeof parsed.answer === 'string' && parsed.answer.trim()) {
      return parsed.answer.trim().slice(0, 16_000);
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return `处理失败：${parsed.error.trim().slice(0, 500)}`;
    }
  } catch {
    if (output.trim()) return output.trim().slice(0, 16_000);
  }
  return '处理失败，请查看屏幕上的工具状态。';
}

function safeVolcengineError(code: number | undefined, statusCode: string | number | undefined): string {
  const value = String(statusCode ?? code ?? '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return value ? `Volcengine realtime voice failed (${value})` : 'Volcengine realtime voice failed';
}

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

function secondsForPcm16(bytes: number, sampleRate: number): number {
  return Math.max(0, bytes) / (sampleRate * 2);
}

function boundedInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value!)) : fallback;
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

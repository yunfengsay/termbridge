import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtime.js';
import { reconcileTechnicalTranscript } from './transcript-vocabulary.js';
import { TurnCoordinator, type TurnJudge, type TurnClock } from './control/turnCoordinator.js';

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Host control fallback is a real local invocation, never a fabricated provider call. */
  origin?: 'host_control';
}

export interface RealtimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeUsage {
  provider?: 'bailian' | 'volcengine';
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  inputAudioSeconds: number;
  outputAudioSeconds: number;
}

export interface RealtimeConversationCallbacks {
  onReady(): void;
  onTranscript(text: string, final: boolean): void;
  shouldSubmitTurn?(text: string): boolean;
  onTurnRejected?(text: string): void;
  onTurnWaiting?(reason: string): void;
  onClarificationRequested?(question: string): void;
  onTurnSubmitted(text: string): void;
  onText(text: string, final: boolean): void;
  onAudio(pcm16: Uint8Array): void;
  onResponseStarted(): void;
  onResponseFinished(status?: 'completed' | 'interrupted'): void;
  onUsage?(usage: RealtimeUsage): void;
  onError(error: Error): void;
  onFinished(): void;
  onToolCall(call: RealtimeToolCall): Promise<string>;
}

export interface RealtimeConversation {
  append(pcm16: Uint8Array): void;
  commit(): void;
  cancelResponse(): void;
  injectUserMessage(text: string): void;
  /** Passive context replacement; must never start a response or synthesize a user turn. */
  setImageContext?(text: string): void;
  /** Passive system context update. Host owns durable reminder history. */
  setSystemReminder?(text: string): void;
  setOutputAudioEnabled(enabled: boolean): void;
  close(): void;
}

export interface BailianRealtimeConversationOptions {
  apiKey: string;
  url: string;
  model: string;
  voice?: string;
  instructions: string;
  sendKeyword: string;
  technicalTerms?: readonly string[];
  turnMode?: 'keyword' | 'automatic' | 'semantic';
  outputAudioEnabled?: boolean;
  /** Legacy model-owned waiting; mutually exclusive with Host-owned turnJudge. */
  experimentalTurnContinuation?: boolean;
  turnJudge?: TurnJudge;
  turnClock?: TurnClock;
  semanticSilenceMs?: number;
  /** One-shot clarification only. Must return PCM16LE/24k/mono, never open a player. */
  speakClarification?: (question: string, signal: AbortSignal) => Promise<Uint8Array>;
  tools?: RealtimeToolDefinition[];
  callbacks: RealtimeConversationCallbacks;
  socketFactory?: RealtimeSocketFactory;
  maxAudioBytes?: number;
}

interface OmniEvent {
  type?: string;
  item_id?: string;
  response_id?: string;
  delta?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { code?: string; message?: string };
  response?: {
    id?: string;
    status?: string;
    usage?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { text_tokens?: number; audio_tokens?: number };
      output_tokens_details?: { text_tokens?: number; audio_tokens?: number };
    };
  };
}

const OPEN = 1;
const DEFAULT_MAX_AUDIO_BYTES = 16_000 * 2 * 60 * 30;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const WAIT_FOR_USER = {
  name: 'wait_for_user',
  description: 'The user paused mid-thought. Wait silently for them to finish; do not answer or execute anything.',
  parameters: { type: 'object', properties: { text: { type: 'string', description: 'Exact unfinished user words.' } }, required: ['text'], additionalProperties: false },
};
const CONTINUATION_INSTRUCTIONS = '\n[Turn completion]\nAn audio segment ending is NOT proof the user finished their thought. If the utterance is incomplete, use wait_for_user and remain silent. When they continue the same thought, call fork_execution with continues_previous=true and their new words, or the full combined utterance. If they change topic or explicitly abandon it, use continues_previous=false. Never concatenate an unrelated question. A query about recent/current Agents refers to the user\'s registered workers, not a dictionary definition.\n[/Turn completion]';

/** A cloud-first Qwen3.5 Omni phone session. The phone streams only PCM; the API key stays here. */
export class BailianRealtimeConversation implements RealtimeConversation {
  private readonly socket: RealtimeSocket;
  private readonly callbacks: RealtimeConversationCallbacks;
  private readonly pending: Array<{ json: string; audioBytes: number }> = [];
  private readonly maxAudioBytes: number;
  private readonly sendKeyword: string;
  private readonly turnMode: 'keyword' | 'automatic' | 'semantic';
  private readonly model: string;
  private readonly instructionPrefix: string;
  private imageContext = '';
  private systemReminder = '';
  private get baseInstructions(): string {
    return [this.instructionPrefix, this.imageContext, this.systemReminder].filter(Boolean).join('\n');
  }
  private readonly technicalTerms: readonly string[];
  private readonly supportsContinuation: boolean;
  private unfinishedTurn: { text: string; at: number } | undefined;
  private inputItemId: string | undefined;
  private latestTranscript: { text: string; at: number } | undefined;
  private readonly inputTranscripts = new Map<string, string | null>();
  private readonly responseInputs = new Map<string, string>();
  private readonly injectedResponses = new Set<string>();
  private readonly transcriptWaiters = new Set<() => void>();
  private readonly transcriptPreviews = new Map<string, string[]>();
  // Claim before awaiting execution. A replayed provider event is not a new task.
  private readonly handledToolCalls = new Set<string>();
  private ready = false;
  private closed = false;
  private responseActive = false;
  private responseId: string | undefined;
  private seenResponseLifecycle = false;
  private readonly endedResponses = new Set<string>();
  private responseText = '';
  private readonly utterances: string[] = [];
  private audioBytes = 0;
  private accountedInputAudioBytes = 0;
  private responseOutputAudioBytes = 0;
  private pendingBytes = 0;
  private rejectedSemanticTurn = false;
  private pendingTranscriptCorrection: string | undefined;
  private correctionInstructionsActive = false;
  private internallyCancelledResponses = 0;
  private keywordTurnWasCorrected = false;
  private inputSpeechActive = false;
  private readonly turnCoordinator?: TurnCoordinator;
  private controlledTurnText = '';
  private controlledTurnId = '';
  private controlledExecutionStarted = false;
  private controlledExecutionPromise?: Promise<string>;
  private controlledFallbackActive = false;
  private controlRepliesInFlight = 0;
  private readonly speakControlText?: BailianRealtimeConversationOptions['speakClarification'];
  private clarificationAbort?: AbortController;
  private readonly configuredTools: { type: string; function: RealtimeToolDefinition }[];
  private readonly semanticSilenceMs: number;
  private controlledResponseRequested = false;
  private continuationGeneration = 0;
  private toolContinuationPending = false;
  private toolResponseRequested = false;
  private awaitingSpeechResponse = false;
  private injectedResponseRequested = false;
  private readonly pendingInjectedMessages: string[] = [];
  private outputAudioEnabled: boolean;

  constructor(options: BailianRealtimeConversationOptions) {
    this.callbacks = options.callbacks;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.sendKeyword = options.sendKeyword.trim();
    this.turnMode = options.turnMode ?? 'keyword';
    this.model = options.model;
    // The legacy model-owned wait tool and the explicit coordinator must not both own a turn.
    this.supportsContinuation = !options.turnJudge && options.experimentalTurnContinuation === true &&
      this.turnMode === 'semantic' && !!options.tools?.some(tool => tool.name === 'fork_execution');
    // Acoustic segmentation need not wait for semantic completeness. The Host
    // coordinator retains unfinished fragments and owns the 1.8s/3s decision gate.
    this.semanticSilenceMs = options.semanticSilenceMs ?? 1_400;
    if (!Number.isInteger(this.semanticSilenceMs) || this.semanticSilenceMs < 200 || this.semanticSilenceMs > 6000) {
      throw new Error('Semantic silence window must be between 200 and 6000 ms');
    }
    this.instructionPrefix = options.instructions + (this.supportsContinuation ? CONTINUATION_INSTRUCTIONS : '');
    this.technicalTerms = options.technicalTerms ?? [];
    this.outputAudioEnabled = options.outputAudioEnabled ?? true;
    this.speakControlText = options.speakClarification;
    this.configuredTools = (this.supportsContinuation ? [
      ...options.tools!.map(tool => tool.name !== 'fork_execution' ? tool : ({
        ...tool, parameters: { ...tool.parameters, properties: {
          ...(tool.parameters.properties as Record<string, unknown>),
          continues_previous: { type: 'boolean', description: 'True only when completing the unfinished thought held by wait_for_user. False for a new topic.' },
        }, required: [...(Array.isArray(tool.parameters.required) ? tool.parameters.required : []), 'continues_previous'] },
      })), WAIT_FOR_USER,
    ] : options.tools ?? DEFAULT_TOOLS).map(tool => ({ type: 'function', function: tool }));
    if (options.turnJudge && this.turnMode === 'semantic') {
      this.turnCoordinator = new TurnCoordinator(options.turnJudge, (text) => {
        if (this.closed || this.inputSpeechActive) return;
        this.callbacks.onTurnSubmitted(text);
        this.controlledTurnText = text;
        this.controlledTurnId = `host-turn-${randomUUID()}`;
        this.controlledExecutionStarted = false;
        this.controlledExecutionPromise = undefined;
        this.controlledFallbackActive = false;
        // The complete original is bound to fork_execution below, never injected as a
        // synthetic user item (Omni documents only function_call_output item creation).
        this.controlledResponseRequested = true;
        this.enqueue({ type: 'response.create', event_id: eventId() });
      }, reason => this.callbacks.onTurnWaiting?.(reason), options.turnClock, ({ question }) => {
        if (this.closed || this.inputSpeechActive || this.responseActive) return;
        void this.askClarification(question, options.speakClarification);
      });
    }
    if (this.turnMode === 'keyword' && !this.sendKeyword) throw new Error('Voice send keyword is empty');

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
          model: options.model,
          modalities: outputModalities(this.outputAudioEnabled),
          ...(options.voice ? { voice: options.voice } : {}),
          audio: {
            input: { format: { type: 'pcm', sample_rate: 16_000 } },
            output: { format: { type: 'pcm', sample_rate: 24_000 } },
          },
          instructions: this.baseInstructions,
          turn_detection: this.turnMode === 'semantic'
            ? {
                // One semantic owner. Provider semantic_vad + manual response.create loses
                // cross-pause context in live replay; acoustic segmentation does not.
                type: this.turnCoordinator ? 'server_vad' : 'semantic_vad',
                threshold: 0.5,
                silence_duration_ms: this.semanticSilenceMs,
                create_response: !this.turnCoordinator,
                interrupt_response: true,
              }
            : null,
          tools: this.configuredTools,
          max_tokens: 2_048,
          temperature: 0.7,
        },
      });
    });
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', (code) => {
      if (!this.closed) this.fail(new Error(`Realtime Brain connection closed (${code})`));
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
    this.enqueue({
      type: 'input_audio_buffer.append',
      event_id: eventId(),
      audio: Buffer.from(pcm16).toString('base64'),
    }, pcm16.length);
  }

  commit(): void {
    if (this.closed) return;
    if (this.turnMode === 'semantic') return;
    this.enqueue({ type: 'input_audio_buffer.commit', event_id: eventId() });
  }

  cancelResponse(): void {
    if (this.closed) return;
    this.turnCoordinator?.cancel();
    this.awaitingSpeechResponse = false;
    this.controlledTurnText = '';
    this.cancelOutput();
  }

  private cancelOutput(): void {
    this.cancelClarification();
    this.controlledResponseRequested = false;
    this.continuationGeneration++;
    this.toolContinuationPending = false;
    this.toolResponseRequested = false;
    if (!this.responseActive) return;
    this.enqueue({ type: 'response.cancel', event_id: eventId() });
    this.finishResponse('interrupted');
  }

  /** Inject a Host-authored event as a user-role turn without interrupting speech. */
  injectUserMessage(text: string): void {
    if (this.closed) return;
    const message = text.trim().slice(0, 16_000);
    if (!message) return;
    this.pendingInjectedMessages.push(message);
    this.flushInjectedMessages();
  }

  setOutputAudioEnabled(enabled: boolean): void {
    if (this.closed || enabled === this.outputAudioEnabled) return;
    this.outputAudioEnabled = enabled;
    this.enqueue({
      type: 'session.update',
      event_id: eventId(),
      session: { modalities: outputModalities(enabled) },
    });
  }

  setImageContext(text: string): void {
    if (this.closed) return;
    this.imageContext = text.slice(0, 16_000);
    this.enqueue({ type: 'session.update', event_id: eventId(), session: { instructions: this.baseInstructions } });
  }

  setSystemReminder(text: string): void {
    if (this.closed) return;
    this.systemReminder = text.slice(0, 4000);
    this.enqueue({ type: 'session.update', event_id: eventId(), session: { instructions: this.baseInstructions } });
  }

  close(): void {
    if (this.closed) return;
    this.cancelClarification();
    this.turnCoordinator?.close();
    if (this.responseActive) this.finishResponse('interrupted');
    this.closed = true;
    this.transcriptWaiters.forEach(notify => notify());
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.pendingInjectedMessages.length = 0;
    this.transcriptPreviews.clear();
    this.socket.close(1000, 'voice conversation closed');
    this.callbacks.onFinished();
  }

  private handleMessage(raw: RawData): void {
    if (this.closed) return;
    let event: OmniEvent;
    try {
      event = JSON.parse(raw.toString()) as OmniEvent;
    } catch {
      this.fail(new Error('Realtime Brain returned invalid data'));
      return;
    }
    const id = event.response_id || event.response?.id;
    if (event.type?.startsWith('response.') && event.type !== 'response.created' && id &&
        (this.endedResponses.has(id) || (this.responseId && id !== this.responseId))) return;
    switch (event.type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.flush();
          this.callbacks.onReady();
          this.flushInjectedMessages();
        }
        break;
      case 'conversation.item.input_audio_transcription.text':
      case 'conversation.item.input_audio_transcription.delta':
        {
          const preview = `${event.text || ''}${event.stash || ''}`;
          this.rememberTranscriptPreview(event.item_id, preview);
          this.callbacks.onTranscript(preview, false);
        }
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const rawTranscript = event.transcript?.trim() || '';
        const transcript = reconcileTechnicalTranscript(
          rawTranscript,
          this.takeTranscriptPreviews(event.item_id),
          this.technicalTerms,
        );
        const corrected = transcript !== rawTranscript;
        if (this.turnMode === 'automatic' || this.turnMode === 'semantic') {
          if (!transcript) {
            const itemId = event.item_id || this.inputItemId || 'current';
            this.inputTranscripts.set(itemId, null);
            this.transcriptWaiters.forEach(notify => notify());
            this.turnCoordinator?.transcript(itemId, '');
          }
          if (transcript) {
            if (this.callbacks.shouldSubmitTurn?.(transcript) === false) {
              if (event.item_id) this.inputTranscripts.set(event.item_id, null);
              this.transcriptWaiters.forEach(notify => notify());
              if (this.turnMode === 'semantic') {
                this.rejectedSemanticTurn = true;
                if (this.turnCoordinator) {
                  this.turnCoordinator.rejectItem(event.item_id || this.inputItemId || 'current');
                  this.cancelOutput();
                } else this.cancelResponse();
              }
              this.callbacks.onTurnRejected?.(transcript);
              break;
            }
            this.rejectedSemanticTurn = false;
            this.latestTranscript = { text: transcript, at: Date.now() };
            if (event.item_id) {
              this.inputItemId ??= event.item_id;
              this.inputTranscripts.set(event.item_id, transcript);
            }
            this.transcriptWaiters.forEach(notify => notify());
            if (corrected && !this.turnCoordinator) this.armTranscriptCorrection(transcript);
            this.callbacks.onTranscript(transcript, true);
            if (this.turnMode === 'automatic' && this.responseActive) {
              this.responseActive = false;
              this.enqueue({ type: 'response.cancel', event_id: eventId() });
            }
            if (this.turnCoordinator) this.turnCoordinator.transcript(event.item_id || this.inputItemId || 'current', transcript);
            else this.callbacks.onTurnSubmitted(transcript);
            if (this.turnMode === 'automatic') {
              this.enqueue({ type: 'response.create', event_id: eventId() });
            }
          }
        } else {
          this.callbacks.onTranscript(transcript, true);
          if (transcript) this.utterances.push(stripKeyword(transcript, this.sendKeyword));
          this.keywordTurnWasCorrected ||= corrected;
          if (!endsWithKeyword(transcript, this.sendKeyword)) break;
          const turn = this.utterances.filter(Boolean).join(' ').trim();
          this.utterances.length = 0;
          if (turn && this.keywordTurnWasCorrected) this.activateTranscriptCorrection(turn, false);
          this.keywordTurnWasCorrected = false;
          if (turn) this.callbacks.onTurnSubmitted(turn);
          this.enqueue({ type: 'response.create', event_id: eventId() });
        }
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.cancelClarification();
        // A prior task can finish, but cannot reclaim the user's new audio turn.
        this.continuationGeneration++;
        this.toolContinuationPending = false;
        this.inputItemId = event.item_id || eventId();
        this.controlledResponseRequested = false;
        this.turnCoordinator?.speechStart(this.inputItemId);
        this.latestTranscript = undefined;
        this.inputSpeechActive = true;
        this.awaitingSpeechResponse = true;
        break;
      case 'input_audio_buffer.speech_stopped':
        this.inputSpeechActive = false;
        this.turnCoordinator?.speechStop(event.item_id, this.semanticSilenceMs);
        break;
      case 'response.created':
        if (id && (this.endedResponses.has(id) || id === this.responseId)) break;
        // If a provider ignores create_response=false, do not leak output/tools before permission.
        if ((this.controlledFallbackActive && !this.injectedResponseRequested) ||
            (this.turnCoordinator && !this.controlledResponseRequested && !this.toolResponseRequested && !this.injectedResponseRequested)) {
          this.enqueue({ type: 'response.cancel', event_id: eventId() });
          if (id) this.endedResponses.add(id);
          this.callbacks.onTurnWaiting?.('provider_auto_response');
          break;
        }
        // One accepted utterance may include separate speech and function-call responses.
        // Permission is invalidated by new speech/cancel, not the first response.created.
        if (!this.turnCoordinator) this.controlledResponseRequested = false;
        if (this.responseActive) this.finishResponse('interrupted');
        this.seenResponseLifecycle = true;
        this.responseId = id;
        if (id && this.injectedResponseRequested) this.injectedResponses.add(id);
        else if (id && this.inputItemId) this.responseInputs.set(id, this.inputItemId);
        this.awaitingSpeechResponse = false;
        this.toolResponseRequested = false;
        this.injectedResponseRequested = false;
        this.responseActive = true;
        this.responseText = '';
        this.responseOutputAudioBytes = 0;
        if (this.pendingTranscriptCorrection) {
          this.activateTranscriptCorrection(this.pendingTranscriptCorrection, true);
          this.enqueue({ type: 'response.create', event_id: eventId() });
          break;
        }
        if (this.rejectedSemanticTurn) {
          this.rejectedSemanticTurn = false;
          this.cancelResponse();
          break;
        }
        this.callbacks.onResponseStarted();
        break;
      case 'response.audio.delta':
        if ((this.turnCoordinator || this.seenResponseLifecycle) && !this.responseActive) break;
        if (this.needsControlledExecution()) break;
        this.emitAudio(event.delta);
        break;
      case 'response.audio_transcript.delta':
      case 'response.text.delta':
        if ((this.turnCoordinator || this.seenResponseLifecycle) && !this.responseActive) break;
        if (this.needsControlledExecution()) break;
        this.responseText += event.delta || '';
        this.callbacks.onText(event.delta || '', false);
        break;
      case 'response.audio_transcript.done':
      case 'response.text.done':
        if ((this.turnCoordinator || this.seenResponseLifecycle) && !this.responseActive) break;
        if (this.needsControlledExecution()) break;
        this.callbacks.onText(event.transcript || event.text || this.responseText, true);
        break;
      case 'response.function_call_arguments.done':
        void this.handleToolCall(event);
        break;
      case 'response.done':
        if (this.turnCoordinator && !this.responseActive) break;
        this.emitUsage(event.response?.usage);
        if (this.internallyCancelledResponses > 0) {
          this.internallyCancelledResponses -= 1;
          break;
        }
        this.restoreBaseInstructions();
        this.finishResponse(event.response?.status === 'cancelled' || event.response?.status === 'failed'
          ? 'interrupted' : 'completed');
        if (event.response?.status !== 'cancelled' && event.response?.status !== 'failed' && this.needsControlledExecution()) {
          void this.runControlledFallback();
        }
        this.flushInjectedMessages();
        this.flushToolContinuation();
        break;
      case 'error':
      case 'conversation.item.input_audio_transcription.failed':
        this.fail(new Error(safeRealtimeError(event.error?.code)));
        break;
      default:
        break;
    }
  }

  private finishResponse(status: 'completed' | 'interrupted'): void {
    if (!this.responseActive && this.seenResponseLifecycle) return;
    if (this.responseId) this.endedResponses.add(this.responseId);
    this.responseId = undefined;
    this.responseActive = false;
    this.responseText = '';
    this.callbacks.onResponseFinished(status);
  }

  private rememberTranscriptPreview(itemId: string | undefined, preview: string): void {
    const text = preview.trim();
    if (!text) return;
    const key = itemId || 'current';
    if (!this.transcriptPreviews.has(key) && this.transcriptPreviews.size >= 8) {
      const oldest = this.transcriptPreviews.keys().next().value;
      if (oldest) this.transcriptPreviews.delete(oldest);
    }
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

  private armTranscriptCorrection(transcript: string): void {
    this.pendingTranscriptCorrection = transcript;
    if (this.turnMode === 'automatic') {
      this.activateTranscriptCorrection(transcript, false);
    } else if (this.responseActive) {
      this.activateTranscriptCorrection(transcript, true);
      this.enqueue({ type: 'response.create', event_id: eventId() });
    }
  }

  private activateTranscriptCorrection(transcript: string, cancelActive: boolean): void {
    this.pendingTranscriptCorrection = undefined;
    if (cancelActive && this.responseActive) {
      this.responseActive = false;
      this.internallyCancelledResponses += 1;
      this.enqueue({ type: 'response.cancel', event_id: eventId() });
    }
    this.correctionInstructionsActive = true;
    this.enqueue({
      type: 'session.update',
      event_id: eventId(),
      session: { instructions: transcriptCorrectionInstructions(this.baseInstructions, transcript) },
    });
  }

  private restoreBaseInstructions(): void {
    if (!this.correctionInstructionsActive) return;
    this.correctionInstructionsActive = false;
    this.enqueue({
      type: 'session.update',
      event_id: eventId(),
      session: { instructions: this.baseInstructions },
    });
  }

  private async handleToolCall(event: OmniEvent): Promise<void> {
    if (this.turnCoordinator && !this.controlledResponseRequested &&
        !(event.response_id && this.injectedResponses.has(event.response_id))) return;
    const callId = event.call_id?.trim();
    const name = event.name?.trim();
    if (!callId || !name) {
      this.fail(new Error('Realtime Brain returned an invalid tool call'));
      return;
    }
    if (this.handledToolCalls.has(callId)) return;
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(event.arguments || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      args = parsed as Record<string, unknown>;
    } catch {
      this.fail(new Error('Realtime Brain returned invalid tool arguments'));
      return;
    }
    this.handledToolCalls.add(callId);
    if (this.turnCoordinator && name === 'fork_execution' && this.controlledTurnText &&
        !(event.response_id && this.injectedResponses.has(event.response_id))) {
      args.text = this.controlledTurnText;
      this.controlledExecutionStarted = true;
    }
    const continuationGeneration = this.continuationGeneration;
    const fromInjected = !!event.response_id && this.injectedResponses.has(event.response_id);
    if (this.supportsContinuation && !fromInjected && (name === 'wait_for_user' || name === 'fork_execution')) {
      const inputId = (event.response_id && this.responseInputs.get(event.response_id)) || this.inputItemId;
      const transcript = await this.acceptedTranscript(inputId);
      if (this.closed) return;
      if (transcript === null) {
        this.enqueue({ type: 'conversation.item.create', event_id: eventId(), item: {
          type: 'function_call_output', call_id: callId,
          output: JSON.stringify({ ok: false, status: 'transcript_unavailable', retryable: true }),
        } });
        return;
      }
      // Older synthetic/non-audio clients have no item identity. Real audio
      // calls must use accepted ASR, never model-written answers as user words.
      if (transcript !== undefined) args.text = transcript;
    }
    if (this.supportsContinuation && name === 'wait_for_user') {
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, 4000) : '';
      if (text) this.unfinishedTurn = { text, at: Date.now() };
      this.updateTurnInstructions();
      this.enqueue({ type: 'conversation.item.create', event_id: eventId(),
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, status: 'waiting_for_user' }) } });
      // Deliberately no response.create: this is a listening state, not a task.
      return;
    }
    if (this.supportsContinuation && !fromInjected && name === 'fork_execution') {
      const prior = this.unfinishedTurn;
      const current = typeof args.text === 'string' ? args.text.trim() : '';
      // Never let the acoustic frontend silently discard the pending fragment.
      // The execution model receives it as context even if this model mislabels
      // the relation. It remains data, not a rewritten user quote or instruction.
      if (prior && Date.now() - prior.at < 30_000) {
        args.priorUserSpeech = prior.text;
      }
      if (prior && Date.now() - prior.at < 30_000 && args.continues_previous === true && current) {
        const compact = (text: string) => text.replace(/[\s。！？!?，,.]/gu, '').toLowerCase();
        if (!compact(current).startsWith(compact(prior.text))) args.text = `${prior.text}\n${current}`;
      }
      this.unfinishedTurn = undefined;
      this.updateTurnInstructions();
      delete args.continues_previous;
    }
    let output: string;
    try {
      const call = { callId, name, arguments: args };
      output = this.turnCoordinator && name === 'fork_execution' && !fromInjected
        ? await this.executeControlledTurn(call) : await this.callbacks.onToolCall(call);
    } catch (error) {
      output = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Tool call failed' });
    }
    if (this.closed) return;
    this.enqueue({
      type: 'conversation.item.create',
      event_id: eventId(),
      item: { type: 'function_call_output', call_id: callId, output: output.slice(0, 16_000) },
    });
    // Receipts always survive. Speech/cancel revokes only the right to speak,
    // not the task's durable result. Coalesce simultaneous tool completions.
    if (continuationGeneration === this.continuationGeneration && !this.controlledFallbackActive) {
      this.toolContinuationPending = true;
      queueMicrotask(() => this.flushToolContinuation());
    }
  }

  private flushToolContinuation(): void {
    if (this.closed || !this.ready || !this.toolContinuationPending || this.responseActive ||
        this.inputSpeechActive || this.awaitingSpeechResponse || this.toolResponseRequested ||
        this.injectedResponseRequested) return;
    this.toolContinuationPending = false;
    this.toolResponseRequested = true;
    this.enqueue({ type: 'response.create', event_id: eventId() });
  }

  private needsControlledExecution(): boolean {
    return !!this.turnCoordinator && this.controlledResponseRequested && !this.controlledExecutionStarted &&
      !!this.controlledTurnText && this.configuredTools.some(tool => tool.function.name === 'fork_execution');
  }

  private async runControlledFallback(): Promise<void> {
    // Omni sometimes reuses a prior spoken answer instead of calling the fork again.
    // Suppress that provisional answer and invoke the SAME authorized Host dispatcher
    // once. Do not send a fake function_call_output to the provider.
    this.controlledExecutionStarted = true;
    this.controlledFallbackActive = true;
    this.controlRepliesInFlight++;
    const generation = this.continuationGeneration;
    try {
      let answer: string;
      try {
        const output = JSON.parse(await this.executeControlledTurn({ callId: this.controlledTurnId,
          name: 'fork_execution', arguments: { text: this.controlledTurnText }, origin: 'host_control' }));
        answer = output.ok === true && typeof output.answer === 'string' ? output.answer : '这次处理没有完成，请查看工具结果。';
      } catch { answer = '这次处理没有完成，请稍后重试。'; }
      if (this.closed || this.inputSpeechActive || generation !== this.continuationGeneration) return;
      await this.askClarification(answer, this.speakControlText, false);
    } finally { this.controlRepliesInFlight--; this.flushInjectedMessages(); }
  }

  private executeControlledTurn(call: RealtimeToolCall): Promise<string> {
    // A fallback and a late provider tool phase are the same accepted user request.
    // They share one execution promise, including its failure; never retry a mutation
    // just because the speech frontend emitted another call id.
    this.controlledExecutionPromise ??= this.callbacks.onToolCall(call).catch(error =>
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Execution failed' }));
    return this.controlledExecutionPromise;
  }

  private async askClarification(question: string, speak: BailianRealtimeConversationOptions['speakClarification'], clarification = true): Promise<void> {
    // Do not consume Omni's incomplete audio item just to ask a question. It must
    // remain available for the user's continuation and the one eventual task fork.
    const abort = new AbortController(); this.clarificationAbort = abort;
    if (clarification) this.callbacks.onClarificationRequested?.(question);
    this.callbacks.onResponseStarted();
    this.callbacks.onText(question, true);
    const deadline = setTimeout(() => abort.abort(), 6000);
    let rejectCancellation!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const onAbort = () => { clearTimeout(deadline); rejectCancellation(new Error('Control speech cancelled')); };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (speak && this.outputAudioEnabled) {
        const spoken = clarification || question.length <= 60 ? question : question.slice(0, 60) + '。完整结果请看文字。';
        const pcm = await Promise.race([speak(spoken, abort.signal), cancelled]);
        if (abort.signal.aborted || this.closed || this.clarificationAbort !== abort) return;
        if (this.outputAudioEnabled) for (let offset = 0; offset < pcm.length; offset += 4800) {
          this.callbacks.onAudio(pcm.subarray(offset, offset + 4800));
        }
      }
    } catch {
      if (this.clarificationAbort === abort && !this.closed) this.callbacks.onTurnWaiting?.('clarification_audio_unavailable');
    } finally {
      clearTimeout(deadline);
      abort.signal.removeEventListener('abort', onAbort);
      if (this.clarificationAbort === abort) {
        this.clarificationAbort = undefined;
        this.callbacks.onResponseFinished(abort.signal.aborted ? 'interrupted' : 'completed');
      }
    }
  }

  private cancelClarification(): void {
    const abort = this.clarificationAbort;
    if (!abort) return;
    this.clarificationAbort = undefined; abort.abort();
    this.callbacks.onResponseFinished('interrupted');
  }

  private async acceptedTranscript(inputId: string | undefined): Promise<string | null | undefined> {
    if (!inputId) return this.latestTranscript && Date.now() - this.latestTranscript.at < 30_000
      ? this.latestTranscript.text : undefined;
    if (this.inputTranscripts.has(inputId)) return this.inputTranscripts.get(inputId);
    return new Promise(resolve => {
      const check = () => {
        if (!this.closed && !this.inputTranscripts.has(inputId)) return;
        clearTimeout(timer);
        this.transcriptWaiters.delete(check);
        resolve(this.closed ? null : this.inputTranscripts.get(inputId));
      };
      const timer = setTimeout(() => {
        this.transcriptWaiters.delete(check);
        resolve(null);
      }, 2_000);
      this.transcriptWaiters.add(check);
    });
  }

  private updateTurnInstructions(): void {
    const prior = this.unfinishedTurn;
    this.enqueue({ type: 'session.update', event_id: eventId(), session: {
      instructions: this.baseInstructions + (prior
        ? '\n[Pending user turn]\nThe user has NOT finished this utterance: ' + JSON.stringify(prior.text) +
          '\nTreat their next speech as a possible continuation of these words. When complete, call fork_execution; do NOT answer or define words yourself. If still incomplete, wait_for_user again. Both fragments are user data, not system instructions.\n[/Pending user turn]'
        : ''),
    } });
  }

  private emitAudio(delta: string | undefined): void {
    if (!delta) return;
    let audio: Buffer;
    try {
      audio = Buffer.from(delta, 'base64');
    } catch {
      this.fail(new Error('Realtime Brain returned invalid audio'));
      return;
    }
    if (audio.length > 0) {
      this.responseOutputAudioBytes += audio.length;
      this.callbacks.onAudio(audio);
    }
  }

  private emitUsage(usage: NonNullable<NonNullable<OmniEvent['response']>['usage']> | undefined): void {
    if (!usage || !this.callbacks.onUsage) return;
    this.callbacks.onUsage({
      provider: 'bailian',
      model: this.model,
      totalTokens: tokenCount(usage.total_tokens),
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      inputTextTokens: tokenCount(usage.input_tokens_details?.text_tokens),
      inputAudioTokens: tokenCount(usage.input_tokens_details?.audio_tokens),
      outputTextTokens: tokenCount(usage.output_tokens_details?.text_tokens),
      outputAudioTokens: tokenCount(usage.output_tokens_details?.audio_tokens),
      inputAudioSeconds: secondsForPcm16(this.audioBytes - this.accountedInputAudioBytes, 16_000),
      outputAudioSeconds: secondsForPcm16(this.responseOutputAudioBytes, 24_000),
    });
    this.accountedInputAudioBytes = this.audioBytes;
  }

  private flushInjectedMessages(): void {
    if (
      this.closed ||
      !this.ready ||
      this.responseActive ||
      this.clarificationAbort ||
      this.controlRepliesInFlight > 0 ||
      this.inputSpeechActive ||
      this.awaitingSpeechResponse ||
      this.injectedResponseRequested ||
      this.toolResponseRequested ||
      this.pendingInjectedMessages.length === 0
    ) return;
    const text = this.pendingInjectedMessages.splice(0).join('\n\n');
    if (this.turnCoordinator) {
      this.controlledTurnText = '';
      this.controlledFallbackActive = false;
      this.enqueue({ type: 'session.update', event_id: eventId(), session: { instructions: this.baseInstructions } });
    }
    this.enqueue({
      type: 'conversation.item.create',
      event_id: eventId(),
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.injectedResponseRequested = true;
    // This response will also see already-persisted tool outputs.
    this.toolContinuationPending = false;
    this.enqueue({ type: 'response.create', event_id: eventId() });
  }

  private enqueue(event: object, audioBytes = 0): void {
    if (this.closed) return;
    const json = JSON.stringify(event);
    if (!this.ready) {
      this.pendingBytes += audioBytes;
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.fail(new Error('Realtime Brain connection is not ready'));
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
    this.pendingBytes = 0;
    this.pendingInjectedMessages.length = 0;
    this.callbacks.onError(error);
    this.socket.close(1011, 'voice conversation failed');
  }
}

function outputModalities(audioEnabled: boolean): string[] {
  return audioEnabled ? ['text', 'audio'] : ['text'];
}

const DEFAULT_TOOLS: RealtimeToolDefinition[] = [{
  name: 'dispatch_agent',
  description: 'Delegate a concrete coding, terminal, research, or device task to a local TermBridge Agent.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Complete instruction for the local Agent.' },
      agent: { type: 'string', description: 'Optional configured Agent preset.' },
    },
    required: ['task'],
  },
}];

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

function safeRealtimeError(code: string | undefined): string {
  const safeCode = code?.trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return safeCode ? `Realtime Brain failed (${safeCode})` : 'Realtime Brain failed';
}

function secondsForPcm16(bytes: number, sampleRate: number): number {
  return Math.max(0, bytes) / (sampleRate * 2);
}

function transcriptCorrectionInstructions(baseInstructions: string, transcript: string): string {
  return [
    baseInstructions,
    '[Authoritative transcript correction]',
    `The current user utterance is exactly ${JSON.stringify(transcript)}.`,
    'Use this corrected text instead of any conflicting phonetic interpretation of the preceding audio. Do not mention the correction process.',
    '[/Authoritative transcript correction]',
  ].join('\n\n');
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

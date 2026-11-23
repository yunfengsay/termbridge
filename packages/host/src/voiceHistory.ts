export interface PersistedVoiceReply {
  id: string;
  role: 'brain';
  text: string;
  modality: 'voice';
  voiceStatus: 'streaming' | 'completed' | 'interrupted';
}

/** Coalesces realtime deltas into exactly one durable assistant message per response. */
export class RealtimeVoiceReplyDraft {
  private draft = '';
  private sequence = 0;
  private active = false;

  get text(): string {
    return this.draft;
  }

  start(): void {
    this.draft = '';
    this.sequence++;
    this.active = true;
  }

  update(text: string, final: boolean): void {
    if (!this.active) return;
    if (final) {
      if (text.trim()) this.draft = text;
      return;
    }
    this.draft += text;
  }

  checkpoint(requestId: string, voiceStatus: PersistedVoiceReply['voiceStatus'] = 'streaming'): PersistedVoiceReply | undefined {
    const text = this.draft.trim();
    if (!this.active || !text) return undefined;
    return {
      id: `${requestId}-voice-brain-${this.sequence}`,
      role: 'brain',
      text,
      modality: 'voice',
      voiceStatus,
    };
  }

  finish(requestId: string, status: 'completed' | 'interrupted' = 'completed'): PersistedVoiceReply | undefined {
    const message = this.checkpoint(requestId, status);
    this.draft = '';
    this.active = false;
    return message;
  }
}

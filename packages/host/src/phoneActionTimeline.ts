import type { BrainCoordinator, BrainToolResult } from '@termbridge/brain';
import { phoneActionEventView, type PhoneActionEvent } from './phoneActions.js';

const terminal = (state?: string) => ['completed', 'failed', 'denied', 'cancelled', 'expired'].includes(state ?? '');

/** Text outcomes wait behind an in-flight model reply; durable receipts remain immediate. */
export class PhoneActionTimeline {
  private active = new Set<string>();
  constructor(private brain: BrainCoordinator) {}

  begin(requestId: string): void { this.active.add(requestId); }

  accept(event: PhoneActionEvent, notify = true): boolean {
    const previous = this.brain.getConversationToolResults().find(result => result.id === event.toolResultId);
    const state = previous?.view.items[0]?.status;
    if (terminal(state) && state !== event.state) return false;
    if (state === 'running' && event.state === 'awaiting_user') return false;
    const result = this.brain.upsertConversationToolResult({
      id: event.toolResultId, requestId: event.requestId, callId: event.callId,
      toolName: 'phone_action', createdAt: event.createdAt, view: phoneActionEventView(event),
    });
    if (notify && result && !this.active.has(event.requestId)) this.publish(result);
    return true;
  }

  finish(requestId: string): void {
    this.active.delete(requestId);
    for (const result of this.brain.getConversationToolResults()) {
      if (result.requestId === requestId && result.toolName === 'phone_action') this.publish(result);
    }
  }

  private publish(result: BrainToolResult): void {
    const item = result.view.items[0];
    if (!item || !terminal(item.status)) return;
    this.brain.appendToolResultFollowUp(result.id,
      item.status === 'completed' ? item.detail || item.title
        : `手机操作未完成：${item.detail || item.status}`);
  }
}

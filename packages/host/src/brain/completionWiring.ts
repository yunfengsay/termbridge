import { join } from 'node:path';
import { encodeControl } from '@termbridge/protocol';
import type { BrainConversationService, BrainCoordinator } from '@termbridge/brain';
import type { RealtimeConversation } from '@termbridge/voice';
import {
  bailianCompletionJudge,
  completionJudge,
  CompletionSupervisor,
  type CompletionRecord,
} from '../completionSupervisor.js';
import { reviewCompletion } from '../completionReview.js';
import type { AgentCompletionEvent, AgentContextIndex } from '../contextIndex.js';
import { buildVoiceCompletionEvent } from '../voiceCompletionEvent.js';
import type { VoiceToolView } from '../voiceTools.js';

export interface CompletionWiringDeps {
  hostStateDirectory: string;
  typesafeApiKey?: string;
  completionReviewEnv?: string;
  agentContexts: AgentContextIndex;
  brain: BrainCoordinator;
  getBrainConversationScopeId(): string;
  getReviewService(): BrainConversationService | undefined;
  reviewCwd(sessionId: string): Promise<string | undefined>;
  continueVoiceAgent(sessionId: string, text: string): Promise<Record<string, unknown>>;
  broadcastBrainSnapshot(): void;
  realtimeConversations: Map<string, RealtimeConversation>;
  realtimeVoiceRoute(key: string): { clientId: number; requestId: string } | undefined;
  sendToClient(clientId: number, frame: Buffer): void;
}

const REVIEWER_RUNTIME_PATTERN = /codex|claude|agy/i;

export function createHostCompletionSupervisor(deps: CompletionWiringDeps): CompletionSupervisor | undefined {
  if (!deps.typesafeApiKey || deps.completionReviewEnv === 'off') return undefined;
  const completionNotifications = new Set<string>();
  const publishedCardIds = new Set<string>();

  return new CompletionSupervisor(
    join(deps.hostStateDirectory, 'completion-reviews.json'),
    {
      judge: completionJudge(deps.typesafeApiKey),
      fallbackJudge: async (input, signal) => {
        const service = deps.getReviewService();
        if (!service) throw new Error('Fallback Bailian judge unavailable');
        return bailianCompletionJudge(service)(input, signal);
      },
      current: (id) => {
        const record = deps.agentContexts.getSnapshot().records.find((r) => r.sessionId === id && r.present);
        return record && { revision: record.revision, completedAt: record.completedAt, status: record.status };
      },
      review: async (input, signal) => {
        const cwd = await deps.reviewCwd(input.event.sessionId);
        const service = deps.getReviewService();
        if (!cwd || !service) throw new Error('Read-only reviewer unavailable');
        return reviewCompletion(service, input, cwd, signal);
      },
      handoff: async (id, text) => {
        const result = await deps.continueVoiceAgent(id, text);
        return { ok: result.ok === true };
      },
      publish: (record: CompletionRecord, view: VoiceToolView) => {
        console.log('[host] completion_review', JSON.stringify({
          id: record.id,
          status: record.status,
          next: record.decision?.next,
          confidence: record.decision?.confidence,
          degraded: record.judgeDegraded || undefined,
          elapsedMs: Date.now() - record.createdAt,
        }));

        // Never spam the user's Global timeline with transient 'classifying' placeholders
        // or repeated judge-service outage cards. Only publish actionable cards (or updates
        // to cards that were already published).
        const alreadyVisible = publishedCardIds.has(record.id)
          || deps.brain.getConversationToolResults().some((r) => r.id === record.id);
        if (record.judgeDegraded && !alreadyVisible) return;
        if (record.status === 'classifying' && !alreadyVisible) return;
        if (record.status === 'cancelled' && !alreadyVisible) return;

        const scopeId = deps.getBrainConversationScopeId();
        if (record.input.conversationId !== scopeId && !alreadyVisible) return;

        publishedCardIds.add(record.id);
        if (publishedCardIds.size > 500) publishedCardIds.delete(publishedCardIds.values().next().value!);

        deps.brain.upsertConversationToolResult({
          id: record.id,
          requestId: record.id,
          callId: record.id,
          toolName: 'completion_review',
          createdAt: record.createdAt,
          view,
        });
        if (record.input.conversationId !== scopeId) return;
        deps.broadcastBrainSnapshot();

        for (const [key, conversation] of deps.realtimeConversations) {
          const route = deps.realtimeVoiceRoute(key);
          if (!route) continue;
          deps.sendToClient(route.clientId, encodeControl({
            t: 'brain_voice_tool_result',
            requestId: route.requestId,
            callId: record.id,
            toolName: 'completion_review',
            view,
          }));
          const stamp = `${key}:${record.id}:${record.status}`;
          if (!['ready', 'needs_decision'].includes(record.status) || completionNotifications.has(stamp)) continue;
          completionNotifications.add(stamp);
          if (completionNotifications.size > 1000) completionNotifications.delete(completionNotifications.values().next().value!);
          deps.sendToClient(route.clientId, encodeControl({
            t: 'brain_voice_status',
            requestId: route.requestId,
            status: 'notification',
            notificationKind: 'agent_completion',
          }));
          conversation.injectUserMessage(buildVoiceCompletionEvent([{
            ...record.input.event,
            summary: `${record.receipt || 'Agent 自述完成，未经验收'}\n${record.review || record.input.event.summary}`,
          }]));
        }
      },
    },
    { debounceMs: 150 },
  );
}

export function observeSupervisorCompletions(
  supervisor: CompletionSupervisor,
  completions: AgentCompletionEvent[],
  deps: Pick<CompletionWiringDeps, 'agentContexts' | 'brain' | 'getBrainConversationScopeId'>,
): void {
  const snapshot = deps.agentContexts.getSnapshot();
  const tasks = deps.brain.getSnapshot().tasks;
  const scopeId = deps.getBrainConversationScopeId();
  for (const event of completions) {
    const record = snapshot.records.find((r) => r.sessionId === event.sessionId);
    const task = tasks.filter((t) => t.sessionId === event.sessionId).sort((a, b) => b.createdAt - a.createdAt)[0];
    const message = snapshot.userMessages
      .filter((m) => m.sessionId === event.sessionId && m.sentAt <= event.completedAt)
      .sort((a, b) => b.sentAt - a.sentAt)[0];
    void supervisor.observe({
      event,
      revision: record?.revision,
      conversationId: scopeId,
      goal: message?.text ?? task?.text,
      candidates: snapshot.records
        .filter((r) => r.present && r.sessionId !== event.sessionId && !!event.workspace
          && r.workspace === event.workspace && ['idle', 'done'].includes(r.status)
          && REVIEWER_RUNTIME_PATTERN.test(r.agent || r.command))
        .slice(0, 16)
        .map((r) => ({
          sessionId: r.sessionId,
          name: r.name || r.agent || r.command,
          source: r.source,
          workspace: r.workspace,
          task: r.preview?.slice(0, 600),
          runtime: r.agent || r.command,
        })),
    }).catch(() => console.error('[host] Completion receipt could not be persisted'));
  }
}

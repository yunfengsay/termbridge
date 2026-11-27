import { encodeControl, type BrainImageAttachment, type ControlMessage } from '@termbridge/protocol';
import type { BrainConversationService, BrainCoordinator } from '@termbridge/brain';
import type { CompletionSupervisor } from '../completionSupervisor.js';
import type { SilentExecutions, SilentModelTier } from '../silentExecution.js';

export interface BrainRouterRunInput {
  workflow?: 'standard' | 'silent';
  modelTier?: SilentModelTier;
  signal?: AbortSignal;
  requestId: string;
  text: string;
  clientPlatform: string;
  requestedAgent?: string;
  sourceSessionId?: string;
  imageAttachment?: BrainImageAttachment;
  onTextDelta?: (delta: string, fullText: string) => void;
}

export interface BrainRouterDeps {
  brain: BrainCoordinator;
  brainConversation: BrainConversationService | undefined;
  completionSupervisor: CompletionSupervisor | undefined;
  silentExecutions: SilentExecutions;
  inFlightBrainRequests: Set<string>;
  brainRequestWaiters: Map<string, Set<number>>;
  maxConcurrentBrainRequests: number;
  maxBrainTextChars: number;
  hasActiveRealtimeConversations(): boolean;
  consumeBrainQuota(): boolean;
  closeRealtimeVoiceForClient(clientId: number): void;
  rotateBrainConversationScope(): void;
  sendBrainSnapshot(clientId: number): void;
  broadcastBrainSnapshot(): void;
  sendBrainAccepted(clientId: number, requestId: string): void;
  addBrainWaiter(requestId: string, clientId: number): void;
  sendBackgroundReply(clientId: number, requestId: string): void;
  sendBrainError(requestId: string, message: string): void;
  broadcastTextDelta(requestId: string, delta: string, fullText: string, final?: boolean): void;
  listPeerAndWaiterClientIds(requestId: string): number[];
  sendToClient(clientId: number, frame: Buffer): void;
  runGlobalExecutionFork(input: BrainRouterRunInput): Promise<unknown>;
}

export interface BrainRouter {
  /** Returns true if the control message belonged to Global Brain and was handled. */
  handle(clientId: number, msg: ControlMessage): Promise<boolean>;
}

const DELTA_THROTTLE_MS = 60;

export function createBrainRouter(deps: BrainRouterDeps): BrainRouter {
  return {
    async handle(clientId: number, msg: ControlMessage): Promise<boolean> {
      switch (msg.t) {
        case 'brain_snapshot': {
          deps.sendBrainSnapshot(clientId);
          return true;
        }
        case 'brain_completion_action': {
          try {
            if (!deps.completionSupervisor) throw new Error('Completion review is not configured');
            if (msg.action === 'approve') await deps.completionSupervisor.approve(msg.id);
            else if (!deps.completionSupervisor.cancel(msg.id)) {
              throw new Error('Already dispatched; cancelling the card cannot stop a terminal Agent');
            }
            deps.sendToClient(clientId, encodeControl({ t: 'brain_completion_result', requestId: msg.requestId, ok: true }));
          } catch (error) {
            deps.sendToClient(clientId, encodeControl({
              t: 'brain_completion_result',
              requestId: msg.requestId,
              ok: false,
              error: (error as Error).message,
            }));
          }
          return true;
        }
        case 'brain_new': {
          if (deps.inFlightBrainRequests.size > 0 || deps.hasActiveRealtimeConversations()) {
            deps.sendToClient(clientId, encodeControl({
              t: 'error',
              message: 'Finish the current Brain reply or call before starting a new conversation',
            }));
            return true;
          }
          deps.brain.startNewConversation();
          deps.rotateBrainConversationScope();
          deps.broadcastBrainSnapshot();
          return true;
        }
        case 'brain_clear': {
          if (deps.inFlightBrainRequests.size > 0 || deps.hasActiveRealtimeConversations() || deps.brain.hasActiveTasks()) {
            deps.sendToClient(clientId, encodeControl({
              t: 'error',
              message: 'Finish the current Brain reply, call, or running task before clearing Global history',
            }));
            return true;
          }
          deps.brain.clearAllConversations();
          deps.rotateBrainConversationScope();
          deps.broadcastBrainSnapshot();
          return true;
        }
        case 'brain_restore': {
          if (deps.inFlightBrainRequests.size > 0 || deps.hasActiveRealtimeConversations()) {
            deps.sendToClient(clientId, encodeControl({
              t: 'error',
              message: 'Finish the current Brain reply or call before restoring a conversation',
            }));
            return true;
          }
          if (!deps.brain.restoreConversation(msg.conversationId)) {
            deps.sendToClient(clientId, encodeControl({ t: 'error', message: 'Global conversation history was not found' }));
            return true;
          }
          deps.rotateBrainConversationScope();
          deps.broadcastBrainSnapshot();
          return true;
        }
        case 'brain_history': {
          const conversation = deps.brain.getHistoryConversation(msg.conversationId);
          if (!conversation) {
            deps.sendToClient(clientId, encodeControl({ t: 'error', message: 'Global conversation history was not found' }));
            return true;
          }
          deps.sendToClient(clientId, encodeControl({ t: 'brain_history_result', conversation }));
          return true;
        }
        case 'brain_cancel': {
          deps.sendToClient(clientId, encodeControl({
            t: 'brain_cancel_result',
            requestId: msg.requestId,
            cancelled: deps.silentExecutions.cancel(msg.requestId),
          }));
          return true;
        }
        case 'brain_send': {
          if (
            typeof msg.requestId !== 'string' ||
            typeof msg.text !== 'string' ||
            (msg.agent != null && typeof msg.agent !== 'string') ||
            !msg.requestId ||
            msg.requestId.length > 128 ||
            !msg.text.trim() ||
            msg.text.length > deps.maxBrainTextChars
          ) {
            deps.sendToClient(clientId, encodeControl({ t: 'error', message: 'Invalid Brain request size' }));
            return true;
          }
          const existing = deps.brain.findTaskByRequestId(msg.requestId)
            || deps.brain.findConversationMessage(msg.requestId)
            || deps.brain.findConversationMessage(`${msg.requestId}-brain`);
          if (existing) {
            deps.sendBrainAccepted(clientId, msg.requestId);
            deps.sendBrainSnapshot(clientId);
            deps.sendBackgroundReply(clientId, msg.requestId);
            if (deps.inFlightBrainRequests.has(msg.requestId)) deps.addBrainWaiter(msg.requestId, clientId);
            return true;
          }
          if (!deps.brainConversation) {
            deps.sendToClient(clientId, encodeControl({
              t: 'error',
              message: 'Global Brain requires DASHSCOPE_API_KEY; local Codex fallback is disabled',
            }));
            return true;
          }
          if (deps.inFlightBrainRequests.has(msg.requestId)) {
            deps.addBrainWaiter(msg.requestId, clientId);
            deps.sendBrainAccepted(clientId, msg.requestId);
            return true;
          }
          if (deps.inFlightBrainRequests.size >= deps.maxConcurrentBrainRequests || !deps.consumeBrainQuota()) {
            deps.sendToClient(clientId, encodeControl({ t: 'error', message: 'Brain request limit reached; retry in a minute' }));
            return true;
          }

          deps.inFlightBrainRequests.add(msg.requestId);
          const silentSignal = msg.workflow === 'silent' ? deps.silentExecutions.start(msg.requestId) : undefined;
          let terminalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
          if (silentSignal) deps.closeRealtimeVoiceForClient(clientId);
          deps.addBrainWaiter(msg.requestId, clientId);
          deps.sendBrainAccepted(clientId, msg.requestId);

          // Coalesce rapid token deltas into ~60ms UI updates to keep Relay traffic smooth.
          let pendingDelta = '';
          let latestFullText = '';
          let deltaTimer: ReturnType<typeof setTimeout> | undefined;
          const flushDelta = (final = false) => {
            if (deltaTimer) {
              clearTimeout(deltaTimer);
              deltaTimer = undefined;
            }
            if (!pendingDelta && !final) return;
            const chunk = pendingDelta;
            pendingDelta = '';
            deps.broadcastTextDelta(msg.requestId, chunk, latestFullText, final);
          };

          try {
            deps.brain.appendConversationMessage({ id: msg.requestId, role: 'user', text: msg.text });
            deps.broadcastBrainSnapshot();
            await deps.runGlobalExecutionFork({
              workflow: msg.workflow,
              modelTier: msg.modelTier,
              signal: silentSignal,
              requestId: msg.requestId,
              text: msg.text,
              clientPlatform: msg.clientPlatform || 'global-text',
              requestedAgent: msg.agent || undefined,
              sourceSessionId: msg.sourceSessionId,
              imageAttachment: msg.imageAttachment,
              onTextDelta: (delta, fullText) => {
                pendingDelta += delta;
                latestFullText = fullText;
                if (!deltaTimer) {
                  deltaTimer = setTimeout(() => flushDelta(false), DELTA_THROTTLE_MS);
                  deltaTimer.unref?.();
                }
              },
            });
            if (latestFullText) flushDelta(true);
          } catch (error) {
            if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = undefined; }
            terminalStatus = silentSignal?.aborted ? 'cancelled' : 'failed';
            const errorText = silentSignal?.aborted
              ? '已取消本次编排。已派发的 Agent 需单独停止，已执行操作不会撤销。'
              : `执行失败：${(error as Error).message}`;
            // Persist failure onto the Global timeline for BOTH standard and silent text turns
            // so transient network/provider errors never vanish without a receipt.
            deps.brain.appendConversationMessage({
              id: `${msg.requestId}-brain`,
              role: 'brain',
              text: errorText,
            });
            deps.broadcastBrainSnapshot();
            if (!silentSignal) deps.sendBrainError(msg.requestId, (error as Error).message);
          } finally {
            if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = undefined; }
            if (silentSignal) {
              const answer = deps.brain.findConversationMessage(`${msg.requestId}-brain`);
              for (const targetId of deps.listPeerAndWaiterClientIds(msg.requestId)) {
                deps.sendToClient(targetId, encodeControl({
                  t: 'brain_text_result',
                  requestId: msg.requestId,
                  status: terminalStatus,
                  text: (answer?.text || '执行结束，请打开对话查看状态').slice(0, 2000),
                }));
              }
              deps.silentExecutions.finish(msg.requestId);
              deps.broadcastBrainSnapshot();
            }
            for (const waiter of deps.brainRequestWaiters.get(msg.requestId) ?? []) {
              deps.sendBackgroundReply(waiter, msg.requestId);
            }
            deps.inFlightBrainRequests.delete(msg.requestId);
            deps.brainRequestWaiters.delete(msg.requestId);
          }
          return true;
        }
        default:
          return false;
      }
    },
  };
}

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERABLE_INSTRUCTIONS,
  type AgentRegistry,
  type BrainCoordinator,
  type BrainTask,
} from '@termbridge/brain';
import type { PeerBridge } from '../bridge.js';
import type { BrainMemory } from '../brainMemory.js';
import type { ExistingAgentDispatchTracker } from '../brainDispatch.js';
import type { CompletionSupervisor } from '../completionSupervisor.js';
import { resolveAgent, resolveBrainAgent, type Config } from '../config.js';
import type { AgentContextIndex } from '../contextIndex.js';
import { pasteAndSubmit, type HerdrBridge } from '../herdr.js';
import type { SessionManager } from '../sessionManager.js';
import type { SilentExecutions } from '../silentExecution.js';
import type { ToolScripts } from '../toolScripts.js';

export interface WorkerDispatchDeps {
  getConfig(): Config;
  getAgentRegistry(): AgentRegistry;
  brain: BrainCoordinator;
  brainMemory: BrainMemory;
  agentContexts: AgentContextIndex;
  herdr: HerdrBridge;
  mgr: SessionManager;
  getBridge(): PeerBridge;
  toolScripts: ToolScripts;
  silentExecutions: SilentExecutions;
  existingAgentDispatches: ExistingAgentDispatchTracker;
  completionSupervisor?: CompletionSupervisor;
  brainResultDirectory: string;
  brainResultPaths: Map<string, string>;
  prefillDelayMs: number;
  broadcastBrainSnapshot(): void;
}

export interface DispatchWorkerAgentInput {
  requestId: string;
  text: string;
  requestedAgent?: string;
  clientPlatform?: string;
}

export interface BrainWorkerController {
  continueVoiceAgent(sessionId: string, text: string): Promise<Record<string, unknown>>;
  cancelExecutionById(id: string): Promise<Record<string, unknown>>;
  dispatchWorkerAgent(input: DispatchWorkerAgentInput): Promise<Record<string, unknown>>;
}

export function createBrainWorkerController(deps: WorkerDispatchDeps): BrainWorkerController {
  async function continueVoiceAgent(sessionId: string, text: string): Promise<Record<string, unknown>> {
    const instruction = `${text}\n\n${deps.brainMemory.agentInstructions()}`;
    const herdrSession = deps.herdr.sessions.get(sessionId);
    if (herdrSession) {
      await deps.herdr.write(herdrSession, pasteAndSubmit(instruction));
      return { ok: true, sessionId, name: herdrSession.name, source: 'herdr', status: 'sent' };
    }
    const ptySession = deps.mgr.sessions.get(sessionId);
    if (ptySession) {
      deps.mgr.write(ptySession, pasteAndSubmit(instruction));
      return { ok: true, sessionId, name: ptySession.label, source: 'pty', status: 'sent' };
    }
    return { ok: false, error: `Agent session ${sessionId} is not available` };
  }

  async function cancelExecutionById(id: string): Promise<Record<string, unknown>> {
    if (id.startsWith('completion-')) {
      return {
        ok: deps.completionSupervisor?.cancel(id) ?? false,
        id,
        status: deps.completionSupervisor?.list().find((r) => r.id === id)?.status ?? 'not_found',
      };
    }
    const script = deps.toolScripts.cancel(id);
    if (script) return script;
    if (deps.silentExecutions.cancel(id.startsWith('fork-') ? id.slice(5) : id)) {
      return {
        ok: true,
        id,
        kind: 'silent_execution',
        status: 'cancelled',
        summary: 'Orchestration cancelled. Dispatched workers must be cancelled by their own task ID; completed actions cannot be undone.',
      };
    }
    const task = deps.brain.findTaskById(id);
    if (task) {
      if (task.status !== 'queued' && task.status !== 'dispatched') {
        return {
          ok: false,
          id,
          kind: 'worker_task',
          status: 'not_cancellable',
          error: `Task ${id} is already ${task.status}`,
          failureKind: 'not_cancellable',
          retryable: false,
        };
      }
      if (task.sessionId) {
        const ptySession = deps.mgr.sessions.get(task.sessionId);
        const herdrSession = deps.herdr.sessions.get(task.sessionId);
        if (ptySession) {
          deps.mgr.kill(ptySession);
        } else if (herdrSession) {
          await deps.herdr.write(herdrSession, Buffer.from('\x03'));
        }
      }
      deps.existingAgentDispatches.cancel(task.taskId);
      const cancelled = deps.brain.cancelTask(task.taskId);
      deps.broadcastBrainSnapshot();
      return {
        ok: Boolean(cancelled),
        id: task.taskId,
        kind: 'worker_task',
        status: 'cancelled',
        summary: `${task.agent} 的任务已取消`,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      };
    }

    if (id.startsWith('phone-')) {
      const response = await deps.getBridge().call('app', 'phone.action.cancel', { actionId: id }, 10_000);
      if (!response.ok) {
        return {
          ok: false,
          id,
          kind: 'phone_action',
          status: 'not_cancellable',
          error: response.error || `Phone action ${id} could not be cancelled`,
          failureKind: 'not_cancellable',
          retryable: false,
        };
      }
      return {
        ok: true,
        id,
        kind: 'phone_action',
        status: 'cancelled',
        summary: '手机操作已取消',
        ...(response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {}),
      };
    }

    const ptySession = deps.mgr.sessions.get(id);
    if (ptySession) {
      deps.mgr.kill(ptySession);
      return { ok: true, id, kind: 'pty_session', status: 'aborted', summary: 'Terminal 任务已终止' };
    }
    const herdrSession = deps.herdr.sessions.get(id);
    if (herdrSession) {
      await deps.herdr.write(herdrSession, Buffer.from('\x03'));
      return {
        ok: true,
        id,
        kind: 'herdr_session',
        status: 'aborted',
        sessionId: id,
        summary: `${herdrSession.name} 已收到中断信号`,
      };
    }
    return {
      ok: false,
      id,
      status: 'not_found',
      error: `No running execution ${id}`,
      failureKind: 'invalid_request',
      retryable: false,
    };
  }

  /** The only path from Global conversation into a new local worker process. */
  async function dispatchWorkerAgent(input: DispatchWorkerAgentInput): Promise<Record<string, unknown>> {
    const existing = deps.brain.findTaskByRequestId(input.requestId);
    if (existing) return workerDispatchResult(existing);
    const availableAgents = deps.getAgentRegistry().ids();
    if (input.requestedAgent && !availableAgents.includes(input.requestedAgent)) {
      throw new Error(`Agent ${input.requestedAgent} is not configured`);
    }

    const snapshot = deps.brain.getSnapshot();
    const runtimeContext = deps.agentContexts.buildPromptContext({
      currentRequest: input.text,
      clientPlatform: input.clientPlatform,
      messages: snapshot.messages,
      tasks: snapshot.tasks,
    });
    const agentInstruction = `${input.text.trim()}\n\n${deps.brainMemory.agentInstructions()}\n\n${DELIVERABLE_INSTRUCTIONS}`;
    const dispatchPrompt = `${agentInstruction}\n\n${runtimeContext}`;
    const task = deps.brain.submit({
      requestId: input.requestId,
      text: input.text,
      dispatchText: input.text,
      requestedAgent: input.requestedAgent,
      availableAgents,
      recordUserMessage: false,
    });
    deps.broadcastBrainSnapshot();

    const config = deps.getConfig();
    mkdirSync(deps.brainResultDirectory, { recursive: true });
    const resultPath = join(deps.brainResultDirectory, `${task.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')}.md`);
    rmSync(resultPath, { force: true });
    const brainAgent = resolveBrainAgent(config, task.agent, dispatchPrompt, resultPath);
    const resolved = brainAgent ?? resolveAgent(config, task.agent);
    if (!resolved) {
      deps.brain.failTask(task.taskId, `Agent ${task.agent} is no longer configured`);
      deps.broadcastBrainSnapshot();
      return { ok: false, error: `Agent ${task.agent} is no longer configured` };
    }

    try {
      const session = deps.mgr.create({
        command: resolved.command,
        args: resolved.args,
        cols: 100,
        rows: 30,
        label: task.agent,
        ...(brainAgent ? { env: brainAgent.env, durable: false } : {}),
        onCreated: (createdSession) => {
          if (brainAgent) deps.brainResultPaths.set(createdSession.id, resultPath);
          deps.brain.bindSession(task.taskId, createdSession.id);
          deps.broadcastBrainSnapshot();
        },
      });
      if (!brainAgent) {
        // Use bracketed paste for interactive custom agents so multi-line prompts never
        // trigger accidental partial submissions in the TUI.
        setTimeout(() => {
          if (deps.mgr.sessions.has(session.id)) deps.mgr.write(session, pasteAndSubmit(dispatchPrompt));
        }, deps.prefillDelayMs);
      }
    } catch (error) {
      rmSync(resultPath, { force: true });
      deps.brain.failTask(task.taskId, (error as Error).message);
      deps.broadcastBrainSnapshot();
      return { ok: false, error: (error as Error).message };
    }
    return workerDispatchResult(deps.brain.findTaskByRequestId(input.requestId) || task);
  }

  return { continueVoiceAgent, cancelExecutionById, dispatchWorkerAgent };
}

function workerDispatchResult(task: BrainTask): Record<string, unknown> {
  return {
    ok: task.status !== 'failed',
    requestId: task.requestId,
    taskId: task.taskId,
    runId: task.taskId,
    agent: task.agent,
    status: task.status,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

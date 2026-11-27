import type { BrainToolCall } from '@termbridge/brain';
import { stringifyJsonSafe } from './jsonSafe.js';
import {
  CANCEL_EXECUTION_TOOL,
  COMPLETION_REVIEWS_TOOL,
  CONTINUE_AGENT_TOOL,
  DISPATCH_AGENT_TOOL,
  TOOL_SCRIPT_TOOL,
} from './brainTools/agentAndWorkflowTools.js';
import { HOME_ASSISTANT_TOOL, PHONE_ACTION_TOOL } from './brainTools/deviceTools.js';
import {
  BRAIN_MEMORY_TOOL,
  INSPECT_IMAGES_TOOL,
  SEARCH_WEB_TOOL,
  WORKSPACE_FILES_TOOL,
} from './brainTools/filesAndMemoryTools.js';
import { INSPECT_WORKSPACE_TOOL } from './brainTools/workspaceTool.js';
import {
  objectValue,
  type ControlToolEnvironment,
  type ControlToolProgress,
  type ControlToolRegistration,
  type VoiceToolResult,
  type VoiceToolView,
  type VoiceToolViewItem,
} from './brainTools/types.js';

export type {
  ControlToolEnvironment,
  ControlToolProgress,
  ControlToolRegistration,
  VoiceToolView,
  VoiceToolViewItem,
};

export const GLOBAL_BRAIN_TOOL_REGISTRATIONS: ControlToolRegistration[] = [
  COMPLETION_REVIEWS_TOOL,
  TOOL_SCRIPT_TOOL,
  INSPECT_IMAGES_TOOL,
  INSPECT_WORKSPACE_TOOL,
  SEARCH_WEB_TOOL,
  WORKSPACE_FILES_TOOL,
  BRAIN_MEMORY_TOOL,
  PHONE_ACTION_TOOL,
  HOME_ASSISTANT_TOOL,
  CANCEL_EXECUTION_TOOL,
  CONTINUE_AGENT_TOOL,
  DISPATCH_AGENT_TOOL,
];

export const GLOBAL_BRAIN_TOOLS = GLOBAL_BRAIN_TOOL_REGISTRATIONS.map(({ definition }) => definition);
export const GLOBAL_BRAIN_TOOL_CATALOG = GLOBAL_BRAIN_TOOL_REGISTRATIONS.map(({ descriptor }) => descriptor);

const GLOBAL_TOOL_BY_NAME = new Map(
  GLOBAL_BRAIN_TOOL_REGISTRATIONS.map((registration) => [registration.definition.name, registration] as const),
);

export function createGlobalBrainToolHandler(environment: ControlToolEnvironment) {
  return async (call: BrainToolCall): Promise<string> => {
    const registration = GLOBAL_TOOL_BY_NAME.get(call.name);
    if (!registration) return stringifyJsonSafe({
      ok: false,
      error: `Unknown tool ${call.name}`,
      failureKind: 'unsupported',
      retryable: false,
    });
    try {
      return stringifyJsonSafe(withFailureSemantics(await registration.execute(environment, call)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Control tool failed';
      const failure = classifyToolFailure(message);
      return stringifyJsonSafe({
        ok: false,
        error: message,
        ...failure,
      });
    }
  };
}

function withFailureSemantics(result: VoiceToolResult): VoiceToolResult {
  if (result.ok !== false || typeof result.retryable === 'boolean') return result;
  const message = typeof result.error === 'string' ? result.error : 'Control tool failed';
  return { ...result, ...classifyToolFailure(message) };
}

function classifyToolFailure(message: string): { failureKind: string; retryable: boolean } {
  const normalized = message.toLowerCase();
  if (/denied|cancelled|canceled|permission|not authorized|拒绝|取消|未授权/.test(normalized)) {
    return { failureKind: 'authorization', retryable: false };
  }
  if (/required|invalid|must be|unknown tool|not configured|not available|不存在|未配置|不可用/.test(normalized)) {
    return { failureKind: 'invalid_request', retryable: false };
  }
  if (/timeout|timed out|network|busy|reconnect|temporar|超时|网络|繁忙|重连/.test(normalized)) {
    return { failureKind: 'transient', retryable: true };
  }
  return { failureKind: 'tool_error', retryable: true };
}

export function startVoiceToolProgress(call: BrainToolCall): ControlToolProgress {
  const registration = GLOBAL_TOOL_BY_NAME.get(call.name);
  return { phase: 'started', summary: registration?.progress.started(call) || '正在调用 TermBridge 工具…' };
}

export function finishVoiceToolProgress(call: BrainToolCall, output: string): ControlToolProgress {
  const result = parseToolResult(output);
  const registration = GLOBAL_TOOL_BY_NAME.get(call.name);
  if (result.ok === false) {
    return { phase: 'failed', summary: registration?.progress.failed || 'TermBridge 工具调用失败' };
  }
  return {
    phase: 'completed',
    summary: registration?.progress.completed(call, result) || 'TermBridge 工具调用完成',
  };
}

/** Converts known tool payloads to a small, fixed UI vocabulary. Never forwards arbitrary model UI. */
export function createGlobalBrainToolView(call: BrainToolCall, output: string): VoiceToolView | undefined {
  const result = parseToolResult(output);
  if (result.ok === false) return undefined;
  return GLOBAL_TOOL_BY_NAME.get(call.name)?.ui?.(call, result);
}

/** Compatibility names for callers that predate shared text/voice Global tools. */
export const VOICE_BRAIN_TOOL_REGISTRATIONS = GLOBAL_BRAIN_TOOL_REGISTRATIONS;
export const VOICE_BRAIN_TOOLS = GLOBAL_BRAIN_TOOLS;
export const createVoiceToolHandler = createGlobalBrainToolHandler;
export const createVoiceToolView = createGlobalBrainToolView;
export type VoiceToolEnvironment = ControlToolEnvironment;
export type VoiceToolProgress = ControlToolProgress;
export type VoiceToolRegistration = ControlToolRegistration;

function parseToolResult(output: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(output)) || { ok: false };
  } catch {
    return { ok: false };
  }
}

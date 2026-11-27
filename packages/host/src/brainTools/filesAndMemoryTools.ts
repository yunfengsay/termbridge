import type { BrainToolCall } from '@termbridge/brain';
import type { WorkspaceFileAction } from '../workspaceFiles.js';
import {
  cleanToolText,
  inlineArgument,
  numberArgument,
  objectArray,
  registerControlTool,
  resultCount,
  stringArgument,
  type ControlToolRegistration,
  type VoiceToolResult,
} from './types.js';

const FILE_ACTIONS: WorkspaceFileAction[] = ['list', 'read', 'search', 'git_status', 'git_diff'];

export const INSPECT_IMAGES_TOOL: ControlToolRegistration = registerControlTool({
  name: 'inspect_images',
  readOnly: true,
  description: 'Look at the actual pixels of images explicitly attached to the current conversation. Use when the user asks what this picture/screenshot shows, to read visible text or explain code in an attached screenshot. This does not capture a new screen, browse the gallery or edit images. Delegate edits to a worker Agent.',
  parameters: {
    type: 'object', properties: {
      question: { type: 'string', description: 'The user question about the image, in their language.' },
      assetIds: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Optional IDs from the current attachment only. Omit to inspect the attached images (up to three).' },
    }, required: ['question'], additionalProperties: false,
  },
}, { label: 'Attached images', category: 'context', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    const ids = call.arguments.assetIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) {
      throw new Error('assetIds must be a list of attached image IDs');
    }
    try {
      return await environment.inspectImages(stringArgument(call, 'question'), ids as string[] | undefined);
    } catch (error) {
      return { ok: false, status: 'failed', retryable: false, failureKind: 'tool_error',
        error: error instanceof Error ? error.message : 'Image inspection failed' };
    }
  },
  progress: { started: () => '正在查看附加图片', completed: () => '图片识别完成', failed: '图片识别失败' },
  ui: (_call, result) => ({ kind: 'receipt', title: '图片识别', items: [{
    id: String(result.actionId || 'attached-images'), title: '已查看所选图片',
    detail: cleanToolText(String(result.text || ''), 2_000), status: 'completed',
  }] }),
});

export const SEARCH_WEB_TOOL: ControlToolRegistration = registerControlTool({
  name: 'search_web',
  readOnly: true,
  description: 'Search the current public web through the Host-configured Bailian Responses API. Use for recent external facts, documentation, releases, prices, news, or sources that are not in the local workspace.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A focused standalone web-search query. Include the relevant product, version, date, or technical term.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
}, { label: 'Web search', category: 'web', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    return environment.searchWeb(stringArgument(call, 'query'));
  },
  progress: {
    started: () => '正在搜索网页…',
    completed: (_call, result) => {
      const count = objectArray(result.sources).length;
      return count > 0 ? `搜索完成，找到 ${count} 个来源` : '网页搜索完成';
    },
    failed: '网页搜索失败',
  },
});

export const WORKSPACE_FILES_TOOL: ControlToolRegistration = registerControlTool({
  name: 'workspace_files',
  readOnly: true,
  description: 'Read project files through one safe read-only Host interface. Use list to discover paths, read for text files (optional startLine/endLine for large files, or path @memory for TermBridge Memory), search to find text matches across a project directory, and git_status/git_diff to inspect working-tree changes.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: FILE_ACTIONS, description: 'Read-only file or git inspection operation.' },
      path: {
        type: 'string',
        description: 'Path relative to the configured projects root (e.g. "termbridge-oss" or "termbridge-oss/package.json"), or @memory for TermBridge Memory.',
      },
      startLine: { type: 'integer', minimum: 1, description: 'Optional 1-based starting line for action=read.' },
      endLine: { type: 'integer', minimum: 1, description: 'Optional 1-based inclusive ending line for action=read.' },
      query: { type: 'string', description: 'Required search substring for action=search.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 30, description: 'Optional match limit for action=search (default 20).' },
    },
    required: ['action', 'path'],
    additionalProperties: false,
  },
}, { label: 'Project files', category: 'files', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    const action = workspaceFileActionArgument(call);
    const path = stringArgument(call, 'path');
    const startLine = numberArgument(call, 'startLine');
    const endLine = numberArgument(call, 'endLine');
    const query = stringArgument(call, 'query', false) || undefined;
    const maxResults = numberArgument(call, 'maxResults');
    const hasOptions = startLine !== undefined || endLine !== undefined || query !== undefined || maxResults !== undefined;
    return hasOptions
      ? environment.workspaceFiles(action, path, { startLine, endLine, query, maxResults })
      : environment.workspaceFiles(action, path);
  },
  progress: {
    started: (call) => {
      const action = workspaceFileActionArgument(call, false);
      if (action === 'list') return '正在查看项目文件…';
      if (action === 'search') return '正在搜索项目代码…';
      if (action === 'git_status' || action === 'git_diff') return '正在检查仓库改动…';
      return '正在读取项目文件…';
    },
    completed: (call, result) => {
      const action = workspaceFileActionResult(result) || workspaceFileActionArgument(call, false);
      if (action === 'list') return `已找到 ${objectArray(result.entries).length} 个文件项`;
      if (action === 'search') return `代码搜索找到 ${resultCount(result)} 处匹配`;
      if (action === 'git_status') return '已读取 Git 状态';
      if (action === 'git_diff') return '已读取 Git 差异';
      const path = inlineArgument(result.path) || inlineArgument(call.arguments.path);
      return path ? `已读取 ${path}` : '已读取项目文件';
    },
    failed: '读取项目文件失败',
  },
});

export const BRAIN_MEMORY_TOOL: ControlToolRegistration = registerControlTool({
  name: 'brain_memory',
  readOnly: false,
  description: 'Read, search, save/update, or remove durable user preferences and project decisions in TermBridge persistent memory (~/.termbridge/memory.md). Only save durable cross-session facts explicitly provided or confirmed by the user. Never save secrets, tokens, API keys, or transient Agent status.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'search', 'upsert', 'remove'], description: 'Memory operation.' },
      section: { type: 'string', description: 'Section heading (e.g. Preferences, Projects, Workflow) for upsert or optional filter for remove.' },
      key: { type: 'string', description: 'Optional stable key within section for upsert so repeated updates overwrite cleanly.' },
      content: { type: 'string', description: 'Required durable fact or preference for action=upsert.' },
      query: { type: 'string', description: 'Required keyword(s) for action=search or action=remove.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}, { label: 'Persistent memory', category: 'context', execution: 'direct', approval: 'none' }, {
  async execute(environment, call) {
    if (!environment.brainMemory) return { ok: false, error: 'Persistent memory tool is unavailable on this Host', retryable: false };
    return environment.brainMemory(call.arguments);
  },
  progress: {
    started: (call) => {
      const action = stringArgument(call, 'action', false);
      if (action === 'upsert') return '正在保存长期记忆…';
      if (action === 'remove') return '正在清理长期记忆…';
      return '正在检索长期记忆…';
    },
    completed: (call, result) => {
      const action = stringArgument(call, 'action', false);
      if (action === 'upsert') return result.updated ? '已更新长期记忆' : '已写入长期记忆';
      if (action === 'remove') return `已移除 ${Number(result.removedCount ?? 0)} 条记忆`;
      if (action === 'search') return `记忆检索命中 ${Number(result.total ?? 0)} 条`;
      return '已读取长期记忆';
    },
    failed: '长期记忆操作失败',
  },
});

function workspaceFileActionArgument(call: BrainToolCall): WorkspaceFileAction;
function workspaceFileActionArgument(call: BrainToolCall, required: false): WorkspaceFileAction | undefined;
function workspaceFileActionArgument(call: BrainToolCall, required = true): WorkspaceFileAction | undefined {
  const value = stringArgument(call, 'action', required);
  if (FILE_ACTIONS.includes(value as WorkspaceFileAction)) return value as WorkspaceFileAction;
  if (required) throw new Error('action must be list, read, search, git_status, or git_diff');
  return undefined;
}

function workspaceFileActionResult(result: VoiceToolResult): WorkspaceFileAction | undefined {
  return FILE_ACTIONS.includes(result.action as WorkspaceFileAction) ? result.action as WorkspaceFileAction : undefined;
}

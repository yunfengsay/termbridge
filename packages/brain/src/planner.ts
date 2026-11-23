import type { BrainSnapshot } from './index.js';
import { DEFAULT_GLOBAL_EXECUTION_MODEL } from './models.js';

export interface BrainPlanInput {
  text: string;
  requestedAgent?: string;
  availableAgents: string[];
  snapshot: BrainSnapshot;
  agentContexts?: BrainAgentContext[];
  /** Host-validated Terminal navigation origin; never persisted as user text. */
  sourceSession?: BrainAgentContext;
  recentUserMessages?: BrainRecentUserMessage[];
}

export interface BrainAgentContext {
  sessionId: string;
  source: 'herdr' | 'pty';
  name?: string;
  workspace?: string;
  paneId?: string;
  agent?: string;
  command: string;
  status: string;
  preview?: string;
  context?: string;
  lastSeenAt: number;
}

export interface BrainRecentUserMessage {
  sessionId: string;
  source: 'herdr' | 'pty';
  name?: string;
  workspace?: string;
  paneId?: string;
  agent?: string;
  command: string;
  text: string;
  clientPlatform?: string;
  sentAt: number;
}

export interface BrainPlan {
  agent: string;
  instruction: string;
  reply: string;
  provider: 'local' | 'bailian';
  model?: string;
  /** Existing Herdr session to receive the instruction; absent means start a fresh one-shot run. */
  targetSessionId?: string;
  /** The planner answered from authoritative control-plane context; no coding Agent run is needed. */
  answerOnly?: boolean;
}

export interface BrainPlanningService {
  plan(input: BrainPlanInput): Promise<BrainPlan>;
}

export class LocalBrainPlanningService implements BrainPlanningService {
  async plan(input: BrainPlanInput): Promise<BrainPlan> {
    const agents = cleanAgents(input.availableAgents);
    const target = explicitlyNamedTarget(input.text, input.agentContexts || []);
    const sourceTarget = input.sourceSession?.source === 'herdr' ? input.sourceSession : undefined;
    const resolvedTarget = target ?? sourceTarget;
    const agent = chooseAgent(input.requestedAgent || agentTypeForTarget(resolvedTarget), agents);
    if (!agent) throw new Error('No coding agent is configured on this host');
    const authoritativeDirectMessageReply = directMessageReply(input);
    return {
      agent,
      instruction: preserveText(input.text),
      reply: authoritativeDirectMessageReply || (usesChinese(input.text)
        ? `我会交给 ${resolvedTarget ? preferredAgentName(resolvedTarget) : agent} 处理。`
        : `I will route this to ${resolvedTarget ? preferredAgentName(resolvedTarget) : agent}.`),
      provider: 'local',
      targetSessionId: resolvedTarget?.sessionId,
      answerOnly: Boolean(authoritativeDirectMessageReply),
    };
  }
}

interface BailianPlannerOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  request?: typeof fetch;
}

interface BailianCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

interface BailianPlanPayload {
  agent?: unknown;
  targetSessionId?: unknown;
  instruction?: unknown;
  reply?: unknown;
}

export class BailianBrainPlanningService implements BrainPlanningService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(options: BailianPlannerOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error('DASHSCOPE_API_KEY is empty');
    this.baseUrl = (options.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
    this.model = options.model?.trim() || DEFAULT_GLOBAL_EXECUTION_MODEL;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.request = options.request ?? fetch;
  }

  async plan(input: BrainPlanInput): Promise<BrainPlan> {
    const agents = cleanAgents(input.availableAgents);
    if (agents.length === 0) throw new Error('No coding agent is configured on this host');
    if (input.requestedAgent && !agents.includes(input.requestedAgent)) {
      throw new Error(`Requested agent ${input.requestedAgent} is not configured`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt(agents, input.requestedAgent) },
            { role: 'user', content: planningContext(input) },
          ],
          response_format: { type: 'json_object' },
          enable_thinking: false,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? 'request timed out' : (error as Error).message;
      throw new Error(`Bailian planning failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Bailian planning failed with HTTP ${response.status}: ${safeApiError(responseText)}`);
    }
    const completion = parseJson<BailianCompletion>(responseText, 'Bailian returned invalid JSON');
    const content = completion.choices?.[0]?.message?.content;
    if (!content) throw new Error('Bailian returned no planning content');
    const payload = parseJson<BailianPlanPayload>(stripCodeFence(content), 'Bailian returned an invalid plan');
    const agent = typeof payload.agent === 'string' ? payload.agent.trim() : '';
    const targetSessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId.trim() : '';
    const instruction = typeof payload.instruction === 'string' ? preserveText(payload.instruction) : '';
    const reply = typeof payload.reply === 'string' ? compactText(payload.reply) : '';
    if (!agents.includes(agent)) throw new Error(`Bailian selected unavailable agent ${agent || '(empty)'}`);
    if (input.requestedAgent && agent !== input.requestedAgent) {
      throw new Error(`Bailian did not honor the requested agent ${input.requestedAgent}`);
    }
    const validTargets = new Set(
      (input.agentContexts || [])
        .filter((context) => context.source === 'herdr')
        .map((context) => context.sessionId),
    );
    if (targetSessionId && !validTargets.has(targetSessionId)) {
      throw new Error(`Bailian selected unavailable target session ${targetSessionId}`);
    }
    if (!instruction) throw new Error('Bailian returned an empty dispatch instruction');
    if (!reply) throw new Error('Bailian returned an empty user reply');
    const authoritativeDirectMessageReply = directMessageReply(input);
    const userReply = authoritativeDirectMessageReply || userFacingReply(reply, input.agentContexts || []);
    return {
      agent,
      instruction,
      reply: userReply,
      provider: 'bailian',
      model: this.model,
      targetSessionId: authoritativeDirectMessageReply ? undefined : targetSessionId || undefined,
      answerOnly: Boolean(authoritativeDirectMessageReply),
    };
  }
}

export function createBrainPlanningService(env: NodeJS.ProcessEnv = process.env): BrainPlanningService {
  const provider = (env.TB_BRAIN_PROVIDER || 'bailian').toLowerCase();
  if (!['auto', 'local', 'bailian'].includes(provider)) {
    throw new Error(`Unknown TB_BRAIN_PROVIDER ${provider}`);
  }
  if (provider === 'local') {
    throw new Error('Global Brain does not support a local provider');
  }
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('Global Brain requires DASHSCOPE_API_KEY');
  return new BailianBrainPlanningService({
    apiKey,
    baseUrl: env.DASHSCOPE_BASE_URL,
    model: env.TB_BRAIN_MODEL,
  });
}

function systemPrompt(agents: string[], requestedAgent?: string): string {
  const routeRule = requestedAgent
    ? `The user explicitly selected ${requestedAgent}; agent must be exactly ${requestedAgent}.`
    : 'Choose the best agent for the task.';
  return [
    'You are Termbridge Brain, a routing and delegation layer for coding agents.',
    `Available agents: ${agents.join(', ')}. ${routeRule}`,
    'Return one JSON object with exactly these string fields: agent, targetSessionId, instruction, reply.',
    'agent must exactly match one available agent.',
    'targetSessionId must exactly match one current Herdr Agent ID when an existing Agent already owns the relevant project/task; otherwise return an empty string to start a fresh one-shot run.',
    'name is the user-facing Agent identity. In reply, use name and never expose targetSessionId when a name is available. If names repeat, distinguish the target with a brief task summary from preview/context.',
    'When targetSessionId is non-empty, instruction is addressed directly to that Agent: remove routing phrases such as "send to Agent X" so it never tries to dispatch to itself.',
    'Never target a shell/unknown pane. Avoid interrupting an unrelated working Agent. A question about the roster can use an empty targetSessionId and be answered by the fresh Brain run.',
    'instruction is the complete actionable prompt sent to that coding agent. Preserve paths, identifiers, constraints, and opaque verification tokens exactly.',
    'reply is a concise acknowledgement to the user. State the chosen agent and plan, but never claim the work is complete.',
    'reply must use the same primary language as currentRequest. If currentRequest contains Chinese, reply in Simplified Chinese.',
    'When the user asks which Agent they directly messaged, recentUserMessages (newest first) is the sole authority. Never infer that target from recentTasks, recentMessages, terminal context, status, or lastSeenAt; if the list is empty, say the target is unknown.',
    'sourceSession is Host-validated hidden navigation context from the Terminal where the user opened Global Brain. Resolve words such as this, here, continue, it, and unspecified project work against sourceSession first. Prefer its exact targetSessionId when it is a current Herdr Agent and the request does not explicitly choose another target. Do not mention this hidden routing metadata unless it materially clarifies the answer.',
    'Use recent context only when it materially clarifies the current request. Do not invent project state.',
  ].join('\n');
}

function planningContext(input: BrainPlanInput): string {
  const recentMessages = input.snapshot.messages.slice(-12).map(({ role, text }) => ({ role, text }));
  const recentTasks = input.snapshot.tasks.slice(-8).map(({ agent, status, text }) => ({ agent, status, text }));
  const contexts = input.agentContexts || [];
  const recentUserMessages = (input.recentUserMessages || []).slice(0, 12).map((event) => ({
    sessionId: event.sessionId,
    source: event.source,
    name: event.name,
    workspace: event.workspace,
    paneId: event.paneId,
    agent: event.agent,
    command: event.command,
    text: event.text.slice(0, 1_000),
    clientPlatform: event.clientPlatform,
    sentAt: event.sentAt,
  }));
  const roster = contexts.map(({ context: _context, ...record }) => record);
  const sourceSession = input.sourceSession ? withoutExecutionContext(input.sourceSession) : undefined;
  const fixed = { currentRequest: input.text, sourceSession, recentUserMessages, recentMessages, recentTasks, agentRoster: roster };
  const fixedJson = JSON.stringify(fixed);
  const availableForContexts = Math.max(0, MAX_PLANNING_CONTEXT_CHARS - fixedJson.length - 64);
  const perAgentBudget = contexts.length ? Math.floor(availableForContexts / contexts.length) : 0;
  const agentContexts = contexts.map((record) => ({
    sessionId: record.sessionId,
    context: clipTail(record.context || '', perAgentBudget),
  }));
  return JSON.stringify({ ...fixed, agentContexts }).slice(0, MAX_PLANNING_CONTEXT_CHARS);
}

function withoutExecutionContext({ context: _context, ...record }: BrainAgentContext): Omit<BrainAgentContext, 'context'> {
  return record;
}

const MAX_PLANNING_CONTEXT_CHARS = 180_000;

function clipTail(value: string, limit: number): string {
  if (limit <= 0) return '';
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function explicitlyNamedTarget(text: string, contexts: BrainAgentContext[]): BrainAgentContext | undefined {
  const herdrContexts = contexts.filter((context) => context.source === 'herdr');
  return herdrContexts.find((context) => text.includes(context.sessionId))
    ?? herdrContexts.find((context) => context.name && text.toLocaleLowerCase().includes(context.name.toLocaleLowerCase()));
}

function agentTypeForTarget(target: BrainAgentContext | undefined): string | undefined {
  const value = `${target?.agent || ''} ${target?.command || ''}`.toLowerCase();
  if (value.includes('claude')) return 'claude';
  return target ? 'codex' : undefined;
}

function chooseAgent(requestedAgent: string | undefined, agents: string[]): string | undefined {
  if (requestedAgent && agents.includes(requestedAgent)) return requestedAgent;
  return ['codex', 'claude'].find((agent) => agents.includes(agent)) ?? agents[0];
}

function cleanAgents(agents: string[]): string[] {
  return [...new Set(agents.map((agent) => agent.trim()).filter((agent) => agent && agent !== 'shell'))];
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function preserveText(text: string): string {
  return text.trim();
}

function usesChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

function directMessageReply(input: BrainPlanInput): string | undefined {
  if (!asksForRecentDirectMessage(input.text)) return undefined;
  const latest = [...(input.recentUserMessages || [])].sort((left, right) => right.sentAt - left.sentAt)[0];
  if (!latest) {
    return usesChinese(input.text)
      ? 'TB 还没有记录到最近一次直接发送给 Agent 的消息。'
      : 'TB has not recorded a recent direct message to an Agent.';
  }
  const current = input.agentContexts?.find((context) => context.sessionId === latest.sessionId);
  const identity = latest.name || latest.workspace || latest.agent || latest.command;
  const workspace = latest.workspace || current?.workspace || '-';
  const status = current?.status || 'unknown';
  return usesChinese(input.text)
    ? `你最近一次直接发送消息的是 ${identity}，项目=${workspace}，当前状态=${status}。消息内容：“${compactText(latest.text).slice(0, 300)}”`
    : `Your most recent direct Agent message went to ${identity}, project=${workspace}, current status=${status}. Message: “${compactText(latest.text).slice(0, 300)}”`;
}

function preferredAgentName(context: BrainAgentContext): string {
  return context.name || context.workspace || context.agent || context.command || context.sessionId;
}

function userFacingReply(reply: string, contexts: BrainAgentContext[]): string {
  return contexts.reduce((text, context) => {
    const name = preferredAgentName(context);
    return name === context.sessionId ? text : text.split(context.sessionId).join(name);
  }, reply);
}

function asksForRecentDirectMessage(text: string): boolean {
  const normalized = compactText(text);
  return /(?:which|what|who).{0,24}agent.{0,32}(?:message|sent)|(?:message|sent).{0,32}(?:which|what|who).{0,16}agent/i.test(normalized)
    || /(?:刚才|刚刚|最近|上次).{0,32}(?:发送|发).{0,12}(?:消息|信息)/u.test(normalized)
    || /(?:给|向).{0,20}(?:哪个|哪一个).{0,12}(?:Agent|智能体|代理).{0,20}(?:发送|发|消息)/iu.test(normalized);
}

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseJson<T>(text: string, errorMessage: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function safeApiError(text: string): string {
  const compact = compactText(text).slice(0, 300);
  return compact || 'empty response';
}

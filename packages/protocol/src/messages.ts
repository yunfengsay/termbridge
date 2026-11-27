import { z } from 'zod';
import { AutomationSchema } from './automation.js';
import { ProxyTunnelPolicySchema, ProxyTunnelSchema } from './proxyTunnel.js';
import { VoiceLearningRequestSchema, VoiceLearningResultSchema } from './voiceLearning.js';
import { RelayTopologySchema } from './topology.js';

export const PeerCallSchema = z.object({
  t: z.literal('peer_call'), id: z.string().min(1).max(128),
  op: z.enum(['peer.list', 'peer.topology', 'info', 'exec', 'fs.read', 'fs.write', 'fs.ls', 'fs.stat', 'termbridge.lan']),
  args: z.record(z.unknown()).optional(), timeoutMs: z.number().int().min(100).max(60000).optional(),
});

/**
 * The control keys the chat view may send to its own pane.
 *
 * A closed set on purpose: the client names a key and the Host decides the
 * bytes, so nothing a client sends can become an arbitrary escape sequence.
 * These are the keys the Terminal's own row already offers, minus the ones that
 * only make sense with a local selection.
 */
export const AGENT_CHAT_KEYS = [
  'escape', 'tab', 'enter', 'backspace',
  'up', 'down', 'left', 'right', 'home', 'end',
  // Ctrl and Alt with a letter, so the familiar modifier buttons keep their
  // meaning rather than being replaced by a handful of fixed combinations.
  'ctrl-a', 'ctrl-b', 'ctrl-c', 'ctrl-d', 'ctrl-e', 'ctrl-f', 'ctrl-g', 'ctrl-h', 'ctrl-i', 'ctrl-j', 'ctrl-k', 'ctrl-l', 'ctrl-m', 'ctrl-n', 'ctrl-o', 'ctrl-p', 'ctrl-q', 'ctrl-r', 'ctrl-s', 'ctrl-t', 'ctrl-u', 'ctrl-v', 'ctrl-w', 'ctrl-x', 'ctrl-y', 'ctrl-z',
  'alt-a', 'alt-b', 'alt-c', 'alt-d', 'alt-e', 'alt-f', 'alt-g', 'alt-h', 'alt-i', 'alt-j', 'alt-k', 'alt-l', 'alt-m', 'alt-n', 'alt-o', 'alt-p', 'alt-q', 'alt-r', 'alt-s', 'alt-t', 'alt-u', 'alt-v', 'alt-w', 'alt-x', 'alt-y', 'alt-z',
  'alt-enter', 'alt-backspace',
] as const;

export type AgentChatKey = (typeof AGENT_CHAT_KEYS)[number];

const SystemRemindersSchema = z.array(z.object({
  id: z.string().max(128), requestId: z.string().max(128),
  text: z.string().max(4000), createdAt: z.number().int().nonnegative(),
})).max(100).optional();

const SafeRelativePathSchema = z.string().min(1).max(1_024).refine((path) => (
  !path.startsWith('/')
  && !path.includes('\\')
  && !/^[a-zA-Z]:/.test(path)
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
), 'Expected a safe relative path');

const BrainMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'brain']),
  text: z.string(),
  createdAt: z.number(),
  taskId: z.string().optional(),
  modality: z.enum(['text', 'voice']).optional(),
  voiceStatus: z.enum(['streaming', 'completed', 'interrupted']).optional(),
});

const BrainTaskSchema = z.object({
  taskId: z.string(),
  requestId: z.string(),
  text: z.string(),
  agent: z.string(),
  status: z.enum(['queued', 'dispatched', 'completed', 'failed', 'cancelled']),
  createdAt: z.number(),
  updatedAt: z.number(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
});

const AgentDescriptorSchema = z.object({
  agentId: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  runtime: z.enum(['codex', 'claude', 'shell', 'custom']),
  purpose: z.string().min(1).max(500),
  capabilities: z.array(z.enum([
    'coding', 'research', 'design', 'writing', 'data', 'browser', 'terminal', 'files',
  ])).max(8),
  defaultWorkspace: SafeRelativePathSchema.optional(),
});

const BrainRouteDecisionSchema = z.object({
  id: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  action: z.enum(['answer', 'continue_agent', 'dispatch_agent']),
  outcome: z.enum(['accepted', 'rejected']),
  createdAt: z.number().int().nonnegative(),
  targetAgentId: z.string().min(1).max(128).optional(),
  targetSessionId: z.string().min(1).max(256).optional(),
  reason: z.string().min(1).max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const BrainRunEventSchema = z.object({
  eventId: z.string().min(1).max(160),
  runId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  type: z.enum(['queued', 'dispatched', 'completed', 'failed', 'cancelled']),
  createdAt: z.number().int().nonnegative(),
  agentId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
  summary: z.string().min(1).max(1_000).optional(),
});

const BrainToolDescriptorSchema = z.object({
  name: z.string().min(1).max(128),
  label: z.string().min(1).max(160),
  description: z.string().min(1).max(1_000),
  category: z.enum(['context', 'web', 'files', 'device', 'agent']),
  execution: z.enum(['direct', 'worker']),
  approval: z.enum(['none', 'device']),
});

const ExecutionForkEventSchema = z.object({
  workflow: z.enum(['standard', 'silent']).optional(),
  eventId: z.string().min(1).max(160),
  forkId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  phase: z.enum([
    'fork_started', 'model_started', 'model_completed',
    'tool_started', 'tool_completed', 'tool_failed',
    'fork_completed', 'fork_failed', 'fork_cancelled',
  ]),
  createdAt: z.number().int().nonnegative(),
  model: z.string().min(1).max(128).optional(),
  turn: z.number().int().nonnegative().optional(),
  callId: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(128).optional(),
  summary: z.string().min(1).max(512).optional(),
});

const BrainDeliverableSchema = z.object({
  id: z.string().min(1).max(160),
  runId: z.string().min(1).max(128),
  kind: z.enum(['preview', 'report', 'canvas', 'diff', 'file', 'link']),
  title: z.string().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(256).optional(),
  url: z.string().url().startsWith('https://').max(2_048).optional(),
  path: SafeRelativePathSchema.optional(),
}).refine((deliverable) => Boolean(deliverable.url || deliverable.path), {
  message: 'A Deliverable needs an HTTPS URL or safe relative path',
});

const VoiceUsageSummarySchema = z.object({
  source: z.literal('local_estimate'),
  responseCount: z.number().int().nonnegative(),
  estimatedCostCny: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inputAudioSeconds: z.number().nonnegative(),
  outputAudioSeconds: z.number().nonnegative(),
  updatedAt: z.string().optional(),
});

const BrainImageAssetSchema = z.object({
  assetId: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  mime: z.string().startsWith('image/').max(128),
  size: z.number().int().positive().max(40 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const BrainImageAttachmentSchema = z.object({
  actionId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  assets: z.array(BrainImageAssetSchema).min(1).max(20),
});

export type BrainImageAttachment = z.infer<typeof BrainImageAttachmentSchema>;

const VoiceToolViewItemSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(256).optional(),
  detail: z.string().max(600).optional(),
  status: z.string().max(64).optional(),
  timestamp: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).max(128).optional(),
  source: z.enum(['pty', 'herdr']).optional(),
});

const VoiceToolViewSchema = z.object({
  kind: z.enum(['agent_list', 'completion_list', 'task_list', 'agent', 'receipt']),
  title: z.string().min(1).max(160),
  items: z.array(VoiceToolViewItemSchema).max(8),
});

const BrainToolResultSchema = z.object({
  id: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  callId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  createdAt: z.number().int().nonnegative(),
  view: VoiceToolViewSchema,
});

const BrainConversationSummarySchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(160),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
});

const BrainConversationHistorySchema = BrainConversationSummarySchema.extend({
  systemReminders: SystemRemindersSchema,
  messages: z.array(BrainMessageSchema).max(200),
  tasks: z.array(BrainTaskSchema).max(100),
  toolResults: z.array(BrainToolResultSchema).max(100).optional(),
  routeDecisions: z.array(BrainRouteDecisionSchema).max(100).optional(),
  runEvents: z.array(BrainRunEventSchema).max(300).optional(),
  deliverables: z.array(BrainDeliverableSchema).max(100).optional(),
  executionEvents: z.array(ExecutionForkEventSchema).max(300).optional(),
});

const ReviewLineSchema = z.object({
  kind: z.enum(['context', 'add', 'delete']),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  text: z.string().max(1_000),
});

const ReviewHunkSchema = z.object({
  header: z.string().max(500),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(ReviewLineSchema).max(20_000),
});

const ReviewFileSchema = z.object({
  path: z.string().min(1).max(1_024),
  oldPath: z.string().min(1).max(1_024).optional(),
  status: z.enum(['added', 'deleted', 'modified', 'renamed', 'untracked', 'unchanged']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  truncated: z.boolean(),
  /** An environment file, key or credential: listed with its counts, contents withheld by the Host. */
  private: z.boolean().optional(),
  hunks: z.array(ReviewHunkSchema).max(800),
});

/** A changed file without its patch, for listing a repository's changes. */
const ReviewFileSummarySchema = ReviewFileSchema.omit({ hunks: true });

/**
 * One repository a conversation is associated with: the session's own working
 * directory, or one holding a file its Agent changed according to the Agent's
 * own transcript. `touched` lists those files (repository-relative), changed
 * now or not; `files` is the repository's current uncommitted change set.
 */
const ReviewRepositorySchema = z.object({
  repository: z.string().min(1).max(256),
  repositoryPath: z.string().min(1).max(2_048),
  branch: z.string().min(1).max(256),
  detached: z.boolean(),
  current: z.boolean(),
  files: z.array(ReviewFileSummarySchema).max(200),
  changedFileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
  touched: z.array(z.string().min(1).max(1_024)).max(500),
  touchedTruncated: z.boolean().optional(),
  error: z.string().max(1_000).optional(),
});

const ReviewSnapshotSchema = z.object({
  repository: z.string().min(1).max(256),
  repositoryPath: z.string().min(1).max(2_048),
  branch: z.string().min(1).max(256),
  detached: z.boolean(),
  mode: z.enum(['working', 'branch', 'files']),
  baseBranch: z.string().min(1).max(256).optional(),
  dirty: z.boolean(),
  canSwitchBranch: z.boolean(),
  branches: z.array(z.string().min(1).max(256)).max(100),
  files: z.array(ReviewFileSchema).max(20_000),
  changedFileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/**
 * Local encrypted BLE companion contract. These payloads do not travel in a
 * relay CONTROL frame, but live here so every native client and the firmware
 * share one reviewed definition of the message IDs and scaled fields.
 */
export const WatchCompanionMessageType = {
  activitySnapshot: 0x30,
  navigationCue: 0x31,
  dailySnapshot: 0x32,
  workSnapshot: 0x33,
  activityCommand: 0x34,
  phoneAction: 0x35,
} as const;

export const WatchActivitySnapshotSchema = z.object({
  version: z.literal(2),
  active: z.boolean(),
  paused: z.boolean(),
  elapsedSeconds: z.number().int().nonnegative(),
  speedCentiKph: z.number().int().min(0).max(20_000),
  distanceMeters: z.number().int().nonnegative(),
  // Unsigned MessagePack value; subtract 100000 to obtain signed decimeters.
  elevationDecimeters: z.number().int().min(0).max(200_000),
  gpsAccuracyDecimeters: z.number().int().nonnegative(),
  heartRate: z.number().int().min(0).max(300),
  cadence: z.number().int().min(0).max(300),
  label: z.string().max(128),
});

export const WatchWorkSnapshotSchema = z.object({
  version: z.literal(1),
  hostId: z.string().max(256),
  sessionId: z.string().max(512),
  title: z.string().max(256),
  summary: z.string().max(1_024),
  status: z.string().max(64),
  priority: z.number().int().min(0).max(5),
  updatedAt: z.number().int().nonnegative(),
}).refine(
  value => (value.sessionId.length === 0) === (value.title.length === 0),
  'sessionId and title must both be empty only for a clear snapshot',
);

export const WatchNavigationCueSchema = z.object({
  version: z.literal(1),
  distanceMeters: z.number().int().nonnegative(),
  instruction: z.string().max(256),
  kind: z.enum(['navigation', 'timer']).default('navigation'),
});

export const WatchActionSchema = z.object({
  version: z.literal(1),
  action: z.string().min(1).max(64),
  hostId: z.string().max(256).optional(),
  sessionId: z.string().max(512).optional(),
});

export type WatchActivitySnapshot = z.infer<typeof WatchActivitySnapshotSchema>;
export type WatchWorkSnapshot = z.infer<typeof WatchWorkSnapshotSchema>;
export type WatchNavigationCue = z.infer<typeof WatchNavigationCueSchema>;
export type WatchAction = z.infer<typeof WatchActionSchema>;

// ---- graphical Agent conversation ----
// Kept structural on purpose: a provider's record layout is a versioned adapter
// detail on the Host and never reaches a client. Only these bounded shapes do.

const AgentChatBindingSchema = z.object({
  hostId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(256),
  provider: z.enum(['codex', 'claude']),
  providerSessionId: z.string().max(128),
  owner: z.enum(['external', 'managed']),
  paneId: z.string().max(128).optional(),
  workspace: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  cwd: z.string().max(4_096).optional(),
});

const AgentChatStatusSchema = z.enum(['loading', 'ready', 'working', 'empty', 'unavailable']);

const AgentChatCapabilitiesSchema = z.object({
  history: z.boolean(),
  send: z.boolean(),
  stop: z.boolean(),
  attachments: z.boolean(),
  fileAttachments: z.boolean().optional(),
  approvals: z.boolean(),
  questions: z.boolean(),
  terminal: z.boolean(),
  degraded: z.string().max(500).optional(),
});

const AgentChatBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(24_000) }),
  z.object({
    type: z.literal('tool-call'),
    name: z.string().min(1).max(128),
    input: z.string().max(4_000),
    callId: z.string().max(128).optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool-result'),
    output: z.string().max(8_000),
    isError: z.boolean().optional(),
    callId: z.string().max(128).optional(),
    truncated: z.boolean().optional(),
  }),
  // No Host filesystem path travels here: a remote device cannot open one.
  z.object({
    type: z.literal('image-ref'),
    url: z.string().max(2_048).optional(),
    name: z.string().max(200).optional(),
    alt: z.string().max(500).optional(),
  }),
]);

const AgentChatMessageSchema = z.object({
  id: z.string().min(1).max(256),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  blocks: z.array(AgentChatBlockSchema).max(64),
  timestamp: z.number().int().nonnegative().nullable(),
  source: z.enum(['transcript', 'local']),
  seq: z.number().int().nonnegative(),
  turnId: z.string().max(256).optional(),
});

/**
 * Control messages travel inside a CONTROL frame (msgpack-encoded).
 * They are mostly low-frequency: handshake, lifecycle, tools, and negotiated
 * structured mobile transcript patches.
 * Discriminated on `t`. PTY data does NOT go here — it uses dedicated binary
 * frames (see frame.ts) so the hot path never pays JSON/msgpack overhead.
 */
export const ControlMessageSchema = z.discriminatedUnion('t', [
  AutomationSchema,
  ProxyTunnelSchema,
  RelayTopologySchema,
  z.object({ t: z.literal('desktop_attention'), id: z.string().uuid() }),
  z.object({ t: z.literal('desktop_subscribe'), deviceId: z.string().min(1).max(128), foreground: z.boolean() }),
  z.object({ t: z.literal('desktop_open'), id: z.string().max(32), hostId: z.string().max(128), deviceId: z.string().max(128), publicKey: z.string().max(100), nonce: z.string().max(48), proof: z.string().max(48) }),
  z.object({ t: z.literal('desktop_ready'), id: z.string().max(32), publicKey: z.string().max(100), salt: z.string().max(48), proof: z.string().max(48) }),
  z.object({ t: z.literal('desktop_data'), id: z.string().max(32), sequence: z.number().int().min(1).max(0xffffffff), data: z.string().max(87408) }),
  z.object({ t: z.literal('desktop_closed'), id: z.string().max(32), reason: z.string().max(256) }),
  // ---- handshake / lifecycle (relay <-> peer) ----
  z.object({
    t: z.literal('hello'),
    role: z.enum(['host', 'client']),
    hostId: z.string().max(128),
    name: z.string().optional(),
    // Opt-in relay capability. New clients receive the online host roster;
    // older relays safely ignore this optional field.
    wantsHosts: z.boolean().optional(),
    wantsTopology: z.boolean().optional(),
    // Host only: false refuses duplicate registration without evicting the
    // existing Host or its clients. Omitted retains legacy replacement behavior.
    replaceExisting: z.boolean().optional(),
    // Host-process lifetime identity: only the same instance may recover its
    // own stale registration when replaceExisting is false. Not sent in rosters.
    hostInstanceId: z.string().uuid().optional(),
    // Display grouping only; never an authentication identity.
    clientInstanceId: z.string().uuid().optional(),
  }),
  z.object({ t: z.literal('host_register_ok') }),
  z.object({
    t: z.literal('host_list_result'),
    hosts: z.array(z.object({ hostId: z.string(), name: z.string() })),
    selectedHostId: z.string().optional(),
  }),
  // Optional password auth (P2). The relay sends a fresh nonce on every
  // connection BEFORE hello; the peer proves it knows the shared secret via
  // HMAC-SHA256(secret, nonce) — the secret itself never crosses the wire.
  // `required` lets a peer give a crisp "this relay needs a password" error.
  z.object({ t: z.literal('auth_challenge'), nonce: z.string(), required: z.boolean() }),
  z.object({ t: z.literal('auth_response'), mac: z.string() }),
  // Synthetic, injected by the relay so the host learns of viewer lifecycle.
  // The clientId lives in the relay envelope (see frame.ts), not in the body.
  z.object({ t: z.literal('client_connect') }),
  z.object({ t: z.literal('client_disconnect') }),
  // Host-scoped relay routing. The phone is a management surface; the Host is
  // authoritative and persists this locally so reinstalls do not erase it.
  z.object({
    t: z.literal('network_policy_get'),
    requestId: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('network_policy_set'),
    requestId: z.string().min(1).max(128),
    policy: z.enum(['system', 'direct']),
  }),
  z.object({
    t: z.literal('network_policy_result'),
    requestId: z.string().min(1).max(128),
    policy: z.enum(['system', 'direct']),
    changed: z.boolean(),
    proxyDetected: z.boolean(),
  }),
  // A long-lived app or CLI connection advertises its executor independently
  // of Terminal attachment. CLI uses a persistent random deviceId and the
  // peer.desktop / peer.exec / peer.fs capability strings (not consent).
  // Same deviceId may have multiple live connections; the authenticated relay
  // envelope supplies clientId and binds each tool response to its requester.
  z.object({
    // Desktop CLI and native Mac App use these same fields; registration is not local consent.
    t: z.literal('peer_register'),
    deviceId: z.string().min(16).max(128),
    platform: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    role: z.literal('manager'),
    capabilities: z.array(z.string().min(1).max(128)).max(32),
  }),
  z.object({
    t: z.literal('phone_action_event'),
    eventId: z.string().min(1).max(160),
    actionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    callId: z.string().min(1).max(128),
    toolResultId: z.string().min(1).max(128),
    deviceId: z.string().min(16).max(128),
    action: z.enum([
      'alarm.create',
      'calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete',
      'todo.list', 'todo.create', 'todo.update', 'todo.complete', 'todo.delete',
      'photo.count', 'photo.fetch', 'photo.edit',
      'call.speaker.set',
      'screen.capture',
    ]),
    state: z.enum(['awaiting_user', 'running', 'completed', 'denied', 'failed', 'cancelled', 'expired']),
    summary: z.string().min(1).max(1_000),
    createdAt: z.number().int().nonnegative(),
    data: z.record(z.any()).optional(),
    error: z.string().max(1_000).optional(),
  }),
  z.object({
    t: z.literal('phone_action_event_ack'),
    eventId: z.string().min(1).max(160),
  }),
  z.object({ t: z.literal('error'), message: z.string() }),

  // ---- session control (client -> host) ----
  z.object({
    t: z.literal('session_create'),
    // A preset name (resolved by the host's config to a proxy-wrapped command),
    // e.g. "claude" / "codex". Mutually exclusive with `command`.
    agent: z.string().optional(),
    // A raw command (direct exec, no shell). Escape hatch for `new -- <cmd>`.
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    cols: z.number(),
    rows: z.number(),
    // The client's OS / name, so the host can tell the agent — via an appended
    // system prompt at launch — which machine (and shell) `tb peer` reaches.
    clientPlatform: z.string().optional(),
    clientName: z.string().optional(),
  }),
  z.object({ t: z.literal('session_created'), sessionId: z.string(), sid: z.number() }),

  z.object({ t: z.literal('session_list') }),
  // Opt-in traffic policy. notifications=true is for the app management connection.
  z.object({ t: z.literal('client_stream_policy'), background: z.boolean(), notifications: z.boolean() }),
  z.object({ t: z.literal('client_stream_policy_result'), background: z.boolean(), notifications: z.boolean() }),
  z.object({
    t: z.literal('session_list_result'),
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        command: z.string(),
        cols: z.number(),
        rows: z.number(),
        createdAt: z.number(),
        viewers: z.number(),
        // `pty` sessions are owned by termbridge; `herdr` sessions are existing
        // Herdr panes discovered through its socket API and are never PTY-wrapped.
        source: z.enum(['pty', 'herdr']).optional(),
        // User-facing identity. Herdr's explicit Agent name wins; otherwise
        // this is its workspace label. Keep sessionId for routing only.
        name: z.string().optional(),
        workspace: z.string().optional(),
        paneId: z.string().optional(),
        agent: z.string().optional(),
        status: z.string().optional(),
        // Set when the host observes an agent transition into `done`. Herdr's
        // snapshot has no historical timestamp, so older finished panes may
        // legitimately omit this field.
        completedAt: z.number().optional(),
        preview: z.string().optional(),
      }),
    ),
  }),

  // Client asks the host which agent presets it has configured (for `tb new`'s picker).
  z.object({ t: z.literal('agents') }),
  z.object({ t: z.literal('agents_result'), names: z.array(z.string()) }),

  z.object({
    t: z.literal('session_directory_list'), requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256), path: z.string().min(1).max(4096),
  }),
  z.object({
    t: z.literal('session_directory_result'), requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256), path: z.string().max(4096).optional(), rootPath: z.string().max(4096).optional(),
    entries: z.array(z.object({ name: z.string().min(1).max(4096), directory: z.boolean() })).max(1000).optional(),
    truncated: z.boolean().optional(), error: z.string().max(1000).optional(),
  }),
  z.object({
    t: z.literal('session_scroll'), sid: z.number().int().min(0).max(65535),
    direction: z.enum(['up', 'down']), lines: z.number().int().min(1).max(100),
  }),
  z.object({
    t: z.literal('session_scroll_result'), sid: z.number().int().min(0).max(65535),
    ok: z.boolean(), error: z.string().max(256).optional(),
  }),
  // A user-selected workspace file, read in bounded sequential chunks.
  z.object({
    t: z.literal('session_file_read'),
    // @global is rooted at TB_BRAIN_FILES_ROOT (default ~/code), without extra preview roots.
    requestId: z.string().min(1).max(128), sessionId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096), offset: z.number().int().min(0).max(20 * 1024 * 1024),
    version: z.string().max(256).optional(),
    // The committed version of a file inside a Git repository this session may
    // read, for comparing a changed or deleted file with what it was.
    revision: z.literal('HEAD').optional(),
  }),
  z.object({
    t: z.literal('session_file_result'),
    requestId: z.string().min(1).max(128), sessionId: z.string().min(1).max(256),
    path: z.string().max(4096).optional(), rootPath: z.string().max(4096).optional(),
    name: z.string().max(4096).optional(), size: z.number().int().min(0).max(20 * 1024 * 1024).optional(),
    version: z.string().max(256).optional(), offset: z.number().int().min(0).optional(),
    data: z.instanceof(Uint8Array).optional(), eof: z.boolean().optional(),
    error: z.string().max(1000).optional(),
  }),

  // ---- mobile Git review (client <-> host) ----
  // The client selects a session, never an arbitrary filesystem path. The Host
  // resolves that session's cwd, finds its Git root, and returns bounded data.
  z.object({
    t: z.literal('review_probe'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
  }),
  z.object({
    t: z.literal('review_probe_result'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    available: z.boolean(),
    mode: z.enum(['working', 'branch', 'files']).optional(),
    error: z.string().max(1_000).optional(),
  }),
  z.object({
    t: z.literal('review_snapshot'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    mode: z.enum(['working', 'branch', 'files']),
    baseBranch: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(4_096).optional(),
    // One of the `repositoryPath`s from `review_repositories_result` for this
    // session; absent means the session's own working directory.
    repository: z.string().min(1).max(2_048).optional(),
  }),
  z.object({
    t: z.literal('review_snapshot_result'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    snapshot: ReviewSnapshotSchema.optional(),
    error: z.string().max(1_000).optional(),
  }),
  // Every repository associated with the conversation, each with its current
  // changes, so a client can show them together. Paths come only from the Host.
  z.object({
    t: z.literal('review_repositories'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
  }),
  z.object({
    t: z.literal('review_repositories_result'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    repositories: z.array(ReviewRepositorySchema).max(12).optional(),
    error: z.string().max(1_000).optional(),
  }),
  z.object({
    t: z.literal('review_switch_branch'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    branch: z.string().min(1).max(256),
  }),
  z.object({
    t: z.literal('review_switch_branch_result'),
    requestId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(256),
    ok: z.boolean(),
    branch: z.string().min(1).max(256).optional(),
    error: z.string().max(1_000).optional(),
  }),

  // Semantic composer send. PTY input remains the transport for terminal
  // bytes; this bounded control event lets Global remember exactly which
  // attached Agent the user messaged without trying to reconstruct keystrokes.
  z.object({
    t: z.literal('session_message'),
    sessionId: z.string().min(1).max(256),
    text: z.string().min(1).max(16_000),
    clientPlatform: z.string().max(64).optional(),
  }),

  // ---- graphical Agent conversation (client <-> host) ----
  // A second view of ONE already-running Agent, never a second Agent. The Host
  // reads that session's own structured records and sends through the input
  // channel it already has; opening a conversation must not move, restart or
  // take over the pane. Navigation is client-local: each connection subscribes
  // to what it is looking at, so one device's choice never changes another's.
  z.object({
    t: z.literal('agent_chat_list'),
    requestId: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('agent_chat_list_result'),
    requestId: z.string().min(1).max(128),
    conversations: z.array(z.object({
      conversationId: z.string().min(1).max(256),
      paneId: z.string().min(1).max(128),
      provider: z.enum(['codex', 'claude']).optional(),
      title: z.string().max(200).optional(),
      workspace: z.string().max(200).optional(),
      status: z.string().max(64),
      // False whenever no verified structured record backs this exact session.
      chat: z.boolean(),
      reason: z.string().max(500).optional(),
    })).max(500),
  }),
  // `generation` is the client's own subscription counter. The Host echoes it on
  // every event, so a client that switched conversations discards anything that
  // still carries the previous generation instead of writing it into the new view.
  z.object({
    t: z.literal('agent_chat_subscribe'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative().max(2 ** 31),
  }),
  z.object({
    t: z.literal('agent_chat_unsubscribe'),
    conversationId: z.string().min(1).max(256),
  }),
  z.object({
    t: z.literal('agent_chat_snapshot'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    binding: AgentChatBindingSchema.optional(),
    status: AgentChatStatusSchema,
    capabilities: AgentChatCapabilitiesSchema,
    messages: z.array(AgentChatMessageSchema).max(400),
    seq: z.number().int().nonnegative(),
    // Opaque paging token for `agent_chat_earlier`; absent at the head.
    earlierCursor: z.number().int().nonnegative().optional(),
    error: z.string().max(1_000).optional(),
  }),
  z.object({
    t: z.literal('agent_chat_append'),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    status: AgentChatStatusSchema,
    capabilities: AgentChatCapabilitiesSchema,
    messages: z.array(AgentChatMessageSchema).max(200),
    seq: z.number().int().nonnegative(),
  }),
  // `generation` travels on the request and comes back unchanged, so a page
  // fetched for a conversation the user has since left is discarded by the same
  // rule as every other event rather than landing in the view they are on now.
  z.object({
    t: z.literal('agent_chat_earlier'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative().max(2 ** 31),
    cursor: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('agent_chat_earlier_result'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    messages: z.array(AgentChatMessageSchema).max(400),
    cursor: z.number().int().nonnegative().optional(),
    atHead: z.boolean(),
    error: z.string().max(1_000).optional(),
  }),
  z.object({
    t: z.literal('agent_chat_send'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    text: z.string().min(1).max(16_000),
  }),
  // A control key for the conversation's own pane.
  //
  // The chat view has no attached terminal, so it cannot write bytes the way the
  // Terminal does — and it must not, because a key is not a message and sending
  // one as text would put an escape sequence in the transcript. This carries a
  // *name* from a closed set, which the Host resolves to bytes itself: a client
  // can never inject an arbitrary sequence. It is authorized by the same live
  // subscription and generation as a send, so a key cannot reach a conversation
  // this connection is not currently bound to.
  z.object({
    t: z.literal('agent_chat_key'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    key: z.enum(AGENT_CHAT_KEYS),
  }),
  z.object({
    t: z.literal('agent_chat_key_result'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    // Echoed so a result from a subscription the client has left cannot be
    // shown against the conversation they are looking at now.
    generation: z.number().int().nonnegative(),
    ok: z.boolean(),
    error: z.string().max(400).optional(),
  }),
  // The receipt chain. `delivered` means the Agent's input channel took the
  // bytes; only `observed` means the Agent's own record contains the prompt.
  // `uncertain` is an unknown write outcome and must never be auto-resent.
  z.object({
    t: z.literal('agent_chat_delivery'),
    requestId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    state: z.enum(['accepted', 'delivered', 'observed', 'uncertain', 'failed']),
    at: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(256).optional(),
    error: z.string().max(1_000).optional(),
  }),

  // ---- global Brain conversation (client <-> host) ----
  // Brain is deliberately a cloud conversation/control-plane surface. Text is
  // answered by Bailian; a durable worker task exists only after the model calls
  // dispatch_agent. The terminal remains an optional execution-detail view.
  z.object({ t: z.literal('brain_snapshot') }),
  z.object({ t: z.literal('brain_completion_action'), requestId: z.string().min(1).max(128),
    id: z.string().regex(/^completion-[a-f0-9]{32}$/), action: z.enum(['approve', 'dismiss']) }),
  z.object({ t: z.literal('brain_completion_result'), requestId: z.string(), ok: z.boolean(), error: z.string().optional() }),
  VoiceLearningRequestSchema,
  VoiceLearningResultSchema,
  z.object({
    t: z.literal('brain_snapshot_result'),
    systemReminders: SystemRemindersSchema,
    workflows: z.array(z.enum(['standard', 'silent'])).optional(),
    dictation: z.boolean().optional(),
    silentCall: z.boolean().optional(),
    voiceLearning: z.union([z.literal(1), z.literal(2)]).optional(),
    messages: z.array(BrainMessageSchema),
    tasks: z.array(BrainTaskSchema),
    toolResults: z.array(BrainToolResultSchema).max(100).optional(),
    routeDecisions: z.array(BrainRouteDecisionSchema).max(100).optional(),
    runEvents: z.array(BrainRunEventSchema).max(300).optional(),
    deliverables: z.array(BrainDeliverableSchema).max(100).optional(),
    toolCatalog: z.array(BrainToolDescriptorSchema).max(32).optional(),
    executionEvents: z.array(ExecutionForkEventSchema).max(300).optional(),
    history: z.array(BrainConversationSummarySchema).max(30).optional(),
    voiceUsage: VoiceUsageSummarySchema.optional(),
  }),
  z.object({ t: z.literal('brain_new') }),
  z.object({ t: z.literal('brain_clear') }),
  z.object({
    t: z.literal('brain_restore'),
    conversationId: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('brain_history'),
    conversationId: z.string().min(1).max(128),
  }),
  z.object({
    t: z.literal('brain_history_result'),
    conversation: BrainConversationHistorySchema,
  }),
  z.object({
    t: z.literal('brain_send'),
    workflow: z.enum(['standard', 'silent']).optional(),
    modelTier: z.enum(['advanced', 'deep']).optional(),
    requestId: z.string().min(1).max(128),
    text: z.string().min(1).max(16_000),
    agent: z.string().min(1).max(128).optional(),
    clientPlatform: z.string().optional(),
    sourceSessionId: z.string().min(1).max(256).optional(),
    imageAttachment: BrainImageAttachmentSchema.optional(),
  }),
  z.object({ t: z.literal('brain_accepted'), requestId: z.string() }),
  z.object({ t: z.literal('brain_cancel'), requestId: z.string().min(1).max(128) }),
  z.object({ t: z.literal('brain_cancel_result'), requestId: z.string(), cancelled: z.boolean() }),
  z.object({ t: z.literal('brain_text_result'), requestId: z.string(),
    status: z.enum(['completed', 'failed', 'cancelled']), text: z.string().max(2000) }),
  z.object({
    t: z.literal('brain_text_delta'),
    requestId: z.string().min(1).max(128),
    delta: z.string().max(16_000),
    text: z.string().max(16_000),
    final: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('brain_execution_event'),
    event: ExecutionForkEventSchema,
  }),
  z.object({
    t: z.literal('brain_voice_start'),
    turnControl: z.enum(['provider', 'adaptive']).optional(),
    requestId: z.string().min(1).max(128),
    locale: z.string().max(64).optional(),
    sendKeyword: z.string().min(1).max(32),
    mode: z.enum(['call', 'dictation']).optional(),
    workflow: z.enum(['standard', 'silent']).optional(),
    modelTier: z.enum(['advanced', 'deep']).optional(),
    outputMode: z.enum(['voice', 'text']).optional(),
    provider: z.enum(['auto', 'bailian', 'volcengine']).optional(),
    agent: z.string().min(1).max(128).optional(),
    technicalTerms: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    imageAttachment: BrainImageAttachmentSchema.optional(),
  }),
  z.object({
    t: z.literal('brain_voice_image_attachment'),
    requestId: z.string().min(1).max(128),
    imageAttachment: BrainImageAttachmentSchema.nullable(),
  }),
  z.object({
    t: z.literal('brain_voice_presentation'),
    requestId: z.string().min(1).max(128),
    presentation: z.enum(['foreground', 'overlay']),
  }),
  z.object({
    t: z.literal('brain_voice_input_audio'),
    requestId: z.string().min(1).max(128),
    data: z.instanceof(Uint8Array),
  }),
  z.object({
    t: z.literal('brain_voice_diagnostic'),
    requestId: z.string().min(1).max(128).optional(),
    event: z.string().trim().min(1).max(80),
    provider: z.enum(['auto', 'bailian', 'volcengine']).optional(),
    fields: z.record(z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]))
      .refine((value) => Object.keys(value).length <= 16)
      .optional(),
  }),
  z.object({ t: z.literal('brain_voice_commit'), requestId: z.string().min(1).max(128) }),
  z.object({ t: z.literal('brain_voice_cancel'), requestId: z.string().min(1).max(128) }),
  z.object({
    t: z.literal('brain_voice_output_mode'),
    requestId: z.string().min(1).max(128),
    outputMode: z.enum(['voice', 'text']),
  }),
  z.object({ t: z.literal('brain_voice_stop'), requestId: z.string().min(1).max(128) }),
  z.object({
    t: z.literal('brain_voice_ready'),
    requestId: z.string(),
    provider: z.enum(['bailian', 'volcengine']).optional(),
    model: z.string().min(1).max(128).optional(),
    connectLatencyMs: z.number().int().nonnegative().max(300_000).optional(),
  }),
  z.object({
    t: z.literal('brain_voice_transcript'),
    requestId: z.string(),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({
    t: z.literal('brain_voice_text'),
    requestId: z.string(),
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({
    t: z.literal('brain_voice_output_audio'),
    requestId: z.string(),
    data: z.instanceof(Uint8Array),
    sampleRate: z.literal(24_000),
  }),
  z.object({
    t: z.literal('brain_voice_status'),
    turnWaitReason: z.enum(['incomplete', 'unavailable']).optional(),
    requestId: z.string(),
    status: z.enum(['responding', 'listening', 'tool', 'echo', 'notification']),
    toolName: z.string().max(128).optional(),
    toolPhase: z.enum(['started', 'completed', 'failed']).optional(),
    toolSummary: z.string().max(512).optional(),
    notificationKind: z.enum(['agent_completion']).optional(),
    latencyMs: z.number().int().nonnegative().max(300_000).optional(),
  }),
  z.object({
    t: z.literal('brain_voice_tool_result'),
    requestId: z.string().min(1).max(128),
    callId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    view: VoiceToolViewSchema,
  }),
  z.object({ t: z.literal('brain_voice_stopped'), requestId: z.string() }),
  z.object({ t: z.literal('brain_voice_error'), requestId: z.string(), error: z.string() }),
  z.object({
    t: z.literal('brain_transcribe_start'),
    requestId: z.string().min(1).max(128),
    locale: z.string().max(64).optional(),
    hints: z.array(z.string().min(1).max(64)).max(64).optional(),
  }),
  z.object({
    t: z.literal('brain_transcribe_audio'),
    requestId: z.string().min(1).max(128),
    // Raw mono PCM16 at 16 kHz. Small chunks keep relay latency low and avoid
    // ever placing the host's cloud credential on the phone.
    data: z.instanceof(Uint8Array),
  }),
  z.object({ t: z.literal('brain_transcribe_commit'), requestId: z.string().min(1).max(128) }),
  z.object({ t: z.literal('brain_transcribe_finish'), requestId: z.string().min(1).max(128) }),
  z.object({ t: z.literal('brain_transcribe_cancel'), requestId: z.string().min(1).max(128) }),
  z.object({
    t: z.literal('brain_transcribe'),
    requestId: z.string().min(1).max(128),
    mime: z.literal('audio/wav'),
    data: z.instanceof(Uint8Array),
    locale: z.string().max(64).optional(),
  }),
  z.object({
    t: z.literal('brain_transcribe_result'),
    requestId: z.string(),
    text: z.string().optional(),
    final: z.boolean().optional(),
    finished: z.boolean().optional(),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal('brain_synthesize'),
    requestId: z.string().min(1).max(128),
    text: z.string().min(1).max(4_000),
    locale: z.string().max(64).optional(),
    voice: z.string().max(128).optional(),
  }),
  z.object({
    t: z.literal('brain_synthesize_result'),
    requestId: z.string(),
    mime: z.literal('audio/wav').optional(),
    data: z.instanceof(Uint8Array).optional(),
    sampleRate: z.number().int().positive().optional(),
    error: z.string().optional(),
  }),

  // Host config read/write (for `tb info` / `tb set` / `tb rm`).
  z.object({ t: z.literal('config_get') }),
  z.object({ t: z.literal('config_set'), name: z.string(), command: z.string() }),
  z.object({ t: z.literal('config_remove'), name: z.string() }),
  z.object({
    t: z.literal('config_info'),
    version: z.string().optional(),
    automation: z.boolean().optional(),
    proxyTunnel: ProxyTunnelPolicySchema.optional(),
    hostId: z.string(),
    hostName: z.string(),
    shell: z.string(),
    agents: z.record(z.string()),
    agentRegistry: z.array(AgentDescriptorSchema).max(100).optional(),
    backend: z.string().optional(), // 'tmux' | 'direct' — which session backend is active
  }),

  z.object({
    t: z.literal('attach'),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    // Herdr's ANSI screen is laid out at the desktop pane width. Native mobile
    // viewers can request the same pane as reflowable text without resizing it.
    presentation: z.enum(['terminal', 'mobile']).optional(),
    // Negotiated so older native clients keep receiving legacy PTY redraws.
    mobilePatches: z.boolean().optional(),
    // Opt-in native Herdr stream; attach_ok must acknowledge support.
    nativeTerminal: z.boolean().optional(),
  }),
  z.object({ t: z.literal('attach_ok'), sessionId: z.string(), sid: z.number(), nativeTerminal: z.boolean().optional(),
    historyScroll: z.boolean().optional() }),
  z.object({
    t: z.literal('terminal_mobile_snapshot'),
    sid: z.number().int().min(0).max(0xffff),
    revision: z.number().int().nonnegative(),
    payload: z.instanceof(Uint8Array),
  }),
  z.object({
    t: z.literal('terminal_mobile_patch'),
    sid: z.number().int().min(0).max(0xffff),
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    payload: z.instanceof(Uint8Array),
  }),
  z.object({
    t: z.literal('terminal_mobile_resync'),
    sid: z.number().int().min(0).max(0xffff),
    revision: z.number().int().nonnegative().optional(),
  }),

  // A native client can receive/convert an image, then place it on the host so
  // the terminal agent gets a local path instead of raw image bytes in its TTY.
  z.object({
    t: z.literal('session_upload'),
    id: z.string(),
    sessionId: z.string(),
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']),
    fileName: z.string().max(255).optional(),
    data: z.instanceof(Uint8Array),
  }),
  z.object({
    t: z.literal('session_upload_result'),
    id: z.string(),
    sessionId: z.string(),
    path: z.string().optional(),
    error: z.string().optional(),
  }),

  z.object({ t: z.literal('kill'), sessionId: z.string() }),
  // Respawn a session's command in place (tmux backend: revive a dead pane).
  z.object({ t: z.literal('session_restart'), sessionId: z.string() }),
  z.object({ t: z.literal('session_exit'), sessionId: z.string(), exitCode: z.number() }),

  // ---- reverse tool channel (the host's agent → the client's machine) ----
  // The agent running on the host invokes a tool that executes on the machine of
  // the CLIENT attached to its session — that client's files / shell / browser.
  // Request/response RPC, correlated by `id`. `op` selects the tool
  // ('exec' | 'fs.read' | 'fs.write' | 'fs.ls' | 'fs.stat' | 'info'); `args` is
  // op-specific so it stays loose on the wire (the client's executor validates).
  z.object({
    t: z.literal('tool_request'),
    id: z.string(),
    op: z.string(),
    args: z.record(z.any()).optional(),
  }),
  PeerCallSchema,
  z.object({
    t: z.literal('peer_call_result'), id: z.string().min(1).max(128), ok: z.boolean(),
    exit: z.number().optional(), stdout: z.string().optional(), stderr: z.string().optional(),
    data: z.unknown().optional(), error: z.string().optional(),
  }),
  z.object({
    t: z.literal('tool_response'),
    id: z.string(),
    ok: z.boolean(),
    exit: z.number().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    data: z.any().optional(),
    error: z.string().optional(),
  }),
]);

export type ControlMessage = z.infer<typeof ControlMessageSchema>;

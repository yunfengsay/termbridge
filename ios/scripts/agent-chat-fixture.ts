/** Synthetic protocol peer for iOS UI acceptance. No real Agent or transcript access. */
import { WebSocketServer } from 'ws';
import { encodeControl, parseFrame, FrameType, type ControlMessage } from '../../packages/protocol/src/index.ts';
const server = new WebSocketServer({ host: '127.0.0.1', port: 38641 });
const id = 'herdr:ios-synthetic';
const capabilities = { history: true, send: true, stop: false, attachments: false,
  approvals: false, questions: false, terminal: true };
const message = (seq: number, text: string, role: 'user' | 'assistant' = 'assistant') => ({
  id: `synthetic-${seq}`, seq, role, source: 'transcript' as const, timestamp: 0,
  blocks: [{ type: 'text' as const, text }],
});
server.on('connection', (socket) => {
  let generation = 0;
  let subscribed = false;
  const send = (frame: ControlMessage) => socket.send(encodeControl(frame));
  send({ t: 'auth_challenge', nonce: 'synthetic-nonce', required: false });
  socket.on('message', (bytes) => {
    const frame = parseFrame(Buffer.from(bytes as Buffer));
    if (frame.type !== FrameType.Control) return;
    const request = frame.msg;
    console.log(JSON.stringify({ op: request.t, ...(request.t === 'agent_chat_earlier' ? { generation: request.generation } : {}) }));
    switch (request.t) {
      case 'hello': send({ t: 'host_list_result', hosts: [{ hostId: 'ios-chat-fixture', name: 'Agent Chat QA' }], selectedHostId: 'ios-chat-fixture' }); break;
      case 'session_list': send({ t: 'session_list_result', sessions: [{ sessionId: id, command: 'synthetic', name: 'Synthetic Agent', source: 'herdr', agent: 'claude', cols: 80, rows: 24, createdAt: 0, viewers: 0, status: 'done' }] }); break;
      case 'agents': send({ t: 'agents_result', names: [] }); break;
      case 'agent_chat_list': send({ t: 'agent_chat_list_result', requestId: request.requestId, conversations: [{ conversationId: id, paneId: 'ios-synthetic', provider: 'claude', title: 'Synthetic Agent', status: 'ready', chat: true }] }); break;
      case 'agent_chat_subscribe':
        generation = request.generation; subscribed = true;
        send({ t: 'agent_chat_snapshot', requestId: request.requestId, conversationId: id, generation,
          status: 'ready', capabilities, messages: [message(2, 'Synthetic conversation ready. 这是合成记录。')], seq: 2, earlierCursor: 1 });
        break;
      case 'agent_chat_send':
        if (!subscribed) throw Error('Must subscribe before sending');
        for (const state of ['accepted', 'delivered', 'observed'] as const) {
          send({ t: 'agent_chat_delivery', conversationId: id, generation, requestId: request.requestId, state, at: Date.now(), ...(state === 'observed' ? { messageId: 'synthetic-3' } : {}) });
        }
        send({ t: 'agent_chat_append', conversationId: id, generation, status: 'ready', capabilities,
          messages: [message(3, request.text, 'user'), message(4, 'Synthetic reply confirmed.')], seq: 4 });
        break;
      case 'agent_chat_earlier':
        if (request.generation !== generation) throw Error('Stale page requested');
        send({ t: 'agent_chat_earlier_result', conversationId: id, generation, requestId: request.requestId,
          messages: [message(1, 'Earlier synthetic history.')], atHead: true });
        break;
      case 'agent_chat_unsubscribe': subscribed = false; break;
      case 'attach': send({ t: 'attach_ok', sessionId: id, sid: 1 }); break;
    }
  });
});
console.log('iOS synthetic chat fixture listening on loopback 38641');

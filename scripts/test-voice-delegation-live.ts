/** Opt-in cloud smoke test. Authored fixtures only; no mic, player, Host or real workers. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { BailianVoiceService } from '../packages/voice/src/index.js';
import { buildVoiceConversationInput } from '../packages/host/src/voicePrompt.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live for two bounded cloud fixture calls');
if (!process.env.DASHSCOPE_API_KEY) throw new Error('Bailian credential is not configured');
for (const delivered of [true, false]) {
  const service = new BailianVoiceService({apiKey: process.env.DASHSCOPE_API_KEY,
    realtimeSocketFactory(url, options) {
      const socket = new WebSocket(url, options);
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.updated') console.log(JSON.stringify({event: event.type, tools: event.session?.tools, turnDetection: event.session?.turn_detection}));
        if (event.type === 'response.done') console.log(JSON.stringify({event: event.type, response: event.response}));
      });
      return socket;
    },
  });
  let calls = 0, draft = '', settled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error('fixture deadline')), 30000);
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(idle); call.close();
      if (error) reject(error); else resolve();
    };
    const call = service.startRealtimeConversation(buildVoiceConversationInput({
      mode: 'call', sendKeyword: '发送', outputAudioEnabled: false,
      runtimeContext: 'Synthetic test roster: name=termbridge-voice; agent=codex; session=herdr:fixture:1; workspace=TermBridge. Recent Global conversation: user: 最近完成的 Agent 是哪个？ assistant: termbridge-voice。 Names are labels; this is a terminal Codex worker, not the voice interface.',
    }), {
      onReady() { call.injectUserMessage('让他提交代码并且 push，发给他就行，他自己知道。'); },
      onTranscript() {}, onTurnSubmitted() {}, onAudio() { finish(new Error('text fixture unexpectedly produced audio')); },
      onText(text, final) { draft = final ? text : draft + text; },
      onResponseStarted() { clearTimeout(idle); draft = ''; },
      onResponseFinished() {
        if (settled) return;
        idle = setTimeout(() => {
          try {
            assert.equal(calls, 1, 'must call the fixture dispatcher exactly once');
            assert(draft.length > 0 && draft.length <= 60, `confirmation too long: ${draft.length}`);
            if (delivered) {
              assert.match(draft, /已.*(发|转|交|委派)/);
              assert.doesNotMatch(draft, /请.*(确认|分支|项目)|没有.*权限|不具备|还需要/);
            } else {
              assert.match(draft, /离线|未.*发|没.*发|失败/);
              assert.doesNotMatch(draft, /已.*(发给|转发|提交|推送)/);
            }
            console.log(JSON.stringify({fixture: delivered ? 'delivered' : 'offline', calls, characters: draft.length, reply: draft, passed: true}));
            finish();
          } catch (error) { finish(error as Error); }
        }, 1200);
      },
      onFinished() {}, onError(error) { finish(error); },
      async onToolCall(tool) {
        calls++; assert.equal(tool.name, 'fork_execution');
        assert.match(String(tool.arguments.text), /提交|push/);
        return JSON.stringify(delivered ? {ok: true, answer: '已发送给 termbridge-voice。', status: 'dispatched', sessionId: 'herdr:fixture:1'} :
          {ok: false, answer: '未发送：目标 Agent 已离线。', error: 'target_offline'});
      },
    });
  });
}

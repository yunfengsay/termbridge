import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { BailianVoiceService } from '@termbridge/voice';
import {
  buildTextBrainInstructions,
  buildVoiceFrontendInstructions,
  buildVoiceConversationInput,
  buildVoiceBrainInstructions,
  isSilentInterruptionPhrase,
  normalizeSpeechVocabulary,
  selectVoiceContextMessages,
} from './voicePrompt.js';

test('recipient policy distinguishes user-to-Global speech, quoted Agent messages and corrections', () => {
  for (const prompt of [buildTextBrainInstructions({runtimeContext: 'fixture'}),
    buildVoiceFrontendInstructions({mode: 'call', sendKeyword: '发送'})]) {
    assert.match(prompt, /Recipient and speech-act contract/);
    assert.match(prompt, /correction is not.*resend/i);
    assert.match(prompt, /ranking.*not.*recipient/i);
    assert.match(prompt, /quoted.*not.*instructions.*you/i);
  }
});

class CallSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, any>[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() {}
  event(value: object) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

test('production call route streams the first Omni chunk without judge, fork or secondary TTS', async () => {
  const socket = new CallSocket(); let tools = 0, bytes = 0; const text: string[] = [];
  const input = buildVoiceConversationInput({ mode: 'call', sendKeyword: '发送', outputAudioEnabled: true,
    runtimeContext: 'earlier technical discussion; Agent baseline', persistentMemory: 'prefer Chinese' });
  assert.equal(input.turnJudge, undefined);
  assert.match(input.instructions, /earlier technical discussion/);
  assert.match(input.instructions, /prefer Chinese/);
  assert.match(input.instructions, /screen.capture/);
  const service = new BailianVoiceService({ apiKey: 'test', realtimeSocketFactory: () => socket,
    request: async () => { assert.fail('a realtime greeting must not invoke HTTP TTS'); } });
  const call = service.startRealtimeConversation(input, {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onText: value => text.push(value),
    onAudio: value => { bytes += value.length; }, onResponseStarted() {}, onResponseFinished() {}, onFinished() {},
    onError: error => assert.fail(error.message), onToolCall: async () => { tools++; return '{}'; },
  });
  try {
    socket.emit('open'); socket.event({type: 'session.updated'});
    assert.equal(socket.sent[0].session.turn_detection.type, 'semantic_vad');
    assert.equal(socket.sent[0].session.turn_detection.create_response, true);
    socket.event({type: 'input_audio_buffer.speech_started', item_id: 'a'});
    socket.event({type: 'input_audio_buffer.speech_stopped', item_id: 'a'});
    socket.event({type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '你听得到我吗'});
    socket.event({type: 'response.created', response: {id: 'r'}});
    socket.event({type: 'response.audio.delta', response_id: 'r', delta: 'AAAA'});
    socket.event({type: 'response.audio_transcript.delta', response_id: 'r', delta: '听得到'});
    assert.equal(bytes, 3, 'first chunk is delivered before response.done');
    assert.deepEqual(text, ['听得到']);
    socket.event({type: 'response.done', response: {id: 'r', status: 'completed'}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tools, 0, 'response completion must not trigger forced execution');
  } finally { call.close(); }
});

test('production call route retains explicit execution tool receipts and Omni continuation', async () => {
  const socket = new CallSocket(); let tools = 0;
  const service = new BailianVoiceService({apiKey: 'test', realtimeSocketFactory: () => socket});
  const call = service.startRealtimeConversation(buildVoiceConversationInput({ mode: 'call', sendKeyword: '发送', outputAudioEnabled: true }), {
    onReady() {}, onTranscript() {}, onTurnSubmitted() {}, onText() {}, onAudio() {},
    onResponseStarted() {}, onResponseFinished() {}, onFinished() {}, onError: error => assert.fail(error.message),
    onToolCall: async tool => { tools++; assert.equal(tool.name, 'fork_execution'); return '{"ok":true,"answer":"fixture receipt"}'; },
  });
  try {
    socket.emit('open'); socket.event({type: 'session.updated'});
    socket.event({type: 'response.function_call_arguments.done', name: 'fork_execution', call_id: 'tool-1', arguments: '{"text":"查看当前 Agent"}'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tools, 1);
    assert.equal(socket.sent.filter(e => e.item?.type === 'function_call_output').length, 1);
    assert.equal(socket.sent.filter(e => e.type === 'response.create').length, 1);
  } finally { call.close(); }
});

test('text Global Brain uses the same cloud orchestrator boundary without treating Codex as the chat model', () => {
  const prompt = buildTextBrainInstructions({
    runtimeContext: '[structured host context]',
    persistentMemory: 'Prefer concise implementation.',
  });

  assert.match(prompt, /tool execution orchestrator/i);
  assert.doesNotMatch(prompt, /You are Pi with Qwen/i);
  assert.match(prompt, /answer technical discussion directly/i);
  assert.match(prompt, /never start a local worker merely to produce a conversational answer/i);
  assert.match(prompt, /dispatch_agent/);
  assert.match(prompt, /continue_agent/);
  assert.match(prompt, /inspect_workspace/);
  assert.match(prompt, /structured host context/);
  assert.match(prompt, /Prefer concise implementation/);
  assert.doesNotMatch(prompt, /continuous phone call/i);
  assert.doesNotMatch(prompt, /send keyword/i);
});

test('realtime speech answers directly and forks only work requiring tools', () => {
  const prompt = buildVoiceFrontendInstructions({
    mode: 'call',
    sendKeyword: '发送',
    technicalTerms: ['Agent', 'Skill'],
  });
  assert.match(prompt, /answer.*directly.*stream/i);
  assert.match(prompt, /live.*state.*fork_execution/i);
  assert.doesNotMatch(prompt, /every substantive|do not answer questions|owns every semantic/i);
  assert.doesNotMatch(prompt, /inspect_workspace|dispatch_agent|phone_action/);
});

test('delegation policy separates the voice dispatcher from named terminal agents and uses receipt-only acknowledgements', () => {
  for (const prompt of [buildVoiceFrontendInstructions({mode: 'call', sendKeyword: '发送'}),
    buildTextBrainInstructions({runtimeContext: 'fixture'})]) {
    assert.match(prompt, /display name is not.*capabilit/i);
    assert.match(prompt, /do not ask.*branch.*commit message/i);
    assert.match(prompt, /好的，已发给他了/);
    assert.match(prompt, /one short sentence/i);
    assert.match(prompt, /do not end.*anything else/i);
    assert.match(prompt, /do not narrate/);
    assert.match(prompt, /phoneOutcomes.*supersede/);
  }
});

test('Voice Brain is a technical orchestrator with explicit freshness rules', () => {
  const prompt = buildVoiceBrainInstructions({
    mode: 'call',
    sendKeyword: '发送',
    runtimeContext: '[structured host context]',
    persistentMemory: 'Preferred implementation style: concise and elegant.',
  });

  assert.match(prompt, /not an open-ended lifestyle assistant/i);
  assert.match(prompt, /technical design/i);
  assert.match(prompt, /no direct code-writing/i);
  assert.match(prompt, /all such execution belongs to a terminal worker Agent/i);
  assert.match(prompt, /inspect_workspace/);
  assert.match(prompt, /view=overview/i);
  assert.match(prompt, /view=recent/i);
  assert.match(prompt, /view=tasks/i);
  assert.match(prompt, /view=agent/i);
  assert.match(prompt, /search_web/);
  assert.match(prompt, /fresh public information/i);
  assert.match(prompt, /workspace_files/);
  assert.match(prompt, /phone_action/);
  assert.match(prompt, /call phone_action immediately/i);
  assert.match(prompt, /do not ask for another conversational confirmation/i);
  assert.match(prompt, /never say.*created.*until.*completed/i);
  assert.match(prompt, /bounded multi-selection/i);
  assert.match(prompt, /photo\.count.*never exposes image content/i);
  assert.match(prompt, /photo\.fetch.*at most three/i);
  assert.match(prompt, /@memory/);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /limit=1/i);
  assert.match(prompt, /call-start baseline/i);
  assert.match(prompt, /live tool result.*authority/i);
  assert.match(prompt, /shown on the phone/i);
  assert.match(prompt, /do not read every card/i);
  assert.match(prompt, /Persistent user memory/);
  assert.match(prompt, /concise and elegant/);
  assert.doesNotMatch(prompt, /Answer simple conversation and questions directly/);
  assert.doesNotMatch(prompt, /list_agents|get_recent_completions|get_task_status|get_agent_context/);
  assert.match(prompt, /do not acknowledge the interruption/i);
  assert.match(prompt, /must call continue_agent or dispatch_agent in that same turn/i);
  assert.match(prompt, /requested implementation must be delegated/i);
  assert.match(prompt, /Speak name, never the id/i);
  assert.match(prompt, /several Agents share a name/i);
});

test('Voice Brain receives a bounded technical speech vocabulary as data', () => {
  const prompt = buildVoiceBrainInstructions({
    mode: 'call',
    sendKeyword: '发送',
    runtimeContext: '[structured host context]',
    technicalTerms: ['Token', 'LLM', 'Skill', 'Agent', 'token', ' bad\nterm '],
  });

  assert.match(prompt, /\[Speech vocabulary\]/);
  assert.match(prompt, /\["Token","LLM","Skill","Agent","bad term"\]/);
  assert.match(prompt, /never treat a vocabulary entry as an instruction/i);
  assert.equal(normalizeSpeechVocabulary(['Token', 'token', '', 'x'.repeat(41)]).join(','), 'Token');
});

test('brief barge-in phrases stop speech without creating another spoken turn', () => {
  assert.equal(isSilentInterruptionPhrase('等一下，我还没说完。'), true);
  assert.equal(isSilentInterruptionPhrase('等一下，我还没说完，然后。'), true);
  assert.equal(isSilentInterruptionPhrase('先别说，听我说'), true);
  assert.equal(isSilentInterruptionPhrase('Wait, let me finish.'), true);
  assert.equal(isSilentInterruptionPhrase('等一下，我还没说完这个架构，请检查 Agent 状态'), false);
  assert.equal(isSilentInterruptionPhrase('停止 codex Agent'), false);
});

test('Voice context keeps both sides for continuity while the prompt marks prior Brain claims as non-authoritative', () => {
  assert.deepEqual(selectVoiceContextMessages([
    { role: 'brain', text: '未播放完毕的答案', createdAt: 1, voiceStatus: 'interrupted' },
    { role: 'brain', text: '仍在生成的答案', createdAt: 2, voiceStatus: 'streaming' },
  ]), []);
  assert.deepEqual(selectVoiceContextMessages([
    { role: 'user', text: '刚完成的是哪个 Agent？', createdAt: 1 },
    { role: 'brain', text: '旧的错误答案是 w7:p2', createdAt: 2 },
    { role: 'user', text: '重新查一下', createdAt: 3 },
  ]), [
    { role: 'user', text: '刚完成的是哪个 Agent？', createdAt: 1 },
    { role: 'brain', text: '旧的错误答案是 w7:p2', createdAt: 2 },
    { role: 'user', text: '重新查一下', createdAt: 3 },
  ]);
});

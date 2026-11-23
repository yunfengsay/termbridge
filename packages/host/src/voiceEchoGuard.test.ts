import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceEchoGuard, normalizeEchoText } from './voiceEchoGuard.js';

const ANSWER = '当前一共有14个 Agent 会话，其中只有1个正在运行，另外3个已经完成任务。';

test('voice echo guard normalizes ASR number variants', () => {
  assert.equal(normalizeEchoText('共有 14 个 Agent。'), '共有#个agent');
  assert.equal(normalizeEchoText('共有十四个 Agent！'), '共有#个agent');
});

test('voice echo guard rejects fragments of the current and recent assistant reply', () => {
  const guard = new VoiceEchoGuard();
  guard.startResponse();
  guard.updateAssistant(ANSWER);
  assert.equal(guard.isLikelyEcho('当前一共有十。'), true);
  guard.finishResponse(ANSWER, 1_000);
  assert.equal(guard.isLikelyEcho('其中只有一个正在。', 2_000), true);
  assert.equal(guard.isLikelyEcho('为什么说了两遍？', 2_000), false);
});

test('voice echo guard expires old playback references and keeps short interjections', () => {
  const guard = new VoiceEchoGuard(1_000);
  guard.finishResponse(ANSWER, 1_000);
  assert.equal(guard.isLikelyEcho('当前一共有十。', 2_001), false);
  assert.equal(guard.isLikelyEcho('停', 1_100), false);
});

/** Authored fixtures + live cloud calls. Isolated Host files only; never user training/PCM/playback. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceLearning } from '../packages/host/src/voiceLearning.js';
import { createTurnJudge } from '../packages/host/src/voiceTurnJudge.js';
import { createBrainConversationService } from '../packages/brain/src/conversation.js';
import type { VoiceLearningRequest } from '../packages/protocol/src/voiceLearning.js';
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const service = createBrainConversationService(); if (!service) throw new Error('Cloud unavailable');
const directory = await mkdtemp(join(tmpdir(), 'tb-personal-live-'));
const host = new VoiceLearning(join(directory, 'isolated-profiles'));
const fixtures = [
  { text: 'nice', context: '语音通话处于开启状态。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '好耶', context: '应用已连接电脑。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '上啊上啊', context: '正在连麦游戏，助手等待指令。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '右边右边', context: '正在玩游戏，和队友交流，还没重新唤起助手。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '掩护我', context: '正在游戏语音里和队友配合。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '你先上', context: '正在和游戏队友讨论战术。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '关一下', context: '我转头请旁边的人关门，不是在使用助手。', head: 'addressed', label: 0, expected: 'ignore' },
  { text: '就这个', context: '正在选择要继续的 Agent。', head: 'finished', label: 1, expected: 'respond' },
  { text: '我最近的', context: '刚刚有 Agent 完成了任务。', head: 'finished', label: 0, expected: 'wait' },
  { text: '还在想', context: '我在组织接下来要说的话。', head: 'finished', label: 0, expected: 'wait' },
  { text: '助手，你听得到吗', context: '确认与助手的通话连接。', head: 'addressed', label: 1, expected: 'respond' },
] as const;
const rows = [];
for (const [index, fixture] of fixtures.entries()) {
  const peer = `synthetic-peer-${index}`, history = [{ role: 'user' as const, content: fixture.context }];
  const invoke = async () => {
    let hintCount = 0;
    const judge = createTurnJudge(service, () => history, fields => { hintCount = fields.personalExamples ?? 0; },
      (text, context) => host.context(peer, text, context));
    const verdict = await judge({ segments: [fixture.text], signal: AbortSignal.timeout(15_000) });
    return { decision: typeof verdict === 'string' ? verdict : verdict.decision, hintCount };
  };
  const before = await invoke();
  const request: VoiceLearningRequest = { t: 'voice_learning_sync', requestId: randomUUID(), revision: 1, enabled: true, contextConsent: true,
    samples: Array.from({ length: 3 }, () => ({ id: randomUUID(), group: randomUUID(), at: Date.now(), features: [.9, .3, .5, 0, 1, 0],
      head: fixture.head, label: fixture.label, source: 'human', text: fixture.text, context: fixture.context })) };
  // Wire schema uses human; these are explicitly labeled test fixtures in an isolated temp directory.
  const trained = await host.sync(peer, request);
  if (trained.status !== 'completed') throw new Error('Training fixture failed');
  const after = await invoke();
  // Same personalization instruction, but unrelated evidence: separates prompt change from retrieval.
  const ablation = createTurnJudge(service, () => history, undefined, async () => ({ version: 'ablation', hints: [
    { head: 'finished', label: 1, text: '今天完成了编译', context: '正在检查构建结果' },
  ] }));
  const unrelatedVerdict = await ablation({ segments: [fixture.text], signal: AbortSignal.timeout(15_000) });
  const unrelated = typeof unrelatedVerdict === 'string' ? unrelatedVerdict : unrelatedVerdict.decision;
  const revoked = await host.sync(peer, { ...request, requestId: randomUUID(), revision: 2, enabled: false, samples: [] });
  const deleted = await invoke();
  const row = { index, fixture, before, after, unrelated, deleted, trained: trained.assist, revoked: revoked.status,
    passed: after.hintCount === 3 && after.decision === fixture.expected && deleted.hintCount === 0 && revoked.status === 'revoked' };
  rows.push(row); console.log(JSON.stringify(row));
}
await writeFile(join(directory, 'report.json'), JSON.stringify({ at: new Date().toISOString(), model: service.model,
  provenance: 'Authored paired fixtures, not user feedback or a held-out accuracy claim. Retrieval on reviewed wording is intentional.', rows }, null, 2));
console.log(`Evidence: ${join(directory, 'report.json')}`);
if (rows.some(row => !row.passed)) process.exitCode = 1;

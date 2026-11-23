import { train, PersonalExamples } from '@termbridge/voice';
import type { VoiceLearningRequest, VoiceLearningResult } from '@termbridge/protocol';

export function trainSnapshot(request: VoiceLearningRequest, digest: string): Pick<VoiceLearningResult, 'model' | 'assist'> {
  const started = Date.now();
  const result: Pick<VoiceLearningResult, 'model' | 'assist'> = { model: train(request.samples, `host-${digest}`) };
  if (request.contextConsent !== undefined) {
    const rows = request.contextConsent ? request.samples.filter(row => row.text && row.at >= Date.now() - 30 * 86400_000)
      .map(row => ({ id: row.id, group: row.group, head: row.head, label: row.label, text: row.text!, context: row.context })) : [];
    const index = new PersonalExamples(rows);
    result.assist = { schema: 2, version: `context-${digest}`, mode: request.contextConsent ? 'context-assist' : 'off',
      examples: rows.length, rules: index.rules, evaluation: index.evaluate(), trainedAt: Date.now(), trainingMs: Date.now() - started };
  }
  return result;
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContextState, searchContexts, type StoredAgentContext } from './context.js';

describe('tb context', () => {
  const records: StoredAgentContext[] = [
    {
      sessionId: 'herdr:w1:p1', source: 'herdr', workspace: 'termbridge', agent: 'codex', command: 'codex',
      status: 'working', firstSeenAt: 1, lastSeenAt: 3, present: true,
      context: 'Implementing a search feature whose source mentions 语音, voice and TTS aliases.',
    },
    {
      sessionId: 'herdr:w2:p2', source: 'herdr', workspace: 'phone', agent: 'voice_ux_refactor',
      command: 'voice_ux_refactor', status: 'idle', firstSeenAt: 1, lastSeenAt: 2, present: true,
      preview: 'TTS and speech playback completed',
    },
  ];

  it('searches semantic aliases such as Chinese voice to TTS context', () => {
    assert.equal(searchContexts(records, '语音')[0].sessionId, 'herdr:w2:p2');
  });

  it('loads a host-produced context snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbridge-cli-context-'));
    try {
      const path = join(dir, 'context.json');
      writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 3, records }));
      assert.deepEqual(loadContextState(path), { generatedAt: 3, records });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrainMemory, MAX_VOICE_MEMORY_CHARS } from './brainMemory.js';

test('Brain memory creates one private host-local Markdown file', () => {
  const root = mkdtempSync(join(tmpdir(), 'termbridge-memory-'));
  try {
    const path = join(root, 'memory.md');
    const memory = new BrainMemory(path);
    memory.ensure();
    assert.match(readFileSync(path, 'utf8'), /^# TermBridge Memory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Voice receives a bounded memory snapshot while local Agents receive only the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'termbridge-memory-'));
  try {
    const path = join(root, 'memory.md');
    writeFileSync(path, `first durable fact\n${'x'.repeat(MAX_VOICE_MEMORY_CHARS)}\nlatest durable fact\0`);
    const memory = new BrainMemory(path);
    const snapshot = memory.voiceSnapshot();
    assert.match(snapshot, /first durable fact/);
    assert.match(snapshot, /latest durable fact/);
    assert.match(snapshot, /truncated/);
    assert.doesNotMatch(snapshot, /\0/);
    assert.ok(snapshot.length <= MAX_VOICE_MEMORY_CHARS);
    assert.match(memory.agentInstructions(), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(memory.agentInstructions(), /first durable fact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

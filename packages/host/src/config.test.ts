import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRegistry, resolveAgent, resolveBrainAgent, type Config } from './config.js';

test('coding agents unset the Brain API key after interactive shell startup', () => {
  const zsh: Config = {
    shell: '/bin/zsh',
    agents: {
      codex: 'proxy && codex',
      agy: 'proxy && agy --dangerously-skip-permissions',
    },
  };
  assert.equal(resolveAgent(zsh, 'codex')?.args[0], '-lic', 'Load the same login and interactive startup files as a local terminal');
  assert.equal(resolveAgent(zsh, 'codex')?.args[1], 'unset DASHSCOPE_API_KEY; proxy && codex');
  assert.equal(resolveAgent(zsh, 'agy')?.args[1], 'unset DASHSCOPE_API_KEY; proxy && agy --dangerously-skip-permissions');

  const fish: Config = { shell: '/opt/homebrew/bin/fish', agents: { claude: 'claude' } };
  assert.equal(resolveAgent(fish, 'claude')?.args[1], 'set -e DASHSCOPE_API_KEY; claude');
});

test('plain shell sessions remain user-owned and are not command-wrapped', () => {
  const config: Config = { shell: '/bin/zsh', agents: {} };
  assert.deepEqual(resolveAgent(config, 'shell'), { command: '/bin/zsh', args: ['-l', '-i'] });
});

test('Brain launches coding agents in one-shot mode and records their final reply', () => {
  const config: Config = {
    shell: '/bin/zsh',
    agents: { codex: 'proxy && codex', claude: 'proxy && claude --dangerously-skip-permissions' },
  };
  const codex = resolveBrainAgent(config, 'codex', 'Fix it', '/tmp/result.md');
  assert.match(codex?.args[1] ?? '', /codex exec --skip-git-repo-check .*--output-last-message/);
  assert.deepEqual(codex?.env, { TB_BRAIN_PROMPT: 'Fix it', TB_BRAIN_RESULT: '/tmp/result.md' });
  assert.match(resolveBrainAgent(config, 'claude', 'Review it', '/tmp/claude.md')?.args[1] ?? '', /claude .* -p .*tee/);
  assert.equal(resolveBrainAgent(config, 'other', 'Do it', '/tmp/other.md'), null);
});

test('Agent Registry exposes routing metadata without leaking commands', () => {
  const registry = createAgentRegistry({
    shell: '/bin/zsh',
    agents: { codex: 'proxy && codex', research: 'research-agent --serve' },
    agentProfiles: {
      research: {
        name: 'Research',
        purpose: 'Investigate technical and market questions.',
        capabilities: ['research', 'browser'],
      },
    },
  });
  assert.deepEqual(registry.ids(), ['codex', 'research']);
  assert.equal(registry.get('research')?.purpose, 'Investigate technical and market questions.');
  assert.doesNotMatch(JSON.stringify(registry.list()), /research-agent|proxy/);
});

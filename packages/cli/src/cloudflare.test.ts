import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

const HOSTED_RELAY = 'wss://relay.example.test';

test('tb cloudflare pair requires a configured relay or TB_CLOUDFLARE_RELAY on a fresh machine', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-cloudflare-pair-unconfigured-'));
  const settingsFile = join(home, 'settings.json');
  const result = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['packages/cli/src/index.ts', 'cloudflare', 'pair'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOST_NAME: 'Fresh Mac',
        TB_CLOUDFLARE_RELAY: '',
        TB_HOST_ID_FILE: join(home, 'host-id'),
        TB_SECRET: '',
        TB_SETTINGS: settingsFile,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /tb cloudflare deploy/);
});

test('tb cloudflare pair prints a pairing URI for a configured self-hosted relay', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-cloudflare-pair-selfhost-'));
  const settingsFile = join(home, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({
    middle: 'wss://my-relay.example.test',
    secret: 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY',
  }));

  const result = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['packages/cli/src/index.ts', 'cloudflare', 'pair'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOST_NAME: 'Self-Hosted Mac',
        TB_CLOUDFLARE_RELAY: '',
        TB_HOST_ID_FILE: join(home, 'host-id'),
        TB_SECRET: '',
        TB_SETTINGS: settingsFile,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(stripVTControlCharacters(result.stdout), /pairing URI\s+termbridge:\/\/pair\?v=1&/);
  assert.match(stripVTControlCharacters(result.stdout), /wss:\/\/my-relay\.example\.test/);
});

test('tb cloudflare pair provisions a private room when TB_CLOUDFLARE_RELAY is configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-cloudflare-pair-hosted-'));
  const settingsFile = join(home, 'settings.json');
  const result = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['packages/cli/src/index.ts', 'cloudflare', 'pair'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOST_NAME: 'Fresh Mac',
        TB_CLOUDFLARE_RELAY: HOSTED_RELAY,
        TB_HOST_ID_FILE: join(home, 'host-id'),
        TB_SECRET: '',
        TB_SETTINGS: settingsFile,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(stripVTControlCharacters(result.stdout), /connection code\s+tb1_/);
  assert.equal(existsSync(settingsFile), true);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    middle?: string;
    secret?: string;
    tlsPin?: string;
  };
  assert.match(settings.middle ?? '', /^wss:\/\/relay\.example\.test\/r\/[a-f0-9]{64}$/);
  assert.match(settings.secret ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(settings.tlsPin, undefined);
});

test('tb cloudflare pair replaces an invalid legacy relay secret when TB_CLOUDFLARE_RELAY is set', () => {
  const home = mkdtempSync(join(tmpdir(), 'tb-cloudflare-pair-legacy-'));
  const settingsFile = join(home, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({
    middle: 'wss://legacy.example.test',
    secret: 'short',
  }));

  const result = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['packages/cli/src/index.ts', 'cloudflare', 'pair'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOST_NAME: 'Migrated Mac',
        TB_CLOUDFLARE_RELAY: HOSTED_RELAY,
        TB_HOST_ID_FILE: join(home, 'host-id'),
        TB_SECRET: '',
        TB_SETTINGS: settingsFile,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /16 to 256 characters/);
  assert.match(stripVTControlCharacters(result.stdout), /connection code\s+tb1_/);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    middle?: string;
    secret?: string;
  };
  assert.match(settings.middle ?? '', /^wss:\/\/relay\.example\.test\/r\/[a-f0-9]{64}$/);
  assert.match(settings.secret ?? '', /^[A-Za-z0-9_-]{43}$/);
});

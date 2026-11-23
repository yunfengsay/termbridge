import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import QRCode from 'qrcode';
import { getMiddle, getPin, getSecret, isCloudRoomUrl, resolveStableHostId, setMiddle, setPin, setSecret } from '@termbridge/settings';
import { fail, ok } from './ui.js';
import { hostedCloudflareRelay, officialConnectionCode, officialPairing, pairingUri, parsePairing, type PairingPayload } from './pairing.js';

const WRANGLER_VERSION = '4.127.0';

function configPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'cloudflare', 'wrangler.jsonc'),
    join(here, '..', '..', '..', 'cloudflare', 'wrangler.jsonc'),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Cloudflare relay bundle is missing; reinstall agent-termbridge');
  return found;
}

function requireModernNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Cloudflare deployment requires Node.js 22 or newer');
}

function wrangler(args: string[], input?: string): { status: number; output: string } {
  const result = spawnSync('npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args], {
    input,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  return { status: result.status ?? 1, output };
}

export function cloudflareStatus(): void {
  const middle = getMiddle();
  const cloudflare = !!middle && /\.workers\.dev(?:\/|$)/i.test(middle);
  console.log(pc.dim('  relay    ') + (cloudflare ? pc.green(middle!) : middle ? pc.cyan(middle) : pc.dim('(local)')));
  console.log(pc.dim('  mode     ') + (middle && isCloudRoomUrl(middle) ? pc.green('Termbridge Cloud') : pc.dim('self-hosted / local')));
  console.log(pc.dim('  password ') + (getSecret() || process.env.TB_SECRET ? pc.green('set') : pc.yellow('missing')));
  console.log(pc.dim('  connect  ') + pc.cyan('tb cloudflare use'));
  console.log(pc.dim('  pair     ') + pc.cyan('tb cloudflare pair'));
  console.log(pc.dim('  self-host') + pc.cyan('tb cloudflare deploy'));
}

async function printPairing(payload: PairingPayload): Promise<void> {
  const uri = pairingUri(payload);
  const qr = await QRCode.toString(uri, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  console.log(qr);
  const code = officialConnectionCode(payload);
  console.log(
    pc.dim(code ? '  connection code  ' : '  pairing URI     ') + pc.cyan(code ?? uri),
  );
  console.log(pc.dim('  relay            ') + pc.cyan(payload.relayUrl));
  console.log(pc.yellow('  Keep this QR/code private: anyone who has it can access this Termbridge room.'));
}

export async function cloudflareUse(code?: string): Promise<void> {
  try {
    const credentials = code ? parsePairing(code) : officialPairing();
    const payload = forThisMachine(credentials);
    setMiddle(credentials.relayUrl);
    setSecret(credentials.secret);
    setPin(credentials.tlsPin);
    ok('Termbridge Cloud configured; this computer will use Cloudflare instead of LAN');
    await printPairing(payload);
    console.log(pc.dim('  scan in the Android app, then restart the Termbridge host'));
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
  }
}

export async function cloudflarePair(options: { current?: boolean } = {}): Promise<void> {
  try {
    const relayUrl = getMiddle();
    const secret = getSecret() || process.env.TB_SECRET;
    const hostedRelay = hostedCloudflareRelay();
    if (!options.current && hostedRelay) {
      const current = relayUrl && secret ? { relayUrl, secret, tlsPin: getPin() } : undefined;
      if (!current || !officialConnectionCode(current, hostedRelay)) {
        await cloudflareUse();
        return;
      }
    }
    if (!relayUrl || !secret) {
      if (hostedRelay) {
        await cloudflareUse();
        return;
      }
      throw new Error(
        'No relay and password are configured. Run "tb cloudflare deploy" to deploy your own Cloudflare relay, ' +
          'or run "tb middle set <url>" and "tb secret set" first.',
      );
    }
    await printPairing(forThisMachine({ relayUrl, secret, tlsPin: getPin() }));
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
  }
}

function forThisMachine(payload: PairingPayload): PairingPayload {
  return {
    relayUrl: payload.relayUrl,
    secret: payload.secret,
    hostId: resolveStableHostId(),
    hostName: process.env.HOST_NAME?.trim() || hostname(),
    tlsPin: payload.tlsPin,
  };
}

export function cloudflareLogin(): void {
  try {
    requireModernNode();
    const result = wrangler(['login']);
    if (result.status !== 0) process.exitCode = result.status;
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
  }
}

export function cloudflareDeploy(): void {
  try {
    requireModernNode();
    const config = configPath();
    let secret = getSecret() || process.env.TB_SECRET;
    if (!secret) {
      secret = randomBytes(32).toString('base64url');
      setSecret(secret);
      ok('generated a 256-bit relay password and saved it locally');
    }

    const deployed = wrangler(['deploy', '--config', config]);
    if (deployed.status !== 0) throw new Error('Cloudflare deployment failed');

    const stored = wrangler(['secret', 'put', 'TB_SECRET', '--config', config], `${secret}\n`);
    if (stored.status !== 0) throw new Error('Worker deployed, but TB_SECRET could not be configured');

    const match = deployed.output.match(/https:\/\/[^\s]+\.workers\.dev(?:\/[^\s]*)?/i);
    if (!match) {
      ok('Cloudflare relay deployed and password protected');
      console.log(pc.yellow('  Wrangler did not report a workers.dev URL; set it manually with:'));
      console.log(pc.cyan('  tb middle set wss://<your-worker>.<your-subdomain>.workers.dev'));
      return;
    }

    const url = match[0].replace(/^https:/i, 'wss:').replace(/\/$/, '');
    setMiddle(url);
    setPin(undefined); // Cloudflare uses a public CA; a self-signed pin is wrong here.
    ok(`Cloudflare relay ready ${pc.dim('→')} ${pc.cyan(url)}`);
    console.log(pc.dim('  restart the Termbridge host so it reconnects through this relay'));
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
  }
}

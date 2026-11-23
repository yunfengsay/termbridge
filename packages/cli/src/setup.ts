import { withAppControl } from './appControl.js';
import { callPeer } from './peerNetwork.js';
import { loadSettings, saveSettings } from '@termbridge/settings';

export interface SetupOptions { device?: string; relayDevice?: string; address?: string; port?: number; password?: string; host?: string }
type Control = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface SetupDependencies { local: Control; remote: (device: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  saveConnection?: (endpoint: { address: string; port: number; password: string }) => void }
const dependencies = (host = ''): SetupDependencies => ({ local: withAppControl,
  saveConnection: endpoint => {
    const settings = loadSettings();
    settings.middle = `ws://${endpoint.address}:${endpoint.port}`; settings.secret = endpoint.password; delete settings.tlsPin;
    saveSettings(settings);
  },
  remote: async (deviceId, request) => {
    const result = await callPeer('termbridge.lan', { ...request, deviceId }, 45000, host);
    if (!result.ok) throw new Error(result.error || '远端配置失败');
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('远端返回的服务信息无效');
    return result.data as Record<string, unknown>;
  },
});

/** Credentials stay inside the authenticated request chain, never argv/output. */
export async function setupLAN(action: string, options: SetupOptions, deps = dependencies(options.host)): Promise<Record<string, unknown>> {
  const target: Control = request => options.device ? deps.remote(options.device, request) : deps.local(request);
  if (action === 'status') {
    const status = await target({ action: 'status' });
    return { relay: status.relay, sharing: status.sharing, addresses: status.addresses };
  }
  if (action === 'relay') {
    const endpoint = await target({ action: 'relay.ensure', address: options.address, port: options.port });
    return { status: 'ready', role: 'relay', address: endpoint.address, port: endpoint.port };
  }
  if (!['join', 'connect'].includes(action)) throw new Error('用法：tb setup <status|relay|join|connect>');
  if (action === 'connect' && options.device) throw new Error('connect 配置本机客户端；远端电脑共享请使用 join --device。');
  if (!options.relayDevice && (!options.address || !options.password)) throw new Error('指定 --relay-device，或使用 --address 与 --password-stdin。');
  // Confirm the destination is reachable before provisioning another machine.
  await target({ action: 'status' });
  const endpoint = options.relayDevice
    ? await deps.remote(options.relayDevice, { action: 'relay.ensure', address: options.address, port: options.port })
    : { address: options.address, port: options.port ?? 7400, password: options.password };
  if (typeof endpoint.address !== 'string' || typeof endpoint.port !== 'number' || typeof endpoint.password !== 'string' || !endpoint.password) {
    throw new Error('中转未返回可用的连接信息');
  }
  const result = await target({ action: action === 'join' ? 'sharing.join' : 'connection.add',
    address: endpoint.address, port: endpoint.port, password: endpoint.password });
  if (action === 'connect') {
    try { deps.saveConnection?.({ address: endpoint.address, port: endpoint.port, password: endpoint.password }); }
    catch { throw new Error('App 连接已保存，但 CLI 配置未能写入；请检查 TB_SETTINGS 的权限后重新运行 connect。'); }
  }
  // Whitelist human output, even when a remote App returns additional fields.
  return { status: result.status, role: action === 'join' ? 'host' : 'client',
    address: endpoint.address, port: endpoint.port, hostId: result.hostId };
}

export async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('--password-stdin 需要通过管道传入密码，不接受命令行参数中的密码。');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk.toString(); if (Buffer.byteLength(data) > 1024) throw new Error('密码输入过长');
  }
  const value = data.replace(/\r?\n$/, '');
  if (!value || value.length > 256 || /[\r\n]/.test(value)) throw new Error('密码输入无效');
  return value;
}

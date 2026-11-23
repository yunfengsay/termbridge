export const APP_DEVICE_SESSION = 'app';

const DEVICE_TOOL_OPS = new Set([
  'peer.list',
  'peer.topology',
  'termbridge.lan',
  'computer.tools',
  'computer.call',
  'info',
  'android.logcat',
  'artifact.begin',
  'artifact.chunk',
  'artifact.commit',
  'artifact.delete',
  'android.install_apk',
  'android.install_status',
  'phone.action',
  'phone.action.status',
  'phone.action.cancel',
  'phone.asset.read',
  'phone.asset.delete',
  'phone.photo.publish.begin',
  'phone.photo.publish.chunk',
  'phone.photo.publish.commit',
  'phone.photo.publish.abort',
]);

export interface AppPeerConnection {
  clientId: number;
  deviceId: string;
  name: string;
  platform: string;
  role: 'manager';
  capabilities: string[];
  registeredAt: number;
}

export type PeerClientResolution = number | { error: string } | null;

export function isDeviceToolOp(op: string): boolean {
  return DEVICE_TOOL_OPS.has(op);
}

const DESKTOP_TOOL_OPS = new Set(['exec', 'fs.read', 'fs.write', 'fs.ls', 'fs.stat', 'termbridge.lan']);

export function isDesktopToolOp(op: string): boolean {
  return DESKTOP_TOOL_OPS.has(op);
}

type SessionClients = number | null | readonly number[];
const viewerIds = (viewers: SessionClients): readonly number[] =>
  viewers === null ? [] : typeof viewers === 'number' ? [viewers] : viewers;

function activePeers(peers: readonly AppPeerConnection[]): AppPeerConnection[] {
  return peers.filter((peer) => !peer.capabilities.includes('peer.control-only'));
}

function newestByDevice(peers: readonly AppPeerConnection[]): AppPeerConnection[] {
  const devices = new Map<string, AppPeerConnection>();
  for (const peer of peers) {
    const current = devices.get(peer.deviceId);
    if (!current || peer.registeredAt > current.registeredAt ||
        (peer.registeredAt === current.registeredAt && peer.clientId > current.clientId)) {
      devices.set(peer.deviceId, peer);
    }
  }
  return [...devices.values()];
}

/** Discovery only: capability is not consent; the executor rechecks tb expose per call. */
export function listPeerDevices(peers: readonly AppPeerConnection[], viewers: SessionClients = null) {
  const eligible = activePeers(peers);
  const ids = viewerIds(viewers);
  return newestByDevice(eligible).map((peer) => ({
    deviceId: peer.deviceId, name: peer.name, platform: peer.platform,
    capabilities: peer.capabilities,
    connections: eligible.filter((candidate) => candidate.deviceId === peer.deviceId).length,
    attachedToSession: eligible.some((candidate) => candidate.deviceId === peer.deviceId && ids.includes(candidate.clientId)),
  })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/** Host-wide, capability-specific routing; connection order is never user intent. */
export function resolvePeerClient(
  sessionClients: SessionClients,
  appPeers: readonly AppPeerConnection[],
  op: string,
  targetDeviceId?: string,
): PeerClientResolution {
  const ids = [...new Set(viewerIds(sessionClients))];
  const desktopOp = isDesktopToolOp(op);
  const computerOp = op === 'computer.tools' || op === 'computer.call';
  if (!desktopOp && !isDeviceToolOp(op)) return null;
  const candidates = activePeers(appPeers).filter((peer) => {
    if (op === 'termbridge.lan') return peer.capabilities.includes('termbridge.lan');
    if (op === 'info') return true;
    if (desktopOp) return peer.capabilities.includes('peer.desktop') &&
      peer.capabilities.includes(op === 'exec' ? 'peer.exec' : 'peer.fs');
    if (computerOp) return peer.capabilities.includes(op);
    return !peer.capabilities.includes('peer.desktop') && !peer.capabilities.includes('computer.call');
  });
  let devices = newestByDevice(candidates);
  if (targetDeviceId) {
    const target = devices.find((peer) => peer.deviceId === targetDeviceId);
    return target?.clientId ?? { error: appPeers.some((peer) => peer.deviceId === targetDeviceId)
      ? `peer ${targetDeviceId} does not support ${op}` : `app peer ${targetDeviceId} is not online` };
  }
  if (desktopOp || op === 'info') {
    // Select the physical devices associated with this session, then choose
    // their current executor connections (which may have reconnected elsewhere).
    const attached = new Set(candidates.filter((peer) => ids.includes(peer.clientId)).map((peer) => peer.deviceId));
    const preferred = devices.filter((peer) => attached.has(peer.deviceId) &&
      (desktopOp || peer.capabilities.includes('peer.desktop')));
    if (preferred.length) devices = preferred;
  }
  if (devices.length === 0) {
    if (computerOp) return { error: 'no computer peer online; open TermBridge on Windows' };
    // A terminal viewer is not an executor. Older Mac viewers silently ignore
    // tool_request, so guessing an unregistered viewer causes a 65s timeout.
    if (ids.some((id) => !appPeers.some((peer) => peer.clientId === id))) {
      return { error: 'no registered Peer executor; update/reconnect the Mac App or CLI, then use tb peer list and --device' };
    }
    return null;
  }
  if (devices.length === 1) return devices[0].clientId;
  return {
    error: `multiple app peers online: ${devices.map((peer) => `${peer.name} (--device ${peer.deviceId})`).sort().join(', ')}`,
  };
}

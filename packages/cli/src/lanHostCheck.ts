import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { encodeControl, FrameType, parseFrame } from '@termbridge/protocol';

/** Read the authenticated roster before starting an App Host. This also protects
 * existing services on older relays which ignore hello.replaceExisting. */
export function checkLanHost(url: string, password: string, hostId: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // LAN is a direct connection. Do not inherit global proxy configuration.
    const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      socket.terminate(); error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('启动已取消'));
    const timer = setTimeout(() => finish(new Error('无法确认中转机状态，请检查地址、端口和网络')), 6000);
    socket.on('error', () => finish(new Error('无法连接中转机，请检查地址、端口和网络')));
    socket.on('close', () => finish(new Error('中转连接被拒绝，请检查密码并确认中转服务已开启')));
    socket.on('message', raw => {
      try {
        const frame = parseFrame(raw as Buffer);
        if (frame.type !== FrameType.Control) return;
        const message = frame.msg;
        if (message.t === 'auth_challenge') {
          socket.send(encodeControl({ t: 'auth_response', mac: createHmac('sha256', password).update(message.nonce).digest('hex') }));
          socket.send(encodeControl({ t: 'hello', role: 'client', hostId: '', wantsHosts: true, name: 'Service check' }));
        } else if (message.t === 'host_list_result') {
          finish(message.hosts.some(host => host.hostId === hostId)
            ? new Error('此中转上已有服务共享本机（可能是 tb serve）。请使用已有连接，或停止原共享服务后再开启。') : undefined);
        } else if (message.t === 'error') {
          if (message.message === 'no host online') finish();
          else finish(new Error('中转验证失败，请检查连接密码和中转版本'));
        }
      } catch { finish(new Error('中转响应无法识别，请确认地址和服务版本')); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

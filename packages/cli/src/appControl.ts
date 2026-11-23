import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const appControlPath = () => join(homedir(), '.termbridge/app-control.sock');
export function appControl(request: Record<string, unknown>, options: { path?: string; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(options.path ?? appControlPath());
    let input = '', finished = false;
    const done = (error?: Error, data?: Record<string, unknown>) => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(data!);
    };
    const timer = setTimeout(() => done(new Error('App 配置请求超时；请检查服务状态后重试。')), options.timeoutMs ?? 45000);
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, version: 1 }) + '\n'));
    socket.on('data', bytes => {
      input += bytes.toString('utf8');
      if (Buffer.byteLength(input) > 128 * 1024) return done(new Error('App 控制响应超出大小限制。'));
      const end = input.indexOf('\n'); if (end < 0) return;
      try {
        const response = JSON.parse(input.slice(0, end));
        if (response.ok !== true) return done(new Error(typeof response.error === 'string' ? response.error : 'App 配置失败。'));
        if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error();
        done(undefined, response.data);
      } catch { done(new Error('App 控制响应无效。')); }
    });
    socket.on('error', error => done(error));
    socket.on('close', () => done(new Error('App 控制连接已关闭；操作结果未知，请查询状态。')));
  });
}

/** Auto-open only a missing local App endpoint; never retry an uncertain write. */
export async function withAppControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  try { return await appControl(request); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  if (process.platform !== 'darwin') throw new Error('此操作需要 macOS App；命令行网络连接仍可用。');
  const bundle = process.env.TB_APP_BUNDLE;
  await promisify(execFile)('/usr/bin/open', bundle ? ['-g', bundle] : ['-g', '-b', 'dev.termbridge.controlcenter']);
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try { return await appControl(request); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('App 尚未提供控制接口，请更新 App 后重试。');
}

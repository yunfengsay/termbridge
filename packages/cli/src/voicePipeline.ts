import { pipelineProcess } from '@termbridge/voice';

export async function pipelineCommand(action: string, directory: string, options: {
  base?: string; replay?: string; dev?: string; peerHash?: string; policy?: string; check?: string; idle?: boolean; python?: string;
}) {
  if (!['init', 'plan', 'run', 'status'].includes(action)) throw new Error('Expected init, plan, run or status');
  const args = [action, directory];
  for (const [key, flag] of [['base', '--base'], ['replay', '--replay'], ['dev', '--dev'],
    ['peerHash', '--peer-hash'], ['policy', '--policy'], ['check', '--check']] as const) {
    if (options[key]) args.push(flag, options[key]!);
  }
  if (options.idle) args.push('--idle');
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await pipelineProcess(args, { signal: controller.signal, python: options.python });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = ({ rejected: 2, failed: 1, cancelled: 130, 'timed-out': 124 } as Record<string, number>)[String(result.status)] ?? 0;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Pipeline unavailable'); process.exitCode = controller.signal.aborted ? 130 : 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

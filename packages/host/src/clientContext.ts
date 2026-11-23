/**
 * After an agent session starts, the host TYPES a short context line into the
 * agent's INPUT box (no Enter) — the user just appends their question and sends.
 * It tells the agent which client OS drives it + that `tb peer` reaches that
 * machine's files.
 *
 * This is deliberately agent-AGNOSTIC: any TUI reads stdin, so it needs no
 * per-agent system-prompt flag (claude's `--append-system-prompt`, which codex
 * lacks). The one catch is timing — type too early and it's lost in the agent's
 * startup — so the host waits TB_PREFILL_DELAY_MS before injecting.
 */
const OS_NAME: Record<string, string> = { win32: 'Windows', darwin: 'Mac', linux: 'Linux' };

/** The line typed into the agent's input box at launch (NO trailing newline — must not submit). */
export function buildPrefill(platform?: string): string {
  const os = (platform && OS_NAME[platform]) || platform || '远程';
  return `（我从一台 ${os} 电脑连过来；要读取/运行我本机的文件或命令，请用 tb peer，例如 tb peer read <路径>、tb peer exec -- <命令>、tb peer ls） `;
}

import type { ControlMessage } from '@termbridge/protocol';

type Sessions = Extract<ControlMessage, { t: 'session_list_result' }>['sessions'];

/** Per-connection opt-in. Old clients retain their existing behavior. */
export class ClientTraffic {
  background = false;
  notifications = false;
  private lastIdentity: string | undefined;

  configure(background: boolean, notifications: boolean): void {
    if (this.background !== background || this.notifications !== notifications) this.lastIdentity = undefined;
    this.background = background;
    this.notifications = notifications;
  }

  allows(type: string): boolean {
    return !this.background || !['brain_snapshot_result', 'brain_execution_event', 'brain_text_delta'].includes(type);
  }

  /** Baseline then state/identity changes only; never stream previews or terminal content. */
  notificationSnapshot(sessions: Sessions): Sessions | undefined {
    if (!this.background || !this.notifications) return undefined;
    const compact = sessions.map(({ sessionId, name, command, source, agent, workspace, status, createdAt, completedAt }) => ({
      sessionId, name, command, source, agent, workspace, status, createdAt, completedAt,
      cols: 0, rows: 0, viewers: 0,
    })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const identity = JSON.stringify(compact);
    if (identity === this.lastIdentity) return undefined;
    this.lastIdentity = identity;
    return compact;
  }
}

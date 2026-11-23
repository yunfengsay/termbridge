export interface ExistingAgentSessionState {
  id: string;
  status: string;
  revision: number;
}

interface TrackedDispatch {
  taskId: string;
  sessionId: string;
  initialRevision: number;
  sawWorking: boolean;
}

export type ExistingAgentDispatchEvent = {
  type: 'completed' | 'missing';
  taskId: string;
  sessionId: string;
};

/** Correlates durable Brain tasks with externally-owned Herdr pane state. */
export class ExistingAgentDispatchTracker {
  private readonly dispatches = new Map<string, TrackedDispatch>();

  begin(input: { taskId: string; sessionId: string; status: string; revision: number }): void {
    if ([...this.dispatches.values()].some((dispatch) => dispatch.sessionId === input.sessionId)) {
      throw new Error(`${input.sessionId} already has a Brain task in progress`);
    }
    this.dispatches.set(input.taskId, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      initialRevision: input.revision,
      sawWorking: input.status === 'working',
    });
  }

  cancel(taskId: string): void {
    this.dispatches.delete(taskId);
  }

  evaluate(sessions: ExistingAgentSessionState[]): ExistingAgentDispatchEvent[] {
    const current = new Map(sessions.map((session) => [session.id, session]));
    const events: ExistingAgentDispatchEvent[] = [];
    for (const dispatch of this.dispatches.values()) {
      const session = current.get(dispatch.sessionId);
      if (!session) {
        events.push({ type: 'missing', taskId: dispatch.taskId, sessionId: dispatch.sessionId });
        this.dispatches.delete(dispatch.taskId);
        continue;
      }
      if (session.status === 'working') dispatch.sawWorking = true;
      const advanced = session.revision > dispatch.initialRevision;
      if ((dispatch.sawWorking || advanced) && (session.status === 'idle' || session.status === 'done')) {
        events.push({ type: 'completed', taskId: dispatch.taskId, sessionId: dispatch.sessionId });
        this.dispatches.delete(dispatch.taskId);
      }
    }
    return events;
  }
}

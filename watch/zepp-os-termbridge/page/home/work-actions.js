const DEFINITIONS = Object.freeze({
  summarize: { id: 'summarize', label: '获取摘要' },
  retry: { id: 'retry', label: '检查并重试' },
  continue: { id: 'continue', label: '继续下一步' },
  stop: { id: 'stop', label: '停止任务' },
  snooze: { id: 'snooze', label: '稍后 30 分钟' },
  handoff: { id: 'handoff', label: '在手机继续' }
})

export function actionsForStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'approval':
    case 'waiting':
      return pick('summarize', 'snooze', 'handoff', 'stop')
    case 'blocked':
    case 'failed':
    case 'error':
      return pick('summarize', 'retry', 'continue', 'snooze', 'handoff', 'stop')
    case 'working':
    case 'running':
    case 'active':
      return pick('summarize', 'continue', 'snooze', 'handoff', 'stop')
    case 'done':
      return pick('summarize', 'continue', 'handoff')
    default:
      return pick('summarize', 'snooze', 'handoff')
  }
}

function pick(...ids) {
  return ids.map((id) => DEFINITIONS[id])
}

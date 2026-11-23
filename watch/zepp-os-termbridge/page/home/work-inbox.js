const ATTENTION = new Set(['waiting', 'approval', 'blocked', 'failed', 'error'])

export function isAttentionStatus(status) {
  return ATTENTION.has(String(status || '').toLowerCase())
}

export function attentionCount(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter((item) => isAttentionStatus(item && item.status)).length
}

export function sortWorkInbox(alerts) {
  return [...(Array.isArray(alerts) ? alerts : [])].sort((left, right) => {
    const attentionDelta = Number(isAttentionStatus(right && right.status)) - Number(isAttentionStatus(left && left.status))
    if (attentionDelta) return attentionDelta
    return Number(right && right.occurredAt || 0) - Number(left && left.occurredAt || 0)
  })
}

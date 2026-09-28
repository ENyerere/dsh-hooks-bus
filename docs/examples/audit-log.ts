/**
 * Example consumer: audit log.
 *
 * Subscribes to PostToolUse / TurnEnd / SessionStart through the runtime API
 * and appends one record per event. Real consumer plugins import the bus the
 * same way — see `docs/author-guide.md`.
 * @module docs/examples/audit-log
 */

import type { Context } from 'cordis'

import type {} from '#src/index'

export interface AuditRecord {
  kind: string
  sessionId: string | undefined
  detail: string
}

export interface AuditLogHandle {
  records: AuditRecord[]
  dispose: () => void
}

export function registerAuditLog(ctx: Context): AuditLogHandle {
  const records: AuditRecord[] = []
  const disposeTool = ctx.hooksBus.on('PostToolUse', (event) => {
    const detail = `${event.toolName} ${event.durationMs ?? '?'}ms${event.error === undefined ? '' : ' (error)'}`
    records.push({ kind: 'tool', sessionId: event.sessionId, detail })
    ctx.logger.info('[audit-log] PostToolUse %s', detail)
  }, { label: 'audit-log', priority: -100 })
  const disposeTurn = ctx.hooksBus.on('TurnEnd', (event) => {
    records.push({
      kind: 'turn',
      sessionId: event.sessionId,
      detail: `turn ${event.turnIndex}`,
    })
  }, { label: 'audit-log', priority: -100 })
  const disposeSession = ctx.hooksBus.on('SessionStart', (event) => {
    records.push({
      kind: 'session',
      sessionId: event.sessionId,
      detail: `source=${event.source}`,
    })
  }, { label: 'audit-log', priority: -100 })
  return {
    records,
    dispose: () => {
      disposeTool()
      disposeTurn()
      disposeSession()
    },
  }
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerAuditLog } from '../docs/examples/audit-log.ts'
import { registerDangerGuard } from '../docs/examples/danger-command-guard.ts'
import { registerTurnStats } from '../docs/examples/turn-stats.ts'
import { createPluginHarness } from './harness.ts'
import type { PluginHarness } from './harness.ts'

interface WaterfallCtx {
  waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
}

interface EmitCtx {
  emit: (name: string, ...args: unknown[]) => unknown
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const execFixture = {
  callId: 'call-9',
  name: 'pwsh',
  arguments: { command: 'ls' },
  agent: { id: 's9' },
}

const allowNext = (): { kind: string } => ({ kind: 'allow' })

let harness: PluginHarness

beforeEach(async () => {
  harness = await createPluginHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe('example: audit-log', () => {
  it('records real PostToolUse and TurnEnd dispatches', async () => {
    const audit = registerAuditLog(harness.ctx)
    await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/post-execute',
      execFixture,
      { isError: false, value: {}, content: [] },
      async () => ({ kind: 'accept' }),
    )
    ;(harness.ctx as unknown as EmitCtx).emit('agent/turn-stopping', {
      agent: { id: 's9' },
      turn: 1,
    })
    await flush()
    expect(audit.records).toStrictEqual([
      { kind: 'tool', sessionId: 's9', detail: 'pwsh ?ms' },
      { kind: 'turn', sessionId: 's9', detail: 'turn 1' },
    ])
    audit.dispose()
  })
})

describe('example: danger-command-guard', () => {
  it('blocks a dangerous command and lets safe ones pass', async () => {
    registerDangerGuard(harness.ctx)
    const dangerous = {
      ...execFixture,
      arguments: { command: 'rm -rf /tmp/x' },
    }
    const blocked = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      dangerous,
      allowNext,
    )
    expect(blocked).toStrictEqual({
      kind: 'deny',
      reason: 'dangerous command blocked by guard-demo: rm -rf /tmp/x',
    })

    const safe = { ...execFixture, arguments: { command: 'ls -la' } }
    const allowed = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      safe,
      allowNext,
    )
    expect(allowed).toStrictEqual({ kind: 'allow' })
  })
})

describe('example: turn-stats', () => {
  it('counts real TurnEnd dispatches with usage', async () => {
    const meter = registerTurnStats(harness.ctx)
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit(
      'session/event',
      { id: 's9' },
      {
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'a' }],
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    )
    await flush()
    ctx.emit('agent/turn-stopping', { agent: { id: 's9' }, turn: 1 })
    ctx.emit('agent/turn-stopping', { agent: { id: 's9' }, turn: 2 })
    await flush()
    expect(meter.stats.turns).toBe(2)
    expect(meter.stats.totalInputTokens).toBe(10)
    expect(meter.stats.totalOutputTokens).toBe(5)
    meter.dispose()
  })
})

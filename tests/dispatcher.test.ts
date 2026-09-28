import { describe, expect, it } from 'vitest'

import type { HooksBusDecision, PreToolUseEvent } from '#src/catalog'
import { Dispatcher } from '#src/dispatcher'
import type { TimerLike } from '#src/dispatcher'
import { DispatchLogger } from '#src/logger'
import { Registry } from '#src/registry'

class ManualTimer implements TimerLike {
  private pending: { callback: () => void }[] = []

  timeout(callback: () => void): () => void {
    const entry = { callback }
    this.pending.push(entry)
    return () => {
      const index = this.pending.indexOf(entry)
      if (index !== -1) {
        this.pending.splice(index, 1)
      }
    }
  }

  fireAll(): void {
    const { pending } = this
    this.pending = []
    for (const entry of pending) {
      entry.callback()
    }
  }

  count(): number {
    return this.pending.length
  }
}

function setup(): {
  dispatcher: Dispatcher
  logger: DispatchLogger
  registry: Registry
  timer: ManualTimer
} {
  const registry = new Registry(5000)
  const logger = new DispatchLogger(500, false, 200)
  const timer = new ManualTimer()
  return {
    dispatcher: new Dispatcher(registry, logger, timer),
    logger,
    registry,
    timer,
  }
}

const payload: PreToolUseEvent = {
  sessionId: 's1',
  toolName: 'pwsh',
  args: { command: 'ls' },
  callId: 'call-1',
  signal: undefined,
}

describe(Dispatcher, () => {
  it('returns passthrough without touching the timer or log when nobody subscribes', async () => {
    const { dispatcher, logger, timer } = setup()
    const outcome = await dispatcher.dispatch('PreToolUse', payload)
    expect(outcome.status).toBe('passthrough')
    expect(outcome.merged).toStrictEqual({ kind: 'passthrough' })
    expect(logger.list()).toStrictEqual([])
    expect(timer.count()).toBe(0)
  })

  it('runs subscribers in priority order', async () => {
    const { dispatcher, registry } = setup()
    const order: string[] = []
    registry.subscribe(
      'PreToolUse',
      () => {
        order.push('low')
      },
      { priority: 1 },
    )
    registry.subscribe(
      'PreToolUse',
      () => {
        order.push('high')
      },
      { priority: 10 },
    )
    await dispatcher.dispatch('PreToolUse', payload)
    expect(order).toStrictEqual(['high', 'low'])
  })

  it('isolates a throwing subscriber and continues the chain', async () => {
    const { dispatcher, logger, registry } = setup()
    const calls: string[] = []
    registry.subscribe(
      'PreToolUse',
      () => {
        calls.push('boom')
        throw new Error('subscriber exploded')
      },
      { priority: 100 },
    )
    registry.subscribe(
      'PreToolUse',
      () => {
        calls.push('alive')
        return { action: 'block', reason: 'later wins' }
      },
      { priority: 1 },
    )
    const outcome = await dispatcher.dispatch('PreToolUse', payload)
    expect(calls).toStrictEqual(['boom', 'alive'])
    expect(outcome.merged).toStrictEqual({ kind: 'deny', reason: 'later wins' })
    expect(outcome.subscribers[0]?.status).toBe('error')
    expect(outcome.subscribers[0]?.summary).toContain('subscriber exploded')
    expect(logger.list()[0]?.subscribers).toHaveLength(2)
  })

  it('skips a hung subscriber after the timeout and continues', async () => {
    const { dispatcher, registry, timer } = setup()
    const calls: string[] = []
    registry.subscribe(
      'PreToolUse',
      () => {
        calls.push('hang')
        return new Promise<never>(() => {})
      },
      { priority: 100, timeoutMs: 50 },
    )
    registry.subscribe(
      'PreToolUse',
      () => {
        calls.push('after')
        return { action: 'cancel' }
      },
      { priority: 1 },
    )
    const pending = dispatcher.dispatch('PreToolUse', payload)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    timer.fireAll()
    const outcome = await pending
    expect(calls).toStrictEqual(['hang', 'after'])
    expect(outcome.subscribers[0]?.status).toBe('timeout')
    expect(outcome.subscribers[0]?.summary).toContain('timed out after 50ms')
    expect(outcome.merged).toStrictEqual({ kind: 'cancel' })
  })

  it('records invalid decisions as warnings on the subscriber outcome', async () => {
    const { dispatcher, registry } = setup()
    registry.subscribe(
      'PreToolUse',
      () => ({ action: 'explode' }) as unknown as HooksBusDecision,
    )
    const outcome = await dispatcher.dispatch('PreToolUse', payload)
    expect(outcome.merged).toStrictEqual({ kind: 'passthrough' })
    expect(outcome.warnings).toHaveLength(1)
    expect(outcome.subscribers[0]?.summary).toContain('treated as allow')
  })
})

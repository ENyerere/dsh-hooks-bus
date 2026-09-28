import { describe, expect, it } from 'vitest'

import type { CatalogEventName } from '#src/catalog'
import { EVENT_NAMES } from '#src/catalog'
import { Registry } from '#src/registry'

describe(Registry, () => {
  it('rejects unknown event names and lists legal ones', () => {
    const registry = new Registry(5000)
    expect(() =>
      registry.subscribe('PreToolUs' as unknown as CatalogEventName, () => {}),
    ).toThrow(/legal events: .*PreToolUse/s)
  })

  it('accepts every catalog event', () => {
    const registry = new Registry(5000)
    for (const event of EVENT_NAMES) {
      expect(() => registry.subscribe(event, () => {})).not.toThrow()
    }
  })

  it('applies default and per-subscription timeouts', () => {
    const registry = new Registry(5000)
    const defaultSubscription = registry.subscribe('SessionStart', () => {})
    expect(defaultSubscription).toBeTypeOf('function')
    expect(registry.subscribersOf('SessionStart')[0]?.timeoutMs).toBe(5000)

    registry.subscribe('SessionStart', () => {}, { timeoutMs: 300 })
    const withOverride = registry.subscribersOf('SessionStart')
    expect(withOverride.find((entry) => entry.timeoutMs === 300)).toBeDefined()
  })

  it('rejects invalid priority and timeout values', () => {
    const registry = new Registry(5000)
    expect(() =>
      registry.subscribe('SessionStart', () => {}, { priority: Number.NaN }),
    ).toThrow(/priority/)
    expect(() =>
      registry.subscribe('SessionStart', () => {}, { timeoutMs: 0 }),
    ).toThrow(/timeoutMs/)
  })

  it('orders subscribers by priority desc, stable by id, and unsubscribes', () => {
    const registry = new Registry(5000)
    registry.subscribe('PreToolUse', () => {}, { priority: 1 })

    // Equal priority: earlier subscription (lower id) runs first.
    const seen: string[] = []
    registry.subscribe(
      'PreToolUse',
      () => {
        seen.push('a')
      },
      { priority: 10 },
    )
    registry.subscribe(
      'PreToolUse',
      () => {
        seen.push('b')
      },
      { priority: 10 },
    )

    let subscribers = registry.subscribersOf('PreToolUse')
    expect(subscribers.map((entry) => entry.priority)).toStrictEqual([
      10, 10, 1,
    ])
    for (const entry of subscribers) {
      void entry.handler(undefined)
    }
    expect(seen).toStrictEqual(['a', 'b'])

    const removed = registry.subscribe('PreToolUse', () => {}, {
      priority: 100,
    })
    subscribers = registry.subscribersOf('PreToolUse')
    expect(subscribers[0]?.priority).toBe(100)
    removed()
    subscribers = registry.subscribersOf('PreToolUse')
    expect(subscribers.some((entry) => entry.priority === 100)).toBeFalsy()
  })
})

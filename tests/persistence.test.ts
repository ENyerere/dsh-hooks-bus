import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'

import type { Config as PluginConfig } from '#src/config'
import { Config, apply, inject, name as pluginName } from '#src/index'
import type { HooksBusService } from '#src/runtime'

const plugin = { Config, apply, inject, name: pluginName }

interface WaterfallCtx {
  waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
}

/** In-memory stand-in for the storageDomain facility's Domain contract. */
class FakeTable {
  private readonly map = new Map<string, unknown>()

  get size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.map.entries()
  }

  keys(): IterableIterator<string> {
    return this.map.keys()
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}

class FakeDomain {
  readonly name = 'dsh-hooks-bus'
  private pausedValue = { paused: false }
  private readonly tables = new Map<string, FakeTable>()

  global = {
    get: (): { paused: boolean } => this.pausedValue,
    set: async (value: { paused: boolean }): Promise<void> => {
      this.pausedValue = value
    },
  }

  table(name: string): FakeTable {
    let table = this.tables.get(name)
    if (table === undefined) {
      table = new FakeTable()
      this.tables.set(name, table)
    }
    return table
  }

  async close(): Promise<void> {}
}

class FakeStorageDomain {
  constructor(public readonly domain: FakeDomain) {}

  async open(): Promise<FakeDomain> {
    return this.domain
  }
}

interface Harness {
  ctx: Context
  hooksBus: HooksBusService
  dispose: () => Promise<void>
}

async function mountWithStorage(
  facility: FakeStorageDomain | undefined,
  config: PluginConfig = {},
): Promise<Harness> {
  const ctx = new Context()
  if (facility !== undefined) {
    ;(ctx as unknown as { provide: (key: string, value: unknown) => unknown }).provide(
      'storageDomain',
      facility,
    )
  }
  const fiber = await ctx.plugin(plugin, config)
  await flush()
  return {
    ctx,
    hooksBus: (ctx as unknown as { hooksBus: HooksBusService }).hooksBus,
    async dispose(): Promise<void> {
      await fiber.dispose()
      await flush()
    },
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const execFixture = {
  callId: 'call-p1',
  name: 'pwsh',
  arguments: { command: 'ls' },
  agent: { id: 'sp' },
}

const allowNext = (): { kind: string } => ({ kind: 'allow' })

describe('persistence', () => {
  it('persists dispatch records and restores them across a reopen', async () => {
    const facility = new FakeStorageDomain(new FakeDomain())
    const first = await mountWithStorage(facility)
    first.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'nope' }))
    await (first.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    await flush()
    expect(first.hooksBus.logs()).toHaveLength(1)
    await first.dispose()

    const second = await mountWithStorage(facility)
    const restored = second.hooksBus.logs()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      event: 'PreToolUse',
      sessionId: 'sp',
      decision: 'deny(nope)',
    })
    await second.dispose()
  })

  it('persists the global pause flag across a reopen', async () => {
    const facility = new FakeStorageDomain(new FakeDomain())
    const first = await mountWithStorage(facility)
    first.hooksBus.setPaused(true)
    await flush()
    await first.dispose()

    const second = await mountWithStorage(facility)
    expect((second.hooksBus.state() as { paused: boolean }).paused).toBeTruthy()
    // While paused, a block subscriber must have no effect on the chain.
    second.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'x' }))
    const result = await (second.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'allow' })
    await second.dispose()
  })

  it('evicts stored records beyond the ring capacity', async () => {
    const facility = new FakeStorageDomain(new FakeDomain())
    const harness = await mountWithStorage(facility, { logCapacity: 3 })
    harness.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'x' }))
    for (let index = 0; index < 5; index += 1) {
      await (harness.ctx as unknown as WaterfallCtx).waterfall(
        'tools/pre-execute',
        execFixture,
        allowNext,
      )
    }
    await flush()
    expect(harness.hooksBus.logs()).toHaveLength(3)
    expect(facility.domain.table('logs').size).toBe(3)
    await harness.dispose()
  })
})

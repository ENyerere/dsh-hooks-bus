import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'

import type { Config as PluginConfig } from '#src/config'
import { Config, apply, inject, name as pluginName } from '#src/index'
import type { DispatchLogRecord } from '#src/logger'
import type { PersistenceInfo } from '#src/persistence'
import type { HooksBusService } from '#src/runtime'

import { FakeDomain, FakeStorageDomain } from './fake-storage.ts'

const plugin = { Config, apply, inject, name: pluginName }

interface WaterfallCtx {
  waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
}

interface Harness {
  ctx: Context
  hooksBus: HooksBusService
  dispose: () => Promise<void>
}

async function mount(config: PluginConfig = {}): Promise<Harness> {
  const ctx = new Context()
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

function provideStorage(ctx: Context, facility: FakeStorageDomain): () => void {
  return (
    ctx as unknown as {
      provide: (key: string, value: unknown) => () => void
    }
  ).provide('storageDomain', facility)
}

async function mountWithStorage(
  facility: FakeStorageDomain,
  config: PluginConfig = {},
): Promise<Harness> {
  const harness = await mount(config)
  provideStorage(harness.ctx, facility)
  await waitFor(
    () => persistenceOf(harness).status === 'ready',
    'persistence ready',
  )
  return harness
}

function persistenceOf(harness: Harness): PersistenceInfo {
  const state = harness.hooksBus.state() as { persistence: PersistenceInfo }
  return state.persistence
}

function pausedOf(harness: Harness): boolean {
  return (harness.hooksBus.state() as { paused: boolean }).paused
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

const execFixture = {
  callId: 'call-p1',
  name: 'pwsh',
  arguments: { command: 'ls' },
  agent: { id: 'sp' },
}

const allowNext = (): { kind: string } => ({ kind: 'allow' })

function waterfall(
  harness: Harness,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  return (harness.ctx as unknown as WaterfallCtx).waterfall(name, ...args)
}

function storedRecord(
  seq: number,
  event: DispatchLogRecord['event'],
  decision: string,
): DispatchLogRecord {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    event,
    sessionId: undefined,
    durationMs: 1,
    decision,
    payloadSummary: undefined,
    subscribers: [],
  }
}

describe('persistence', () => {
  it('persists dispatch records and restores them across a reopen', async () => {
    const facility = new FakeStorageDomain()
    const first = await mountWithStorage(facility)
    first.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'nope' }))
    await waterfall(first, 'tools/pre-execute', execFixture, allowNext)
    await waitFor(
      () => facility.domain.table('logs').size === 1,
      'first record persisted',
    )
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
    const facility = new FakeStorageDomain()
    const first = await mountWithStorage(facility)
    first.hooksBus.setPaused(true)
    await waitFor(() => facility.domain.pausedValue.paused, 'pause persisted')
    await first.dispose()

    const second = await mountWithStorage(facility)
    expect(pausedOf(second)).toBeTruthy()
    // While paused, a block subscriber must have no effect on the chain.
    second.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'x' }))
    const result = await waterfall(
      second,
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'allow' })
    await second.dispose()
  })

  it('evicts stored records beyond the ring capacity', async () => {
    const facility = new FakeStorageDomain()
    const harness = await mountWithStorage(facility, { logCapacity: 3 })
    harness.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'x' }))
    for (let index = 0; index < 5; index += 1) {
      await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    }
    await waitFor(
      () => facility.domain.table('logs').size === 3,
      'ring eviction persisted',
    )
    expect(harness.hooksBus.logs()).toHaveLength(3)
    await harness.dispose()
  })

  it('uses a domain name the real storage hub accepts', async () => {
    // The runtime's dsh-storage-json rejects unit names outside /^[a-z][a-z0-9_]*$/.
    // A hyphenated name fails to open in the real host and silently degrades to memory mode.
    // This is exactly the bug dsh-scheduler hit in M2.
    const { DOMAIN_NAME } = await import('#src/persistence')
    expect(DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe('persistence: startup race', () => {
  it('waits for a late storageDomain service and becomes persistent', async () => {
    const harness = await mount()
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'memory',
      status: 'unavailable',
    })

    // A dispatch produced before the storage service exists must survive.
    harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'late',
    }))
    await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    expect(harness.hooksBus.logs()).toHaveLength(1)

    const facility = new FakeStorageDomain()
    provideStorage(harness.ctx, facility)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'ready after late storage service',
    )
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'persistent',
      status: 'ready',
    })
    expect(facility.openCalls).toBe(1)
    await waitFor(
      () => facility.domain.table('logs').size === 1,
      'pre-open log persisted after late open',
    )
    await harness.dispose()
  })

  it('stays memory/unavailable when the storage service never appears', async () => {
    const harness = await mount()
    await waitFor(
      () => persistenceOf(harness).status === 'unavailable',
      'unavailable without storage',
    )
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'memory',
      status: 'unavailable',
    })

    harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'memory-only',
    }))
    const result = await waterfall(
      harness,
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'deny', reason: 'memory-only' })
    expect(harness.hooksBus.logs()).toHaveLength(1)
    const state = harness.hooksBus.state() as {
      catalogVersion: string
      events: unknown[]
    }
    expect(state.catalogVersion).toBe('1.1.0')
    expect(state.events).toHaveLength(9)
    await harness.dispose()
  })
})

describe('persistence: open failures and merged logs', () => {
  it('reports an open failure in state and logs without breaking dispatch', async () => {
    const errors: string[] = []
    const harness = await mount()
    const logger = (
      harness.ctx as unknown as {
        logger: { error: (...args: unknown[]) => void }
      }
    ).logger
    const originalError = logger.error.bind(logger)
    logger.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(' '))
      originalError(...args)
    }
    const facility = new FakeStorageDomain(new FakeDomain(), {
      failWith: new Error('backend offline'),
    })
    provideStorage(harness.ctx, facility)
    await waitFor(
      () => persistenceOf(harness).status === 'error',
      'error status after failed open',
    )
    expect(persistenceOf(harness).mode).toBe('memory')
    expect(persistenceOf(harness).error).toContain('backend offline')
    expect(
      errors.some((entry) => entry.includes('persistence open failed')),
    ).toBeTruthy()

    harness.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'ok' }))
    const result = await waterfall(
      harness,
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'deny', reason: 'ok' })
    expect(harness.hooksBus.logs()).toHaveLength(1)
    await harness.dispose()
  })

  it('merges pre-open logs with stored history without loss or duplicates', async () => {
    const domain = new FakeDomain()
    await domain
      .table('logs')
      .put('1', storedRecord(1, 'PreToolUse', 'deny(old-1)'))
    await domain
      .table('logs')
      .put('2', storedRecord(2, 'SessionStart', 'allow'))
    const facility = new FakeStorageDomain(domain, { deferred: true })
    const harness = await mount()
    provideStorage(harness.ctx, facility)
    await waitFor(() => facility.openCalls === 1, 'open started')

    const offFirst = harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'new-1',
    }))
    await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    offFirst()
    const offSecond = harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'new-2',
    }))
    await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    offSecond()
    expect(harness.hooksBus.logs().map((record) => record.seq)).toStrictEqual([
      1, 2,
    ])
    expect(persistenceOf(harness).status).toBe('initializing')

    facility.release()
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'ready after deferred open',
    )
    const logs = harness.hooksBus.logs()
    expect(logs.map((record) => record.seq)).toStrictEqual([1, 2, 3, 4])
    expect(logs.map((record) => record.decision)).toStrictEqual([
      'deny(old-1)',
      'allow',
      'deny(new-1)',
      'deny(new-2)',
    ])
    await waitFor(
      () => domain.table('logs').size === 4,
      'pre-open logs written to storage',
    )
    await harness.dispose()
  })
})

describe('persistence: pause and dispose races', () => {
  it('does not let a late storage snapshot overwrite a pause toggle before open', async () => {
    const domain = new FakeDomain()
    await domain.global.set({ paused: true })
    const facility = new FakeStorageDomain(domain, { deferred: true })
    const harness = await mount()
    provideStorage(harness.ctx, facility)
    await waitFor(() => facility.openCalls === 1, 'open started')

    harness.hooksBus.setPaused(false)
    expect(pausedOf(harness)).toBeFalsy()
    facility.release()
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'ready after deferred open',
    )
    expect(pausedOf(harness)).toBeFalsy()
    await waitFor(() => !domain.pausedValue.paused, 'pause write-back')
    await harness.dispose()
  })

  it('adopts the stored pause when the user did not toggle before open', async () => {
    const domain = new FakeDomain()
    await domain.global.set({ paused: true })
    const facility = new FakeStorageDomain(domain, { deferred: true })
    const harness = await mount()
    provideStorage(harness.ctx, facility)
    await waitFor(() => facility.openCalls === 1, 'open started')

    facility.release()
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'ready after deferred open',
    )
    expect(pausedOf(harness)).toBeTruthy()
    await harness.dispose()
  })

  it('closes a domain whose open finishes after dispose without committing', async () => {
    const domain = new FakeDomain()
    const facility = new FakeStorageDomain(domain, { deferred: true })
    const harness = await mount()
    provideStorage(harness.ctx, facility)
    await waitFor(() => facility.openCalls === 1, 'open started')

    await harness.dispose()
    facility.release()
    await flush()
    await flush()
    expect(domain.closeCalls).toBe(1)
    expect(persistenceOf(harness).mode).toBe('memory')
    expect(persistenceOf(harness).status).not.toBe('ready')
  })

  it('opens the domain once per storage service instance', async () => {
    const facility = new FakeStorageDomain()
    const harness = await mount()
    provideStorage(harness.ctx, facility)
    await waitFor(() => persistenceOf(harness).status === 'ready', 'ready')
    await flush()
    expect(facility.openCalls).toBe(1)
    expect(harness.hooksBus.logs()).toStrictEqual([])
    await harness.dispose()
  })

  it('reopens on a storage service replacement without stale or duplicate state', async () => {
    const first = new FakeStorageDomain()
    const harness = await mount()
    const removeStorage = provideStorage(harness.ctx, first)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'first service ready',
    )
    harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'replace',
    }))
    await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    await waitFor(
      () => first.domain.table('logs').size === 1,
      'first service persisted',
    )

    removeStorage()
    await waitFor(
      () => persistenceOf(harness).mode === 'memory',
      'detached from the removed service',
    )
    expect(first.domain.closeCalls).toBe(1)

    const second = new FakeStorageDomain()
    provideStorage(harness.ctx, second)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'second service ready',
    )
    expect(second.openCalls).toBe(1)
    expect(harness.hooksBus.logs()).toHaveLength(1)
    await waitFor(
      () => second.domain.table('logs').size === 1,
      'memory log written to the replacement store',
    )
    await harness.dispose()
  })
})

describe('persistence: removal availability', () => {
  it('reports unavailable after the last storage service is removed', async () => {
    const facility = new FakeStorageDomain()
    const harness = await mount()
    const removeStorage = provideStorage(harness.ctx, facility)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'first service ready',
    )
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'persistent',
      status: 'ready',
    })

    removeStorage()
    await waitFor(
      () => persistenceOf(harness).status === 'unavailable',
      'unavailable after the service is gone',
    )
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'memory',
      status: 'unavailable',
    })
    expect(facility.domain.closeCalls).toBe(1)
    await harness.dispose()
  })

  it('reopens automatically when a replacement service appears', async () => {
    const domain = new FakeDomain()
    const first = new FakeStorageDomain(domain)
    const harness = await mount()
    const removeStorage = provideStorage(harness.ctx, first)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'first service ready',
    )

    removeStorage()
    await waitFor(
      () => persistenceOf(harness).status === 'unavailable',
      'unavailable before replacement',
    )
    const second = new FakeStorageDomain(domain)
    provideStorage(harness.ctx, second)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'replacement service ready',
    )
    expect(first.openCalls).toBe(1)
    expect(second.openCalls).toBe(1)
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'persistent',
      status: 'ready',
    })
    await harness.dispose()
  })
})

describe('persistence: removal state and data', () => {
  it('does not duplicate or lose logs and pause across removal and replacement', async () => {
    const domain = new FakeDomain()
    const first = new FakeStorageDomain(domain)
    const harness = await mount()
    const removeStorage = provideStorage(harness.ctx, first)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'first service ready',
    )
    harness.hooksBus.on('PreToolUse', () => ({
      action: 'block',
      reason: 'removal',
    }))
    await waterfall(harness, 'tools/pre-execute', execFixture, allowNext)
    await waitFor(
      () => domain.table('logs').size === 1,
      'log persisted to first service',
    )
    harness.hooksBus.setPaused(true)
    await waitFor(() => domain.pausedValue.paused, 'pause persisted to first')

    removeStorage()
    await waitFor(
      () => persistenceOf(harness).status === 'unavailable',
      'unavailable before replacement',
    )
    const second = new FakeStorageDomain(domain)
    provideStorage(harness.ctx, second)
    await waitFor(
      () => persistenceOf(harness).status === 'ready',
      'replacement service ready',
    )

    expect(second.openCalls).toBe(1)
    expect(pausedOf(harness)).toBeTruthy()
    expect(harness.hooksBus.logs()).toHaveLength(1)
    expect(domain.table('logs').size).toBe(1)
    expect(domain.pausedValue.paused).toBeTruthy()
    await harness.dispose()
  })

  it('drops an open-failure summary once the failing service is removed', async () => {
    const harness = await mount()
    const failing = new FakeStorageDomain(new FakeDomain(), {
      failWith: new Error('backend offline'),
    })
    const removeStorage = provideStorage(harness.ctx, failing)
    await waitFor(
      () => persistenceOf(harness).status === 'error',
      'error after failed open',
    )
    expect(persistenceOf(harness).error).toContain('backend offline')

    removeStorage()
    await waitFor(
      () => persistenceOf(harness).status === 'unavailable',
      'unavailable after the failing service is removed',
    )
    expect(persistenceOf(harness)).toStrictEqual({
      mode: 'memory',
      status: 'unavailable',
    })
    await harness.dispose()
  })
})

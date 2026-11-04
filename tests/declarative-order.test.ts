import { describe, expect, it } from 'vitest'

import type { CatalogEventName } from '#src/catalog'
import type { DeclarativeEntry } from '#src/service'

import { createPluginHarness } from './harness.ts'
import type { PluginHarness } from './harness.ts'

interface OrderCase {
  label: string
  event?: CatalogEventName
  priority?: number
  key?: string
  before?: readonly string[]
  after?: readonly string[]
}

interface WaterfallCtx {
  waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
}

const execFixture = {
  callId: 'dag-call',
  name: 'pwsh',
  arguments: { command: 'ls' },
  agent: { id: 'dag-session' },
}

const allowNext = (): { kind: string } => ({ kind: 'allow' })

function entriesFor(
  cases: readonly OrderCase[],
  seen: string[],
): DeclarativeEntry[] {
  return cases.map((entry) => ({
    event: entry.event ?? 'PreToolUse',
    handler: (): void => {
      seen.push(entry.label)
    },
    label: entry.label,
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    ...(entry.key === undefined ? {} : { key: entry.key }),
    ...(entry.before === undefined ? {} : { before: entry.before }),
    ...(entry.after === undefined ? {} : { after: entry.after }),
  }))
}

async function dispatch(harness: PluginHarness): Promise<void> {
  await (harness.ctx as unknown as WaterfallCtx).waterfall(
    'tools/pre-execute',
    execFixture,
    allowNext,
  )
}

async function orderFor(cases: readonly OrderCase[]): Promise<string[]> {
  const harness = await createPluginHarness()
  const seen: string[] = []
  await harness.hooksBus.declare(entriesFor(cases, seen))
  await dispatch(harness)
  await harness.dispose()
  return seen
}

function subscriptionsOf(harness: PluginHarness): unknown[] {
  return (harness.hooksBus.state() as { subscriptions: unknown[] })
    .subscriptions
}

describe('declarative DAG ordering', () => {
  it('runs a before-constrained entry first even when priority disagrees', async () => {
    await expect(
      orderFor([
        { label: 'a', key: 'a', priority: 0, before: ['b'] },
        { label: 'b', key: 'b', priority: 100 },
      ]),
    ).resolves.toStrictEqual(['a', 'b'])
  })

  it('runs an after-constrained entry after its reference', async () => {
    await expect(
      orderFor([
        { label: 'a', key: 'a', priority: 100, after: ['b'] },
        { label: 'b', key: 'b', priority: 0 },
      ]),
    ).resolves.toStrictEqual(['b', 'a'])
  })

  it('handles a multi-level dependency chain against priority', async () => {
    await expect(
      orderFor([
        { label: 'a', key: 'a', priority: 0, before: ['b'] },
        { label: 'b', key: 'b', priority: 50, before: ['c'] },
        { label: 'c', key: 'c', priority: 100 },
      ]),
    ).resolves.toStrictEqual(['a', 'b', 'c'])
  })

  it('allows a keyless entry to constrain a keyed entry', async () => {
    await expect(
      orderFor([
        { label: 'source', priority: 0, before: ['target'] },
        { label: 'target', key: 'target', priority: 100 },
      ]),
    ).resolves.toStrictEqual(['source', 'target'])
  })

  it('preserves the exact legacy order when a batch has no constraints', async () => {
    await expect(
      orderFor([
        { label: 'low', priority: 0 },
        { label: 'high', priority: 100 },
        { label: 'mid', priority: 50 },
      ]),
    ).resolves.toStrictEqual(['high', 'mid', 'low'])
    await expect(
      orderFor([{ label: 'first' }, { label: 'second' }, { label: 'third' }]),
    ).resolves.toStrictEqual(['first', 'second', 'third'])
  })

  it('breaks topological ties by priority and then declaration order', async () => {
    await expect(
      orderFor([
        { label: 'a', key: 'a', priority: 0, before: ['c'] },
        { label: 'b', key: 'b', priority: 100 },
        { label: 'c', key: 'c', priority: 0 },
      ]),
    ).resolves.toStrictEqual(['b', 'a', 'c'])
    await expect(
      orderFor([
        { label: 'a', key: 'a', before: ['c'] },
        { label: 'b', key: 'b' },
        { label: 'c', key: 'c' },
      ]),
    ).resolves.toStrictEqual(['a', 'b', 'c'])
  })

  it('keeps runtime on() subscripions on priority plus registration order', async () => {
    const harness = await createPluginHarness()
    const seen: string[] = []
    harness.hooksBus.on(
      'PreToolUse',
      (): void => {
        seen.push('low')
      },
      { priority: 0 },
    )
    harness.hooksBus.on(
      'PreToolUse',
      (): void => {
        seen.push('high')
      },
      { priority: 100 },
    )
    await dispatch(harness)
    expect(seen).toStrictEqual(['high', 'low'])
    await harness.dispose()
  })

  it('keeps the constrained order of the remaining nodes when one is paused', async () => {
    const harness = await createPluginHarness()
    const seen: string[] = []
    await harness.hooksBus.declare(
      entriesFor(
        [
          { label: 'a', key: 'a', priority: 100, before: ['b'] },
          { label: 'b', key: 'b', priority: 0, before: ['c'] },
          { label: 'c', key: 'c', priority: 200 },
        ],
        seen,
      ),
    )
    const state = harness.hooksBus.state() as {
      subscriptions: { id: number; label: string }[]
    }
    const middleId = state.subscriptions.find(
      (entry) => entry.label === 'b',
    )?.id
    expect(middleId).toBeTypeOf('number')
    expect(
      harness.hooksBus.setSubscriptionPaused(middleId ?? -1, true),
    ).toBeTruthy()
    await dispatch(harness)
    expect(seen).toStrictEqual(['a', 'c'])
    await harness.dispose()
  })
})

describe('declarative DAG validation', () => {
  it('rejects duplicate keys in one event/batch without partial registration', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        { event: 'PreToolUse', handler: (): void => {}, key: 'dup' },
        { event: 'PreToolUse', handler: (): void => {}, key: 'dup' },
      ]),
    ).rejects.toThrow(/duplicate declarative key "dup"/)
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('rejects an unknown key reference without partial registration', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'a',
          before: ['missing'],
        },
      ]),
    ).rejects.toThrow(/unknown declarative key "missing"/)
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('rejects a cross-event reference and names the owning event', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'a',
          before: ['b'],
        },
        { event: 'SessionStart', handler: (): void => {}, key: 'b' },
      ]),
    ).rejects.toThrow(/belongs to event "SessionStart"/)
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('reports a self-cycle with its readable path', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'a',
          before: ['a'],
        },
      ]),
    ).rejects.toThrow(
      /declarative ordering cycle in event "PreToolUse": a -> a/,
    )
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('reports a multi-node cycle with its readable path', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'a',
          before: ['b'],
        },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'b',
          before: ['c'],
        },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'c',
          before: ['a'],
        },
      ]),
    ).rejects.toThrow(
      /declarative ordering cycle in event "PreToolUse": a -> b -> c -> a/,
    )
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('rolls back a batch when a later entry has invalid timing options', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        { event: 'PreToolUse', handler: (): void => {}, label: 'valid' },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          label: 'invalid',
          timeoutMs: 0,
        },
      ]),
    ).rejects.toThrow(/timeoutMs must be a positive number/)
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })
})

describe('declarative DAG cycle coverage', () => {
  it('detects a cycle whose path passes through a keyless entry', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          before: ['b'],
          after: ['b'],
        },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'b',
        },
      ]),
    ).rejects.toThrow(
      /declarative ordering cycle in event "PreToolUse": #0 -> b -> #0/,
    )
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })

  it('detects a mixed keyed/keyless multi-node cycle', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          before: ['b'],
          after: ['a'],
        },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'b',
          before: ['a'],
        },
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'a',
        },
      ]),
    ).rejects.toThrow(
      /declarative ordering cycle in event "PreToolUse": #0 -> b -> a -> #0/,
    )
    expect(subscriptionsOf(harness)).toStrictEqual([])
    await harness.dispose()
  })
})

describe('declarative DAG scope and compatibility', () => {
  it('scopes a key to one batch so a later batch can reuse it', async () => {
    const harness = await createPluginHarness()
    await harness.hooksBus.declare([
      {
        event: 'PreToolUse',
        handler: (): void => {},
        key: 'same',
        label: 'first',
      },
    ])
    await harness.hooksBus.declare([
      {
        event: 'PreToolUse',
        handler: (): void => {},
        key: 'same',
        label: 'second',
      },
    ])
    expect(subscriptionsOf(harness)).toHaveLength(2)
    await harness.dispose()
  })

  it('does not resolve a key declared in a different batch', async () => {
    const harness = await createPluginHarness()
    await harness.hooksBus.declare([
      { event: 'PreToolUse', handler: (): void => {}, key: 'a' },
    ])
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): void => {},
          key: 'b',
          after: ['a'],
        },
      ]),
    ).rejects.toThrow(/unknown declarative key "a"/)
    expect(subscriptionsOf(harness)).toHaveLength(1)
    await harness.dispose()
  })

  it('removes the DAG constraints when the batch is disposed', async () => {
    const harness = await createPluginHarness()
    const seen: string[] = []
    const dispose = await harness.hooksBus.declare(
      entriesFor(
        [
          { label: 'a', key: 'a', priority: 0, before: ['b'] },
          { label: 'b', key: 'b', priority: 100 },
        ],
        seen,
      ),
    )
    dispose()
    await harness.hooksBus.declare(
      entriesFor(
        [
          { label: 'new-low', priority: 0, before: [] },
          { label: 'new-high', priority: 100 },
        ],
        seen,
      ),
    )
    await dispatch(harness)
    expect(seen).toStrictEqual(['new-high', 'new-low'])
    await harness.dispose()
  })
})

import { describe, expect, it } from 'vitest'

import { EXTERNAL_HANDLER_REF, normalizeOwner } from '#src/owner'
import type { SubscriptionOwner } from '#src/owner'

import { createPluginHarness } from './harness.ts'

interface StateSubscription {
  id: number
  event: string
  priority: number
  timeoutMs: number
  source: string
  label: string
  paused: boolean
  owner: SubscriptionOwner
}

interface StateLike {
  subscriptions: StateSubscription[]
}

describe('subscription owner normalization', () => {
  it('keeps a complete owner and normalizes its handler reference', () => {
    expect(
      normalizeOwner({
        packageName: 'my-plugin',
        packageVersion: '1.2.3',
        handlerRef: '.\\hooks\\guard.js',
      }),
    ).toStrictEqual({
      packageName: 'my-plugin',
      packageVersion: '1.2.3',
      handlerRef: 'hooks/guard.js',
    })
  })

  it('returns undefined for old consumers without owner metadata', () => {
    expect(normalizeOwner(undefined)).toBeUndefined()
    expect(
      normalizeOwner({
        packageName: '  ',
        packageVersion: '',
        handlerRef: '  ',
      }),
    ).toBeUndefined()
  })

  it('marks absolute, URL-shaped, and escaping handler references as external', () => {
    for (const handlerRef of [
      '/home/user/plugin/hooks/guard.js',
      String.raw`C:\Users\user\hooks\guard.js`,
      String.raw`\\server\share\hooks\guard.js`,
      'file:///home/user/guard.js',
      '../outside-package/guard.js',
      'hooks/../../outside-package/guard.js',
    ]) {
      expect(normalizeOwner({ handlerRef })).toStrictEqual({
        handlerRef: EXTERNAL_HANDLER_REF,
      })
    }
  })

  it('drops absolute package identities instead of exposing local paths', () => {
    expect(
      normalizeOwner({
        packageName: '/home/user/my-plugin',
        packageVersion: String.raw`C:\build\version`,
        handlerRef: 'hooks/x.js',
      }),
    ).toStrictEqual({ handlerRef: 'hooks/x.js' })
  })

  it('normalizes a safe path that uses inner dot segments', () => {
    expect(
      normalizeOwner({ handlerRef: './hooks/./../hooks/guard.js' }),
    ).toStrictEqual({ handlerRef: 'hooks/guard.js' })
  })
})

describe('subscription owner through the service state', () => {
  it('publishes a complete declarative owner without changing legacy fields', async () => {
    const harness = await createPluginHarness()
    await harness.hooksBus.declare([
      {
        event: 'PreToolUse',
        handler: (): undefined => undefined,
        priority: 7,
        timeoutMs: 1234,
        label: 'owned',
        owner: {
          packageName: 'dsh-hook-guard-demo',
          packageVersion: '9.9.9',
          handlerRef: './hooks/danger-guard.js',
        },
      },
    ])
    const state = harness.hooksBus.state() as StateLike
    expect(state.subscriptions).toMatchObject([
      {
        event: 'PreToolUse',
        priority: 7,
        timeoutMs: 1234,
        source: 'declarative',
        label: 'owned',
        paused: false,
        owner: {
          packageName: 'dsh-hook-guard-demo',
          packageVersion: '9.9.9',
          handlerRef: 'hooks/danger-guard.js',
        },
      },
    ])
    await harness.dispose()
  })

  it('supports old consumers without owner metadata', async () => {
    const harness = await createPluginHarness()
    harness.hooksBus.on('PreToolUse', (): undefined => undefined, {
      label: 'legacy',
    })
    await harness.hooksBus.declare([
      {
        event: 'SessionStart',
        handler: (): undefined => undefined,
        label: 'legacy-decl',
      },
    ])
    const state = harness.hooksBus.state() as StateLike
    expect(state.subscriptions).toMatchObject([
      {
        source: 'runtime',
        label: 'legacy',
        owner: {},
      },
      {
        source: 'declarative',
        label: 'legacy-decl',
        owner: {},
      },
    ])
    await harness.dispose()
  })

  it('does not guess a package for runtime on() subscriptions', async () => {
    const harness = await createPluginHarness()
    harness.hooksBus.on('PreToolUse', (): undefined => undefined, {
      label: 'runtime-owned',
      owner: { packageName: 'self-reported-runtime', packageVersion: '0.0.0' },
    })
    const state = harness.hooksBus.state() as StateLike
    expect(state.subscriptions[0]?.owner).toStrictEqual({
      packageName: 'self-reported-runtime',
      packageVersion: '0.0.0',
    })
    expect(state.subscriptions[0]?.owner).not.toHaveProperty('handlerRef')
    await harness.dispose()
  })

  it('never leaks an absolute handler path through the state API', async () => {
    const secretPath = String.raw`C:\Users\secret-user\plugin\hooks\guard.js`
    const harness = await createPluginHarness()
    await harness.hooksBus.declare([
      {
        event: 'PreToolUse',
        handler: (): undefined => undefined,
        owner: { packageName: 'guarded', handlerRef: secretPath },
      },
    ])
    const serialized = JSON.stringify(harness.hooksBus.state())
    expect(serialized).not.toContain(secretPath)
    expect(serialized).not.toContain('secret-user')
    const state = harness.hooksBus.state() as StateLike
    expect(state.subscriptions[0]?.owner.handlerRef).toBe(EXTERNAL_HANDLER_REF)
    await harness.dispose()
  })

  it('rejects an invalid declarative batch without leaving partial subscriptions', async () => {
    const harness = await createPluginHarness()
    await expect(
      harness.hooksBus.declare([
        {
          event: 'PreToolUse',
          handler: (): undefined => undefined,
          label: 'would-have-been-added',
          owner: { packageName: 'partial', handlerRef: 'hooks/a.js' },
        },
        // @ts-expect-error - unknown event on purpose, validated at runtime
        { event: 'NotAnEvent', handler: (): undefined => undefined },
      ]),
    ).rejects.toThrow(/unknown hooks-bus event/)
    const state = harness.hooksBus.state() as StateLike
    expect(state.subscriptions).toStrictEqual([])
    await harness.dispose()
  })
})

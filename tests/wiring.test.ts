import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ContentBlockLike, MessageLike } from '#src/catalog'

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

function userMessage(text: string): MessageLike {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function systemMessage(text: string): MessageLike {
  return { role: 'system', content: [{ type: 'text', text }] }
}

const execFixture = {
  callId: 'call-1',
  name: 'pwsh',
  arguments: { command: 'ls' },
  agent: { id: 's9' },
}

const resultFixture = { isError: false, value: { ok: true }, content: [] }

const allowNext = (): { kind: string } => ({ kind: 'allow' })
const acceptNext = (): { kind: string } => ({ kind: 'accept' })

let harness: PluginHarness

beforeEach(async () => {
  harness = await createPluginHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe('wiring: SessionStart via agent/created', () => {
  it('dispatches observe-only events with agent id and source', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('SessionStart', (event) => {
      seen.push(event)
    })
    ;(harness.ctx as unknown as EmitCtx).emit('agent/created', {
      agent: { id: 's1' },
      source: 'resume',
    })
    await flush()
    expect(seen).toStrictEqual([
      { sessionId: 's1', source: 'resume', workspacePath: undefined },
    ])
  })
})

describe('wiring: UserPromptSubmit via agent/pre-step', () => {
  it('blocks with reject when a subscriber returns block', async () => {
    harness.hooksBus.on('UserPromptSubmit', (event) => {
      expect(event.text).toBe('hello')
      return { action: 'block', reason: 'not now' }
    })
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'agent/pre-step',
      {
        agent: { id: 's2' },
        messages: [userMessage('hello')],
        turn: 1,
        step: 1,
      },
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'reject' })
  })

  it('replaces the batch when a subscriber returns modify', async () => {
    const replacement = [systemMessage('replaced')]
    harness.hooksBus.on('UserPromptSubmit', () => ({
      action: 'modify',
      messages: replacement,
    }))
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'agent/pre-step',
      {
        agent: { id: 's2' },
        messages: [userMessage('hello')],
        turn: 1,
        step: 1,
      },
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'enter', messages: replacement })
  })

  it('skips the bus entirely for batches without user messages', async () => {
    let called = false
    harness.hooksBus.on('UserPromptSubmit', () => {
      called = true
    })
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'agent/pre-step',
      {
        agent: { id: 's2' },
        messages: [systemMessage('context only')],
        turn: 1,
        step: 1,
      },
      allowNext,
    )
    expect(called).toBeFalsy()
    expect(result).toStrictEqual({ kind: 'allow' })
  })

  it('contains a throwing subscriber and still allows the step', async () => {
    harness.hooksBus.on('UserPromptSubmit', () => {
      throw new Error('bad subscriber')
    })
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'agent/pre-step',
      {
        agent: { id: 's2' },
        messages: [userMessage('hello')],
        turn: 1,
        step: 1,
      },
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'allow' })
    expect(harness.hooksBus.logs()[0]?.subscribers[0]?.status).toBe('error')
  })
})

describe('wiring: PreToolUse via tools/pre-execute', () => {
  it('translates block into deny with reason', async () => {
    harness.hooksBus.on('PreToolUse', (event) => {
      expect(event.toolName).toBe('pwsh')
      expect(event.args).toStrictEqual({ command: 'ls' })
      return { action: 'block', reason: 'dangerous' }
    })
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'deny', reason: 'dangerous' })
  })

  it('translates cancel and ask, and passes through by default', async () => {
    harness.hooksBus.on('PreToolUse', () => ({ action: 'cancel' }))
    const cancelled = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(cancelled).toStrictEqual({ kind: 'cancel' })

    await harness.dispose()
    harness = await createPluginHarness()
    harness.hooksBus.on('PreToolUse', () => ({
      action: 'ask',
      reason: 'sure?',
    }))
    const asked = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(asked).toStrictEqual({ kind: 'ask', reason: 'sure?' })

    await harness.dispose()
    harness = await createPluginHarness()
    const passthrough = await (
      harness.ctx as unknown as WaterfallCtx
    ).waterfall('tools/pre-execute', execFixture, allowNext)
    expect(passthrough).toStrictEqual({ kind: 'allow' })
  })
})

describe('wiring: PostToolUse via tools/post-execute', () => {
  it('translates block into block with text feedback', async () => {
    harness.hooksBus.on('PostToolUse', (event) => {
      expect(event.callId).toBe('call-1')
      return { action: 'block', reason: 'result redacted' }
    })
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/post-execute',
      execFixture,
      resultFixture,
      acceptNext,
    )
    expect(result).toStrictEqual({
      kind: 'block',
      feedback: [{ type: 'text', text: 'result redacted' }],
    })
  })

  it('translates modifyValue into accept with the new value', async () => {
    harness.hooksBus.on('PostToolUse', () => ({
      action: 'modifyValue',
      value: { replaced: true },
    }))
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/post-execute',
      execFixture,
      resultFixture,
      acceptNext,
    )
    expect(result).toStrictEqual({ kind: 'accept', value: { replaced: true } })
  })

  it('translates modifyContent into accept with new content blocks', async () => {
    const content: ContentBlockLike[] = [{ type: 'text', text: 'friendly' }]
    harness.hooksBus.on('PostToolUse', () => ({
      action: 'modifyContent',
      content,
    }))
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/post-execute',
      execFixture,
      resultFixture,
      acceptNext,
    )
    expect(result).toStrictEqual({ kind: 'accept', content })
  })
})

describe('wiring: TurnEnd via agent/turn-stopping', () => {
  it('dispatches turn end with buffered assistant text and usage', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('TurnEnd', (event) => {
      seen.push(event)
    })
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit(
      'session/event',
      { id: 's3' },
      {
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'final answer' }],
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    )
    await flush()
    ctx.emit('agent/turn-stopping', { agent: { id: 's3' }, turn: 2 })
    await flush()
    expect(seen).toStrictEqual([
      {
        sessionId: 's3',
        turnIndex: 2,
        text: 'final answer',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ])
  })
})

describe('wiring: SessionEnd / TurnStart / Compaction / Error', () => {
  it('dispatches SessionEnd with counted messages and a duration', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('SessionEnd', (event) => {
      seen.push(event)
    })
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit('agent/created', { agent: { id: 's4' }, source: 'startup' })
    ctx.emit('session/event', { id: 's4' }, { type: 'user/message', data: {} })
    ctx.emit('session/event', { id: 's4' }, { type: 'user/message', data: {} })
    await flush()
    ctx.emit('agent/disposed', { agent: { id: 's4' } })
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionId: 's4', messageCount: 2 })
    expect((seen[0] as { durationMs: number }).durationMs).toBeTypeOf('number')
  })

  it('dispatches TurnStart with the model from request/header', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('TurnStart', (event) => {
      seen.push(event)
    })
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit('agent/created', { agent: { id: 's5' }, source: 'startup' })
    ctx.emit(
      'session/event',
      { id: 's5' },
      {
        type: 'request/header',
        data: { header: { config: { model: 'deepseek-chat' } } },
      },
    )
    ctx.emit(
      'session/event',
      { id: 's5' },
      { type: 'turn/start', data: { turn: 3 } },
    )
    await flush()
    expect(seen).toStrictEqual([
      { sessionId: 's5', turnIndex: 3, model: 'deepseek-chat' },
    ])
  })

  it('dispatches Compaction phases with curated fields', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('Compaction', (event) => {
      seen.push(event)
    })
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit(
      'session/event',
      { id: 's6' },
      {
        type: 'compaction/start',
        data: { compactionId: 'c1', turn: null },
      },
    )
    ctx.emit(
      'session/event',
      { id: 's6' },
      {
        type: 'compaction/summary',
        data: { compactionId: 'c1', turn: null, shadowedTokenCount: 1234 },
      },
    )
    ctx.emit(
      'session/event',
      { id: 's6' },
      {
        type: 'compaction/end',
        data: { compactionId: 'c1', turn: null, error: 'boom' },
      },
    )
    await flush()
    expect(
      seen.map((entry) => (entry as { phase: string }).phase),
    ).toStrictEqual(['start', 'summary', 'end'])
    expect((seen[1] as { shadowedTokenCount: number }).shadowedTokenCount).toBe(
      1234,
    )
    expect((seen[2] as { error: string }).error).toBe('boom')
  })

  it('dispatches Error from agent/error and api-session/error', async () => {
    const seen: unknown[] = []
    harness.hooksBus.on('Error', (event) => {
      seen.push(event)
    })
    const ctx = harness.ctx as unknown as EmitCtx
    ctx.emit('agent/error', {
      agent: { id: 's7' },
      turn: 1,
      step: 2,
      error: new Error('kaboom'),
    })
    ctx.emit('api-session/error', 's8', 'session exploded')
    await flush()
    expect(seen).toMatchObject([
      { sessionId: 's7', errorType: 'Error', message: 'kaboom' },
      {
        sessionId: 's8',
        errorType: 'api-session',
        message: 'session exploded',
      },
    ])
  })
})

describe('declarative subscriptions and pause', () => {
  it('registers declarative lists and rejects unknown events with legal names', async () => {
    const dispose = await harness.hooksBus.declare([
      {
        event: 'PreToolUse',
        handler: (): { action: 'allow' } => ({ action: 'allow' }),
        label: 'guard-demo',
        priority: 10,
      },
    ])
    const state = harness.hooksBus.state() as {
      subscriptions: { label: string; source: string }[]
    }
    expect(state.subscriptions).toMatchObject([
      { label: 'guard-demo', source: 'declarative' },
    ])
    dispose()
    await expect(
      harness.hooksBus.declare([
        // @ts-expect-error - unknown event on purpose, validated at runtime
        { event: 'PreToolUs', handler: (): void => {} },
      ]),
    ).rejects.toThrow(/legal events: .*PreToolUse/s)
  })

  it('resolves declarative handler module paths against baseUrl', async () => {
    const dispose = await harness.hooksBus.declare(
      [
        {
          event: 'PreToolUse',
          handler: './fixtures/declarative-handler.ts',
          label: 'from-file',
        },
      ],
      { baseUrl: new URL('.', import.meta.url).href },
    )
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'ask' })
    dispose()
  })

  it('pausing one subscription removes it from the dispatch chain', async () => {
    harness.hooksBus.on(
      'PreToolUse',
      () => ({ action: 'block', reason: 'a' }),
      {
        label: 'a',
      },
    )
    harness.hooksBus.on('PreToolUse', () => ({ action: 'ask' }), { label: 'b' })
    const state = harness.hooksBus.state() as {
      subscriptions: { id: number; label: string }[]
    }
    const id = state.subscriptions.find((entry) => entry.label === 'a')?.id
    expect(id).toBeTypeOf('number')
    if (id === undefined) {
      throw new Error('subscription "a" not found in state')
    }
    expect(harness.hooksBus.setSubscriptionPaused(id, true)).toBeTruthy()
    const result = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(result).toStrictEqual({ kind: 'ask' })
  })

  it('global pause passes every event through untouched, zero decision effect', async () => {
    harness.hooksBus.on('PreToolUse', () => ({ action: 'block', reason: 'x' }))
    harness.hooksBus.setPaused(true)
    const whilePaused = await (
      harness.ctx as unknown as WaterfallCtx
    ).waterfall('tools/pre-execute', execFixture, allowNext)
    expect(whilePaused).toStrictEqual({ kind: 'allow' })
    harness.hooksBus.setPaused(false)
    const resumed = await (harness.ctx as unknown as WaterfallCtx).waterfall(
      'tools/pre-execute',
      execFixture,
      allowNext,
    )
    expect(resumed).toStrictEqual({ kind: 'deny', reason: 'x' })
  })
})

describe('service surface', () => {
  it('exposes catalog, version, stats, and logs', () => {
    expect(harness.hooksBus.catalogVersion()).toBe('1.1.0')
    expect(Object.keys(harness.hooksBus.catalog())).toStrictEqual([
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'TurnStart',
      'PreToolUse',
      'PostToolUse',
      'TurnEnd',
      'Compaction',
      'Error',
    ])
    expect(harness.hooksBus.stats().PreToolUse.count).toBe(0)
    expect(harness.hooksBus.logs()).toStrictEqual([])
  })
})

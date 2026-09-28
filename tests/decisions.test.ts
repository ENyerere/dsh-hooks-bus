import { describe, expect, it } from 'vitest'

import type { MessageLike } from '#src/catalog'
import { mergeDecisions } from '#src/decisions'
import type { MergeInput } from '#src/decisions'

function ok(
  subscriptionId: number,
  decision: unknown,
  priority = 0,
): MergeInput {
  return { subscriptionId, priority, status: 'ok', decision }
}

function failed(subscriptionId: number, priority = 0): MergeInput {
  return { subscriptionId, priority, status: 'error', decision: undefined }
}

describe('mergeDecisions: UserPromptSubmit', () => {
  it('any block wins over allow and modify', () => {
    const result = mergeDecisions('UserPromptSubmit', [
      ok(1, { action: 'allow' }, 10),
      ok(2, { action: 'block', reason: 'stop' }),
    ])
    expect(result.merged).toStrictEqual({ kind: 'reject' })
    expect(result.warnings).toStrictEqual([])
  })

  it('highest-priority modify wins when nobody blocks', () => {
    const first: MessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'rewritten' }] },
    ]
    const second: MessageLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'loser' }] },
    ]
    const result = mergeDecisions('UserPromptSubmit', [
      ok(1, { action: 'modify', messages: first }, 100),
      ok(2, { action: 'modify', messages: second }, 50),
    ])
    expect(result.merged).toStrictEqual({ kind: 'enter', messages: first })
  })

  it('treats invalid decisions as allow with warnings', () => {
    const result = mergeDecisions('UserPromptSubmit', [
      ok(1, { action: 'block' }),
      ok(2, { action: 'explode' }),
      ok(3, 'not-an-object'),
      ok(4, { action: 'allow' }, 10),
    ])
    expect(result.merged).toStrictEqual({ kind: 'passthrough' })
    expect(
      result.warnings.map((warning) => warning.subscriptionId),
    ).toStrictEqual([1, 2, 3])
  })

  it('ignores failed or timed-out subscribers', () => {
    const result = mergeDecisions('UserPromptSubmit', [
      failed(1, 100),
      ok(2, { action: 'block', reason: 'x' }, 1),
    ])
    expect(result.merged).toStrictEqual({ kind: 'reject' })
  })
})

describe('mergeDecisions: PreToolUse', () => {
  it('folds block > ask > cancel > allow', () => {
    const inputs = [
      ok(1, { action: 'block', reason: 'blocker' }),
      ok(2, { action: 'ask', reason: 'are you sure' }),
      ok(3, { action: 'cancel' }),
      ok(4, { action: 'allow' }, 100),
    ]
    expect(mergeDecisions('PreToolUse', inputs).merged).toStrictEqual({
      kind: 'deny',
      reason: 'blocker',
    })
    expect(mergeDecisions('PreToolUse', inputs.slice(1)).merged).toStrictEqual({
      kind: 'ask',
      reason: 'are you sure',
    })
    expect(mergeDecisions('PreToolUse', inputs.slice(2)).merged).toStrictEqual({
      kind: 'cancel',
    })
    expect(mergeDecisions('PreToolUse', inputs.slice(3)).merged).toStrictEqual({
      kind: 'passthrough',
    })
  })

  it('prefers ask over cancel regardless of priority (rank fold)', () => {
    const result = mergeDecisions('PreToolUse', [
      ok(1, { action: 'cancel' }, 100),
      ok(2, { action: 'ask', reason: 'confirm?' }, 1),
    ])
    expect(result.merged).toStrictEqual({ kind: 'ask', reason: 'confirm?' })
  })

  it('keeps the highest-priority decision on ties', () => {
    const result = mergeDecisions('PreToolUse', [
      ok(1, { action: 'block', reason: 'first' }, 100),
      ok(2, { action: 'block', reason: 'second' }, 50),
    ])
    expect(result.merged).toStrictEqual({ kind: 'deny', reason: 'first' })
  })
})

describe('mergeDecisions: PostToolUse', () => {
  it('any block wins and becomes text feedback', () => {
    const result = mergeDecisions('PostToolUse', [
      ok(1, { action: 'modifyValue', value: { ok: true } }, 100),
      ok(2, { action: 'block', reason: 'redacted' }, 1),
    ])
    expect(result.merged).toStrictEqual({
      kind: 'blockFeedback',
      feedback: [{ type: 'text', text: 'redacted' }],
    })
  })

  it('prefers modifyValue over modifyContent, then highest priority', () => {
    const valueResult = mergeDecisions('PostToolUse', [
      ok(
        1,
        { action: 'modifyContent', content: [{ type: 'text', text: 'c1' }] },
        100,
      ),
      ok(2, { action: 'modifyValue', value: { v: 2 } }, 50),
    ])
    expect(valueResult.merged).toStrictEqual({
      kind: 'acceptValue',
      value: { v: 2 },
    })

    const contentResult = mergeDecisions('PostToolUse', [
      ok(
        1,
        { action: 'modifyContent', content: [{ type: 'text', text: 'c1' }] },
        100,
      ),
      ok(
        2,
        { action: 'modifyContent', content: [{ type: 'text', text: 'c2' }] },
        50,
      ),
    ])
    expect(contentResult.merged).toStrictEqual({
      kind: 'acceptContent',
      content: [{ type: 'text', text: 'c1' }],
    })
  })
})

describe('mergeDecisions: observe-only events', () => {
  it('ignores subscriber returns entirely', () => {
    const result = mergeDecisions('SessionStart', [
      ok(1, { action: 'block', reason: 'nope' }, 100),
    ])
    expect(result.merged).toStrictEqual({ kind: 'passthrough' })
    expect(result.warnings).toStrictEqual([])
  })
})

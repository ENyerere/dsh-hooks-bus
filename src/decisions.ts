/**
 * Decision merging and translation into official Decision shapes.
 *
 * The bus is one listener on each official waterfall. Subscriber decisions are
 * merged inside the bus, then the wiring layer translates the merged outcome
 * into the official Decision union: - `UserPromptSubmit` → `agent/pre-step`:
 * reject / enter{messages} - `PreToolUse` → `tools/pre-execute`: deny{reason} /
 * cancel / ask{reason} - `PostToolUse` → `tools/post-execute`: block{feedback}
 * / accept{value|content} Invalid decisions are treated as allow and reported
 * as warnings.
 *
 * @module dsh-hooks-bus/decisions
 */

import type {
  CatalogEventName,
  ContentBlockLike,
  HooksBusDecision,
  MessageLike,
} from './catalog.ts'
import type { SubscriberStatus } from './logger.ts'

export type MergedDecision =
  | { kind: 'passthrough' }
  | { kind: 'reject' }
  | { kind: 'enter'; messages: readonly MessageLike[] }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason: string | undefined }
  | { kind: 'blockFeedback'; feedback: ContentBlockLike[] }
  | { kind: 'acceptValue'; value: unknown }
  | { kind: 'acceptContent'; content: readonly ContentBlockLike[] }

export interface MergeInput {
  subscriptionId: number
  priority: number
  status: SubscriberStatus
  decision: unknown
}

export interface WarningNote {
  subscriptionId: number
  message: string
}

export interface MergeResult {
  merged: MergedDecision
  warnings: readonly WarningNote[]
}

interface Normalized {
  subscriptionId: number
  status: SubscriberStatus
  decision: HooksBusDecision | undefined
}

const PROMPT_ACTIONS = new Set(['allow', 'block', 'modify'])
const PRETOOL_ACTIONS = new Set(['allow', 'block', 'cancel', 'ask'])
const POSTTOOL_ACTIONS = new Set([
  'allow',
  'block',
  'modifyValue',
  'modifyContent',
])

/** PreToolUse fold: block > ask > cancel > allow (most restrictive first). */
const PRETOOL_RANK: Readonly<
  Record<'allow' | 'block' | 'cancel' | 'ask', number>
> = {
  allow: 0,
  cancel: 1,
  ask: 2,
  block: 3,
}

export function mergeDecisions(
  event: CatalogEventName,
  inputs: readonly MergeInput[],
): MergeResult {
  const warnings: WarningNote[] = []
  const normalized: Normalized[] = inputs.map((input) => ({
    subscriptionId: input.subscriptionId,
    status: input.status,
    decision: normalize(event, input, warnings),
  }))
  if (event === 'UserPromptSubmit') {
    return mergePrompt(normalized, warnings)
  }
  if (event === 'PreToolUse') {
    return mergePreTool(normalized, warnings)
  }
  if (event === 'PostToolUse') {
    return mergePostTool(normalized, warnings)
  }
  // Observe-only events ignore subscriber returns entirely.
  return { merged: { kind: 'passthrough' }, warnings }
}

function normalize(
  event: CatalogEventName,
  input: MergeInput,
  warnings: WarningNote[],
): HooksBusDecision | undefined {
  if (
    input.status !== 'ok'
    || input.decision === undefined
    || input.decision === null
  ) {
    return undefined
  }
  const allowed = actionSetFor(event)
  if (allowed === undefined) {
    return undefined
  }
  if (typeof input.decision !== 'object') {
    invalid(input, 'decision must be an object; treated as allow', warnings)
    return undefined
  }
  const decision = input.decision as {
    action?: unknown
    reason?: unknown
    messages?: unknown
    value?: unknown
    content?: unknown
  }
  const { action } = decision
  if (typeof action !== 'string' || !allowed.has(action)) {
    invalid(
      input,
      `unknown action "${String(action)}"; treated as allow`,
      warnings,
    )
    return undefined
  }
  if (action === 'block') {
    if (typeof decision.reason !== 'string' || decision.reason.trim() === '') {
      invalid(
        input,
        'block requires a non-empty string reason; treated as allow',
        warnings,
      )
      return undefined
    }
    return { action: 'block', reason: decision.reason }
  }
  if (action === 'modify') {
    if (!Array.isArray(decision.messages)) {
      invalid(
        input,
        'modify requires a messages array; treated as allow',
        warnings,
      )
      return undefined
    }
    return {
      action: 'modify',
      messages: decision.messages as readonly MessageLike[],
    }
  }
  if (action === 'modifyValue') {
    if (!('value' in decision)) {
      invalid(
        input,
        'modifyValue requires a value field; treated as allow',
        warnings,
      )
      return undefined
    }
    return { action: 'modifyValue', value: decision.value }
  }
  if (action === 'modifyContent') {
    if (!Array.isArray(decision.content)) {
      invalid(
        input,
        'modifyContent requires a content array; treated as allow',
        warnings,
      )
      return undefined
    }
    return {
      action: 'modifyContent',
      content: decision.content as readonly ContentBlockLike[],
    }
  }
  if (action === 'ask') {
    if (decision.reason !== undefined && typeof decision.reason !== 'string') {
      invalid(input, 'ask reason must be a string; treated as allow', warnings)
      return undefined
    }
    return {
      action: 'ask',
      ...(typeof decision.reason === 'string'
        ? { reason: decision.reason }
        : {}),
    }
  }
  return { action: action as 'allow' | 'cancel' }
}

function invalid(
  input: MergeInput,
  message: string,
  warnings: WarningNote[],
): void {
  warnings.push({ subscriptionId: input.subscriptionId, message })
}

function actionSetFor(
  event: CatalogEventName,
): ReadonlySet<string> | undefined {
  if (event === 'UserPromptSubmit') {
    return PROMPT_ACTIONS
  }
  if (event === 'PreToolUse') {
    return PRETOOL_ACTIONS
  }
  if (event === 'PostToolUse') {
    return POSTTOOL_ACTIONS
  }
  return undefined
}

function mergePrompt(
  normalized: readonly Normalized[],
  warnings: readonly WarningNote[],
): MergeResult {
  let blocked = false
  let modify: { messages: readonly MessageLike[] } | undefined
  for (const input of normalized) {
    const { decision } = input
    if (decision === undefined) {
      continue
    }
    if (decision.action === 'block') {
      blocked = true
    } else if (decision.action === 'modify' && modify === undefined) {
      modify = { messages: decision.messages }
    }
  }
  if (blocked) {
    return { merged: { kind: 'reject' }, warnings }
  }
  if (modify !== undefined) {
    return { merged: { kind: 'enter', messages: modify.messages }, warnings }
  }
  return { merged: { kind: 'passthrough' }, warnings }
}

function mergePreTool(
  normalized: readonly Normalized[],
  warnings: readonly WarningNote[],
): MergeResult {
  let best: 'allow' | 'block' | 'cancel' | 'ask' = 'allow'
  let blockReason = ''
  let askReason: string | undefined
  for (const input of normalized) {
    const { decision } = input
    if (decision === undefined || decision.action === 'allow') {
      continue
    }
    if (
      decision.action === 'block'
      && PRETOOL_RANK.block > PRETOOL_RANK[best]
    ) {
      best = 'block'
      blockReason = decision.reason
    } else if (
      decision.action === 'cancel'
      && PRETOOL_RANK.cancel > PRETOOL_RANK[best]
    ) {
      best = 'cancel'
    } else if (
      decision.action === 'ask'
      && PRETOOL_RANK.ask > PRETOOL_RANK[best]
    ) {
      best = 'ask'
      askReason = decision.reason
    }
  }
  if (best === 'block') {
    return { merged: { kind: 'deny', reason: blockReason }, warnings }
  }
  if (best === 'cancel') {
    return { merged: { kind: 'cancel' }, warnings }
  }
  if (best === 'ask') {
    return { merged: { kind: 'ask', reason: askReason }, warnings }
  }
  return { merged: { kind: 'passthrough' }, warnings }
}

function mergePostTool(
  normalized: readonly Normalized[],
  warnings: readonly WarningNote[],
): MergeResult {
  let blocked = false
  let blockReason = ''
  let valueModify: { value: unknown } | undefined
  let contentModify: { content: readonly ContentBlockLike[] } | undefined
  for (const input of normalized) {
    const { decision } = input
    if (decision === undefined) {
      continue
    }
    if (decision.action === 'block') {
      blocked = true
      if (blockReason === '') {
        blockReason = decision.reason
      }
    } else if (decision.action === 'modifyValue' && valueModify === undefined) {
      valueModify = { value: decision.value }
    } else if (
      decision.action === 'modifyContent'
      && contentModify === undefined
    ) {
      contentModify = { content: decision.content }
    }
  }
  if (blocked) {
    return {
      merged: {
        kind: 'blockFeedback',
        feedback: [{ type: 'text', text: blockReason }],
      },
      warnings,
    }
  }
  if (valueModify !== undefined) {
    return {
      merged: { kind: 'acceptValue', value: valueModify.value },
      warnings,
    }
  }
  if (contentModify !== undefined) {
    return {
      merged: { kind: 'acceptContent', content: contentModify.content },
      warnings,
    }
  }
  return { merged: { kind: 'passthrough' }, warnings }
}

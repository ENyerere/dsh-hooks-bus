/**
 * Adapters for the official lifecycle events.
 *
 * The official event contracts are declared by host packages
 * (`@deepseek-ai/dsh-*`), which this package deliberately does not depend on.
 * This module carries the minimal structural payload shapes the bus reads and
 * the pure payload builders used by the wiring layer. Anything the host evolves
 * must remain assignable to these shapes; the wiring layer treats them
 * defensively (never throws).
 *
 * @module dsh-hooks-bus/adapters
 */

import type { Context } from 'cordis'

import type {
  ContentBlockLike,
  MessageLike,
  PromptAttachment,
  SessionStartSource,
  UserPromptSubmitEvent,
} from './catalog.ts'
import type { TimerLike } from './dispatcher.ts'

/** Host-facing behavior used by the service, fakeable in tests. */
export interface PluginRuntime {
  timer: TimerLike
  /** Best-effort workspace directory of a live session. */
  sessionCwd(sessionId: string | undefined): string | undefined
}

/**
 * Create the production runtime adapter from a scoped Cordis context.
 *
 * @param ctx - Scoped plugin context.
 * @returns Host behavior used by the plugin implementation.
 */
export function createPluginRuntime(ctx: Context): PluginRuntime {
  const lookup = ctx as Context & {
    get: (name: string, strict?: boolean) => unknown
  }
  const timer =
    (lookup.get('timer', false) as TimerLike | undefined) ?? fallbackTimer()
  return {
    timer,
    sessionCwd(sessionId: string | undefined): string | undefined {
      if (sessionId === undefined) {
        return undefined
      }
      try {
        return (lookup.get('sessions') as SessionStoreLike | undefined)?.get(
          sessionId,
        )?.header?.cwd
      } catch {
        return undefined
      }
    },
  }
}

/** Structural stand-in for `ctx.on` without host event declarations. */
export interface RawEventBus {
  on(name: string, listener: (...args: unknown[]) => unknown): unknown
}

export interface SessionStoreLike {
  get(id: string): { header?: { cwd?: string } } | undefined
}

export interface AgentCreatedPayload {
  agent?: { id?: unknown }
  source?: unknown
}

export interface PreStepPayload {
  agent?: { id?: unknown }
  messages?: readonly unknown[]
  turn?: unknown
  step?: unknown
  signal?: unknown
}

export interface PreStepDecisionLike {
  kind: string
  messages?: readonly unknown[]
}

export interface ToolExecLike {
  callId?: unknown
  name?: unknown
  arguments?: unknown
  agent?: { id?: unknown }
  signal?: unknown
}

export interface PreToolDecisionLike {
  kind: string
  reason?: string
}

export interface PostToolResultLike {
  isError?: unknown
  error?: unknown
}

export interface PostToolDecisionLike {
  kind: string
  feedback?: readonly unknown[]
  value?: unknown
  content?: readonly unknown[]
}

export interface TurnStoppingPayload {
  agent?: { id?: unknown }
  turn?: unknown
}

export interface AgentDisposedPayload {
  agent?: { id?: unknown }
}

export interface AgentErrorPayload {
  agent?: { id?: unknown }
  error?: unknown
}

export interface SessionEventLike {
  type?: unknown
  data?: unknown
}

/** Best-effort error type: LlmFailure code, Error name, or JS type. */
export function describeErrorType(error: unknown): string {
  if (error === null || error === undefined) {
    return 'unknown'
  }
  if (
    typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code
  }
  if (error instanceof Error) {
    return error.name
  }
  return typeof error
}

/** Symbol-safe error message extraction. */
export function describeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/** Timer based on `setTimeout`, used when the host exposes no timer service. */
export function fallbackTimer(): TimerLike {
  return {
    timeout(callback: () => void, delay: number): () => void {
      const handle = setTimeout(callback, delay)
      return () => {
        clearTimeout(handle)
      }
    },
  }
}

/** Use the candidate when it is callable, otherwise the fallback. */
export function asNext<T>(candidate: unknown, fallback: T): T {
  return typeof candidate === 'function' ? (candidate as T) : fallback
}

export function buildPromptEvent(
  payload: PreStepPayload,
  messages: readonly MessageLike[],
): UserPromptSubmitEvent {
  const texts: string[] = []
  const attachments: PromptAttachment[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    collectPromptContent(message.content, texts, attachments)
  }
  return {
    sessionId: payload.agent?.id as string | undefined,
    turn: payload.turn as number,
    step: payload.step as number,
    text: texts.join('\n'),
    attachments,
    messages,
    signal: payload.signal as AbortSignal | undefined,
  }
}

function collectPromptContent(
  content: readonly ContentBlockLike[] | string | undefined,
  texts: string[],
  attachments: PromptAttachment[],
): void {
  if (typeof content === 'string') {
    texts.push(content)
    return
  }
  if (!Array.isArray(content)) {
    return
  }
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block?.type === 'image' && block.attachment !== undefined) {
      attachments.push({ kind: 'image', attachment: block.attachment })
    } else if (block?.type === 'file' && block.attachment !== undefined) {
      attachments.push({ kind: 'file', attachment: block.attachment })
    }
  }
}

export function extractText(
  content: readonly ContentBlockLike[] | string | undefined,
): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

export function normalizeSource(source: unknown): SessionStartSource {
  return source === 'startup'
    || source === 'resume'
    || source === 'clear'
    || source === 'compact'
    ? source
    : 'startup'
}

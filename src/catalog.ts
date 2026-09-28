/**
 * Versioned event catalog for dsh-hooks-bus.
 *
 * The catalog wraps the official lifecycle events (verified against the live
 * runtime via `cordis_inspect`): each entry records the official event name,
 * its dispatch mode, and whether subscribers may influence the outcome. Payload
 * shapes follow the P7 task book v1.1 catalog table.
 *
 * @module dsh-hooks-bus/catalog
 */

/**
 * Catalog version (semver). Bump minor for additive events, major for breaking
 * payload changes.
 */
export const CATALOG_VERSION = '1.1.0'

/**
 * Structural stand-in for the host's content blocks (text/image/file/…).
 * Official blocks are assignable to this shape; the bus never constructs them
 * except for `block` feedback on PostToolUse, which is a plain text block.
 */
export interface ContentBlockLike {
  type?: string
  text?: string
  attachment?: unknown
  [key: string]: unknown
}

/**
 * Structural stand-in for the host's message objects (`UserMessage` and
 * friends). A `modify` decision on `UserPromptSubmit` replaces the official
 * step batch wholesale, so subscribers work with the objects they received.
 */
export interface MessageLike {
  role?: string
  content?: readonly ContentBlockLike[] | string
  [key: string]: unknown
}

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

export interface SessionStartEvent {
  sessionId: string
  source: SessionStartSource
  workspacePath: string | undefined
}

export interface PromptAttachment {
  kind: 'file' | 'image'
  attachment: unknown
}

export interface UserPromptSubmitEvent {
  sessionId: string | undefined
  turn: number
  step: number
  /** Concatenated text of the user-role messages in the step batch. */
  text: string
  attachments: readonly PromptAttachment[]
  /** The official step message batch; a `modify` decision replaces it wholesale. */
  messages: readonly MessageLike[]
  signal: AbortSignal | undefined
}

export interface PreToolUseEvent {
  sessionId: string | undefined
  toolName: string
  args: unknown
  callId: string
  signal: AbortSignal | undefined
}

export interface PostToolUseEvent {
  sessionId: string | undefined
  toolName: string
  args: unknown
  /** The normalized official dispatch result (success or failure). */
  result: unknown
  /** The official failure payload when the result is an error, else undefined. */
  error: unknown
  durationMs: number | undefined
  callId: string
  signal: AbortSignal | undefined
}

export interface TurnEndEvent {
  sessionId: string | undefined
  turnIndex: number
  /**
   * Best-effort assistant text of the closing turn (buffered from the session
   * log).
   */
  text: string | undefined
  usage: TurnEndUsage | undefined
}

export interface TurnEndUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
}

export interface SessionEndEvent {
  sessionId: string
  /** User-authored messages counted from the durable session log. */
  messageCount: number
  /** Milliseconds since the session started (best-effort from agent/created). */
  durationMs: number | undefined
}

export interface TurnStartEvent {
  sessionId: string
  turnIndex: number
  /** Best-effort model name buffered from the last durable request/header. */
  model: string | undefined
}

export type CompactionPhase = 'start' | 'summary' | 'end' | 'prune'

export interface CompactionEvent {
  sessionId: string
  phase: CompactionPhase
  /** Official field: the turn it belongs to, or null for turn-less compactions. */
  turn: number | null
  compactionId: string | undefined
  shadowedTokenCount: number | undefined
  /** Official `error` field on a failed compaction end. */
  error: string | undefined
  /** Raw official data record, passed through defensively. */
  data: unknown
}

export interface ErrorEvent {
  sessionId: string | undefined
  /** Best-effort error type: LlmFailure code, Error name, or JS type. */
  errorType: string
  message: string
}

export interface HooksBusEventMap {
  SessionStart: SessionStartEvent
  SessionEnd: SessionEndEvent
  UserPromptSubmit: UserPromptSubmitEvent
  TurnStart: TurnStartEvent
  PreToolUse: PreToolUseEvent
  PostToolUse: PostToolUseEvent
  TurnEnd: TurnEndEvent
  Compaction: CompactionEvent
  Error: ErrorEvent
}

export type CatalogEventName = keyof HooksBusEventMap

/**
 * A subscriber decision. Per-event validity is enforced by the merger: -
 * `UserPromptSubmit`: allow / block / modify - `PreToolUse`: allow / block /
 * cancel / ask - `PostToolUse`: allow / block / modifyValue / modifyContent -
 * observe-only events ignore return values.
 */
export type HooksBusDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'cancel' }
  | { action: 'ask'; reason?: string }
  | { action: 'modify'; messages: readonly MessageLike[] }
  | { action: 'modifyValue'; value: unknown }
  | { action: 'modifyContent'; content: readonly ContentBlockLike[] }

export type HooksBusHandler<E extends CatalogEventName = CatalogEventName> = (
  event: HooksBusEventMap[E],
) => HooksBusDecision | void | Promise<HooksBusDecision | void>

export interface CatalogEntry {
  /** Official event this catalog entry wraps. */
  official: string
  /** Dispatch mode of the official event. */
  officialMode: 'emit' | 'parallel' | 'serial' | 'waterfall'
  /** Whether subscribers can influence the outcome (block / ask / modify). */
  interceptable: boolean
  description: string
}

export const CATALOG: Readonly<Record<CatalogEventName, CatalogEntry>> = {
  SessionStart: {
    official: 'agent/created',
    officialMode: 'serial',
    interceptable: false,
    description:
      'Session creation/load; official semantics forbid blocking startup (inject-only).',
  },
  SessionEnd: {
    official: 'agent/disposed',
    officialMode: 'emit',
    interceptable: false,
    description:
      'Session closed; messageCount is counted from durable user/message events, durationMs from agent/created.',
  },
  UserPromptSubmit: {
    official: 'agent/pre-step',
    officialMode: 'waterfall',
    interceptable: true,
    description:
      'User message submit; block (reject the step) or replace the step message batch.',
  },
  TurnStart: {
    official: 'turn/start (session/event)',
    officialMode: 'emit',
    interceptable: false,
    description:
      'Model turn begins; turnIndex from the durable turn/start event, model best-effort from request/header.',
  },
  PreToolUse: {
    official: 'tools/pre-execute',
    officialMode: 'waterfall',
    interceptable: true,
    description:
      'Tool call pre-dispatch; allow, deny (block), cancel, or ask. Argument rewrite is not supported by the official surface.',
  },
  PostToolUse: {
    official: 'tools/post-execute',
    officialMode: 'waterfall',
    interceptable: true,
    description:
      'Tool call post-dispatch; accept, replace value/content, or block with feedback.',
  },
  TurnEnd: {
    official: 'agent/turn-stopping',
    officialMode: 'serial',
    interceptable: false,
    description:
      'Assistant turn about to close; observe-only (a listener may steer a further step, the bus does not).',
  },
  Compaction: {
    official: 'compaction/* (session/event)',
    officialMode: 'emit',
    interceptable: false,
    description:
      'Context compaction lifecycle (start/summary/end/prune); no official PreCompact/PostCompact interception exists.',
  },
  Error: {
    official: 'agent/error + api-session/error',
    officialMode: 'emit',
    interceptable: false,
    description:
      'Step/turn errors and session-level errors; observe-only (agent/request-error interception stays a v2 candidate).',
  },
}

export const EVENT_NAMES: readonly CatalogEventName[] = Object.keys(
  CATALOG,
) as CatalogEventName[]

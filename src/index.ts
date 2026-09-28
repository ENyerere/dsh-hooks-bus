/**
 * Loader-facing plugin namespace for dsh-hooks-bus.
 *
 * @module dsh-hooks-bus
 */

/** Cordis plugin name; keep this stable after publishing. */
const name = 'dsh-hooks-bus'

/** No hard dependencies: `timer` is read opportunistically via `ctx.get`. */
const inject: string[] = []

export { Config } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { apply, HooksBusService } from './runtime.ts'
export type { DeclarativeEntry } from './service.ts'
export { createPluginRuntime } from './adapters.ts'
export type { PluginRuntime } from './adapters.ts'
export { CATALOG, CATALOG_VERSION, EVENT_NAMES } from './catalog.ts'
export type {
  CatalogEntry,
  CatalogEventName,
  CompactionEvent,
  CompactionPhase,
  ContentBlockLike,
  ErrorEvent,
  HooksBusDecision,
  HooksBusEventMap,
  HooksBusHandler,
  MessageLike,
  PostToolUseEvent,
  PreToolUseEvent,
  PromptAttachment,
  SessionEndEvent,
  SessionStartEvent,
  SessionStartSource,
  TurnEndEvent,
  TurnEndUsage,
  TurnStartEvent,
  UserPromptSubmitEvent,
} from './catalog.ts'
export type {
  DispatchLogRecord,
  EventStats,
  SubscriberOutcome,
  SubscriberStatus,
} from './logger.ts'
export type {
  DeclarativeSubscription,
  SubscribeOptions,
  Subscription,
  SubscriptionSource,
} from './registry.ts'
export type { DispatchOutcome, TimerLike } from './dispatcher.ts'
export type {
  MergedDecision,
  MergeInput,
  MergeResult,
  WarningNote,
} from './decisions.ts'
export { inject, name }

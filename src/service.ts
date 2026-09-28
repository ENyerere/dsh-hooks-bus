/**
 * The bus service: subscription surface (`ctx.hooksBus`), dispatch wiring, the
 * in-memory state buffers (tool-call durations, turn text/usage, per-session
 * stats), and the API surface backing the settings-page viewer.
 *
 * @module dsh-hooks-bus/service
 */

import { Service } from 'cordis'
import type { Context } from 'cordis'

import {
  asNext,
  buildPromptEvent,
  createPluginRuntime,
  describeErrorMessage,
  describeErrorType,
  extractText,
  normalizeSource,
} from './adapters.ts'
import type {
  AgentCreatedPayload,
  AgentDisposedPayload,
  AgentErrorPayload,
  PluginRuntime,
  PostToolResultLike,
  PreStepPayload,
  RawEventBus,
  SessionEventLike,
  ToolExecLike,
  TurnStoppingPayload,
} from './adapters.ts'
import { registerApi } from './api.ts'
import { CATALOG, CATALOG_VERSION } from './catalog.ts'
import type {
  CatalogEntry,
  CatalogEventName,
  CompactionPhase,
  HooksBusHandler,
  MessageLike,
  TurnEndUsage,
} from './catalog.ts'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { Dispatcher } from './dispatcher.ts'
import { DispatchLogger } from './logger.ts'
import type { DispatchLogRecord, EventStats } from './logger.ts'
import { PersistenceStore } from './persistence.ts'
import { Registry } from './registry.ts'
import type { DeclarativeSubscription, SubscribeOptions } from './registry.ts'

/** Declarative entry as consumers write it: handler may be a module path. */
export interface DeclarativeEntry {
  event: CatalogEventName
  handler: HooksBusHandler | string
  priority?: number
  timeoutMs?: number
  label?: string
}

async function resolveDeclarativeEntry(
  entry: DeclarativeEntry,
  options: { baseUrl?: string },
): Promise<DeclarativeSubscription> {
  let handler = entry.handler
  if (typeof handler === 'string') {
    if (options.baseUrl === undefined) {
      throw new TypeError(
        `declarative handler "${handler}" requires options.baseUrl to resolve`,
      )
    }
    const imported: unknown = await import(
      new URL(handler, options.baseUrl).href
    )
    const candidate = (imported as { default?: unknown }).default ?? imported
    if (typeof candidate !== 'function') {
      throw new TypeError(
        `declarative handler "${handler}" did not resolve to a function`,
      )
    }
    handler = candidate as HooksBusHandler
  }
  return {
    event: entry.event,
    handler,
    ...(entry.priority === undefined ? {} : { priority: entry.priority }),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  }
}

interface TurnBuffer {
  text: string | undefined
  usage: TurnEndUsage | undefined
}

interface SessionStats {
  startedAt: number
  messageCount: number
  model: string | undefined
}

const COMPACTION_PHASES: ReadonlySet<string> = new Set([
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
])

/** The bus service exposed as `ctx.hooksBus` to other plugins. */
class HooksBusService extends Service<Config> {
  static inject: string[] = []

  private readonly registry: Registry
  private readonly logger: DispatchLogger
  private readonly dispatcher: Dispatcher
  private readonly runtime: PluginRuntime
  private readonly eventBus: RawEventBus
  private readonly config: ResolvedConfig
  private readonly callStarts = new Map<string, number>()
  private readonly turnBuffers = new Map<string, TurnBuffer>()
  private readonly sessionStats = new Map<string, SessionStats>()
  private persistence: PersistenceStore | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'hooksBus')
    const resolved = resolveConfig(config)
    this.config = resolved
    this.runtime = createPluginRuntime(ctx)
    this.registry = new Registry(resolved.defaultTimeoutMs)
    this.logger = new DispatchLogger(
      resolved.logCapacity,
      resolved.logFullPayload,
      resolved.payloadSummaryMaxChars,
      (record) => {
        const store = this.persistence
        if (store !== undefined) {
          void store.append(record).catch((error: unknown) => {
            this.ctx.logger.warn('[hooks-bus] log persist failed: %s', error)
          })
        }
      },
    )
    this.dispatcher = new Dispatcher(
      this.registry,
      this.logger,
      this.runtime.timer,
    )
    this.eventBus = ctx as unknown as RawEventBus
    this.wireSessionStart()
    this.wireSessionEnd()
    this.wireUserPromptSubmit()
    this.wirePreToolUse()
    this.wirePostToolUse()
    this.wireTurnEnd()
    this.wireSessionEvents()
    this.wireErrors()
    // Register the HTTP API only once the webServer service is present.
    // A top-level inject would hold the bus pending in headless deployments.
    // A plain ctx.get at construction time races the webServer fiber.
    // It can silently skip route registration (the HTTP 404 bug).
    // Ctx.inject instead starts a child fiber as soon as webServer appears.
    // That child fiber never fires where the service does not exist.
    ctx.inject(['webServer'], (webCtx) => {
      registerApi(webCtx, this)
    })
    void this.initPersistence()
  }

  private async initPersistence(): Promise<void> {
    const store = await PersistenceStore.open(this.ctx, this.config.logCapacity)
    if (store === undefined) {
      return
    }
    this.persistence = store
    const paused = store.paused()
    this.dispatcher.setPaused(paused)
    this.logger.seed(store.logs())
    if (paused) {
      this.ctx.logger.info('[hooks-bus] restored global pause from storage')
    }
  }

  /** Subscribe a runtime handler. Returns the disposer. */
  on<E extends CatalogEventName>(
    event: E,
    handler: HooksBusHandler<E>,
    options: SubscribeOptions = {},
  ): () => void {
    return this.registry.subscribe(event, handler, options)
  }

  /**
   * Register declarative subscriptions. Handlers may be functions or module
   * paths (resolved against `options.baseUrl`); any invalid entry fails the
   * whole declaration. Returns the disposer.
   */
  async declare(
    entries: readonly DeclarativeEntry[],
    options: { baseUrl?: string } = {},
  ): Promise<() => void> {
    const resolved: DeclarativeSubscription[] = []
    for (const entry of entries) {
      resolved.push(await resolveDeclarativeEntry(entry, options))
    }
    return this.registry.declare(resolved)
  }

  catalog(): Readonly<Record<CatalogEventName, CatalogEntry>> {
    return CATALOG
  }

  catalogVersion(): string {
    return CATALOG_VERSION
  }

  stats(): Readonly<Record<CatalogEventName, EventStats>> {
    return this.logger.stats()
  }

  logs(): readonly DispatchLogRecord[] {
    return this.logger.list()
  }

  setPaused(paused: boolean): void {
    this.dispatcher.setPaused(paused)
    const store = this.persistence
    if (store !== undefined) {
      void store.setPaused(paused).catch((error: unknown) => {
        this.ctx.logger.warn('[hooks-bus] pause persist failed: %s', error)
      })
    }
  }

  setSubscriptionPaused(id: number, paused: boolean): boolean {
    return this.registry.setPaused(id, paused)
  }

  /** Snapshot served to the settings-page viewer. */
  state(): unknown {
    const stats = this.logger.stats()
    return {
      paused: this.dispatcher.paused,
      catalogVersion: CATALOG_VERSION,
      config: { ...this.config },
      events: (Object.keys(CATALOG) as CatalogEventName[]).map((name) => ({
        name,
        official: CATALOG[name].official,
        interceptable: CATALOG[name].interceptable,
        subscribers: this.registry.count(name),
        activeSubscribers: this.registry.activeCount(name),
        stats: stats[name],
      })),
      subscriptions: this.registry.listAll().map((subscription) => ({
        id: subscription.id,
        event: subscription.event,
        priority: subscription.priority,
        timeoutMs: subscription.timeoutMs,
        source: subscription.source,
        label: subscription.label,
        paused: subscription.paused,
      })),
      logs: this.logger.list(),
    }
  }

  private wireSessionStart(): void {
    this.eventBus.on('agent/created', (...args: unknown[]) => {
      try {
        const payload = args[0] as AgentCreatedPayload
        const agentId = payload?.agent?.id as string | undefined
        const sessionId = agentId ?? ''
        this.rememberSessionStart(sessionId)
        return this.dispatcher.dispatch('SessionStart', {
          sessionId,
          source: normalizeSource(payload?.source),
          workspacePath: this.runtime.sessionCwd(agentId),
        })
      } catch (error) {
        this.ctx.logger.warn(
          '[hooks-bus] SessionStart dispatch failed: %s',
          error,
        )
        return undefined
      }
    })
  }

  private wireSessionEnd(): void {
    this.eventBus.on('agent/disposed', (...args: unknown[]) => {
      try {
        const payload = args[0] as AgentDisposedPayload
        const sessionId = payload?.agent?.id as string | undefined
        if (sessionId === undefined) {
          return
        }
        const stats = this.sessionStats.get(sessionId)
        this.sessionStats.delete(sessionId)
        void this.dispatcher.dispatch('SessionEnd', {
          sessionId,
          messageCount: stats?.messageCount ?? 0,
          durationMs:
            stats === undefined ? undefined : Date.now() - stats.startedAt,
        })
      } catch (error) {
        this.ctx.logger.warn(
          '[hooks-bus] SessionEnd dispatch failed: %s',
          error,
        )
      }
    })
  }

  private wireUserPromptSubmit(): void {
    this.eventBus.on('agent/pre-step', async (...args: unknown[]) => {
      const payload = args[0] as PreStepPayload
      const next = asNext(args[1], async () => ({ kind: 'allow' }))
      try {
        const messages = (payload?.messages ?? []) as readonly MessageLike[]
        if (!messages.some((message) => message?.role === 'user')) {
          return await next()
        }
        const outcome = await this.dispatcher.dispatch(
          'UserPromptSubmit',
          buildPromptEvent(payload, messages),
        )
        if (outcome.merged.kind === 'reject') {
          return { kind: 'reject' }
        }
        if (outcome.merged.kind === 'enter') {
          return { kind: 'enter', messages: outcome.merged.messages }
        }
        return await next()
      } catch (error) {
        this.ctx.logger.warn(
          '[hooks-bus] UserPromptSubmit dispatch failed: %s',
          error,
        )
        return next()
      }
    })
  }

  private wirePreToolUse(): void {
    this.eventBus.on('tools/pre-execute', async (...args: unknown[]) => {
      const exec = args[0] as ToolExecLike
      const next = asNext(args[1], async () => ({ kind: 'allow' }))
      try {
        const callId = String(exec?.callId ?? '')
        this.noteCallStart(callId)
        const outcome = await this.dispatcher.dispatch('PreToolUse', {
          sessionId: exec?.agent?.id as string | undefined,
          toolName: String(exec?.name ?? ''),
          args: exec?.arguments,
          callId,
          signal: exec?.signal as AbortSignal | undefined,
        })
        if (outcome.merged.kind === 'deny') {
          return { kind: 'deny', reason: outcome.merged.reason }
        }
        if (outcome.merged.kind === 'cancel') {
          return { kind: 'cancel' }
        }
        if (outcome.merged.kind === 'ask') {
          return {
            kind: 'ask',
            ...(outcome.merged.reason === undefined
              ? {}
              : { reason: outcome.merged.reason }),
          }
        }
        return await next()
      } catch (error) {
        this.ctx.logger.warn(
          '[hooks-bus] PreToolUse dispatch failed: %s',
          error,
        )
        return next()
      }
    })
  }

  private wirePostToolUse(): void {
    this.eventBus.on('tools/post-execute', async (...args: unknown[]) => {
      const exec = args[0] as ToolExecLike
      const result = args[1] as PostToolResultLike
      const next = asNext(args[2], async () => ({ kind: 'accept' }))
      try {
        const callId = String(exec?.callId ?? '')
        const outcome = await this.dispatcher.dispatch('PostToolUse', {
          sessionId: exec?.agent?.id as string | undefined,
          toolName: String(exec?.name ?? ''),
          args: exec?.arguments,
          result,
          error: result?.isError === true ? result.error : undefined,
          durationMs: this.takeCallDuration(callId),
          callId,
          signal: exec?.signal as AbortSignal | undefined,
        })
        if (outcome.merged.kind === 'blockFeedback') {
          return { kind: 'block', feedback: outcome.merged.feedback }
        }
        if (outcome.merged.kind === 'acceptValue') {
          return { kind: 'accept', value: outcome.merged.value }
        }
        if (outcome.merged.kind === 'acceptContent') {
          return { kind: 'accept', content: outcome.merged.content }
        }
        return await next()
      } catch (error) {
        this.ctx.logger.warn(
          '[hooks-bus] PostToolUse dispatch failed: %s',
          error,
        )
        return next()
      }
    })
  }

  private wireTurnEnd(): void {
    this.eventBus.on('agent/turn-stopping', (...args: unknown[]) => {
      try {
        const payload = args[0] as TurnStoppingPayload
        const sessionId = payload?.agent?.id as string | undefined
        const buffered =
          sessionId === undefined ? undefined : this.turnBuffers.get(sessionId)
        if (sessionId !== undefined) {
          this.turnBuffers.delete(sessionId)
        }
        return this.dispatcher.dispatch('TurnEnd', {
          sessionId,
          turnIndex: payload?.turn as number,
          text: buffered?.text,
          usage: buffered?.usage,
        })
      } catch (error) {
        this.ctx.logger.warn('[hooks-bus] TurnEnd dispatch failed: %s', error)
        return undefined
      }
    })
  }

  private wireSessionEvents(): void {
    this.eventBus.on('session/event', (...args: unknown[]) => {
      try {
        const session = args[0] as { id?: unknown }
        const event = args[1] as SessionEventLike
        const sessionId = session?.id as string | undefined
        if (sessionId === undefined) {
          return
        }
        const type = event?.type
        if (type === 'assistant/message') {
          this.rememberAssistantMessage(sessionId, event.data)
        } else if (type === 'turn/start') {
          this.dispatchTurnStart(sessionId, event.data)
        } else if (type === 'user/message') {
          this.countUserMessage(sessionId)
        } else if (type === 'request/header') {
          this.rememberModel(sessionId, event.data)
        } else if (typeof type === 'string' && COMPACTION_PHASES.has(type)) {
          this.dispatchCompaction(sessionId, type, event.data)
        }
      } catch {
        // Best-effort observation; never break the official event feed.
      }
    })
  }

  private wireErrors(): void {
    this.eventBus.on('agent/error', (...args: unknown[]) => {
      try {
        const payload = args[0] as AgentErrorPayload
        void this.dispatcher.dispatch('Error', {
          sessionId: payload?.agent?.id as string | undefined,
          errorType: describeErrorType(payload?.error),
          message: describeErrorMessage(payload?.error),
        })
      } catch (error) {
        this.ctx.logger.warn('[hooks-bus] Error dispatch failed: %s', error)
      }
    })
    this.eventBus.on('api-session/error', (...args: unknown[]) => {
      try {
        const rawSessionId = args[0]
        const rawMessage = args[1]
        void this.dispatcher.dispatch('Error', {
          sessionId:
            typeof rawSessionId === 'string' ? rawSessionId : undefined,
          errorType: 'api-session',
          message: describeErrorMessage(rawMessage),
        })
      } catch (error) {
        this.ctx.logger.warn('[hooks-bus] Error dispatch failed: %s', error)
      }
    })
  }

  private rememberSessionStart(sessionId: string): void {
    this.sessionStats.set(sessionId, {
      startedAt: Date.now(),
      messageCount: 0,
      model: undefined,
    })
    if (this.sessionStats.size > 1000) {
      this.sessionStats.clear()
    }
  }

  private countUserMessage(sessionId: string): void {
    const stats = this.sessionStats.get(sessionId)
    if (stats !== undefined) {
      stats.messageCount += 1
    }
  }

  private rememberModel(sessionId: string, data: unknown): void {
    const record = data as
      | { header?: { config?: { model?: unknown } } }
      | undefined
    const model = record?.header?.config?.model
    const stats = this.sessionStats.get(sessionId)
    if (stats !== undefined && typeof model === 'string') {
      stats.model = model
    }
  }

  private dispatchTurnStart(sessionId: string, data: unknown): void {
    this.turnBuffers.delete(sessionId)
    const record = data as { turn?: unknown } | undefined
    void this.dispatcher.dispatch('TurnStart', {
      sessionId,
      turnIndex: record?.turn as number,
      model: this.sessionStats.get(sessionId)?.model,
    })
  }

  private dispatchCompaction(
    sessionId: string,
    type: string,
    data: unknown,
  ): void {
    const record = data as {
      compactionId?: unknown
      turn?: unknown
      shadowedTokenCount?: unknown
      error?: unknown
    }
    void this.dispatcher.dispatch('Compaction', {
      sessionId,
      phase: type.slice('compaction/'.length) as CompactionPhase,
      turn: typeof record.turn === 'number' ? record.turn : null,
      compactionId:
        typeof record.compactionId === 'string'
          ? record.compactionId
          : undefined,
      shadowedTokenCount:
        typeof record.shadowedTokenCount === 'number'
          ? record.shadowedTokenCount
          : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
      data,
    })
  }

  private rememberAssistantMessage(sessionId: string, data: unknown): void {
    const record = data as {
      message?: MessageLike
      usage?: { inputTokens?: number; outputTokens?: number }
    }
    const text = extractText(record?.message?.content)
    const usage = record?.usage
    const buffer = this.turnBuffers.get(sessionId) ?? {
      text: undefined,
      usage: undefined,
    }
    if (text !== undefined) {
      buffer.text = text
    }
    if (usage !== undefined) {
      buffer.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }
    }
    this.turnBuffers.set(sessionId, buffer)
    if (this.turnBuffers.size > 1000) {
      this.turnBuffers.clear()
    }
  }

  private noteCallStart(callId: string): void {
    if (this.callStarts.size > 10_000) {
      this.callStarts.clear()
    }
    this.callStarts.set(callId, Date.now())
  }

  private takeCallDuration(callId: string): number | undefined {
    const startedAt = this.callStarts.get(callId)
    if (startedAt === undefined) {
      return undefined
    }
    this.callStarts.delete(callId)
    return Date.now() - startedAt
  }
}

export { HooksBusService }

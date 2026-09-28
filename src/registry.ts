/**
 * Subscription registry: runtime and declarative subscriptions, validation,
 * ordering, and per-subscription pause.
 *
 * @module dsh-hooks-bus/registry
 */

import { CATALOG, EVENT_NAMES } from './catalog.ts'
import type {
  CatalogEventName,
  HooksBusDecision,
  HooksBusEventMap,
  HooksBusHandler,
} from './catalog.ts'

export interface SubscribeOptions {
  /** Higher runs first. Default 0. */
  priority?: number
  /** Per-subscriber timeout override; defaults to the plugin `defaultTimeoutMs`. */
  timeoutMs?: number
  /** Subscription origin shown in the settings page. Default `runtime`. */
  source?: SubscriptionSource
  /** Human-readable owner label shown in the settings page. */
  label?: string
}

/** A resolved declarative subscription entry (handlers already loaded). */
export interface DeclarativeSubscription {
  event: CatalogEventName
  handler: HooksBusHandler
  priority?: number
  timeoutMs?: number
  label?: string
}

export type SubscriptionSource = 'runtime' | 'declarative'

/** Handler as stored internally; the public `on` method adapts typed handlers. */
type InternalHandler = (
  event: unknown,
) => HooksBusDecision | void | Promise<HooksBusDecision | void>

export interface Subscription {
  readonly id: number
  readonly event: CatalogEventName
  readonly priority: number
  readonly timeoutMs: number
  readonly handler: InternalHandler
  readonly source: SubscriptionSource
  readonly label: string
  paused: boolean
}

export class Registry {
  private readonly byEvent = new Map<CatalogEventName, Subscription[]>()
  private readonly byId = new Map<number, Subscription>()
  private nextId = 1

  constructor(private readonly defaultTimeoutMs: number) {}

  subscribe<E extends CatalogEventName>(
    event: E,
    handler: HooksBusHandler<E>,
    options: SubscribeOptions = {},
  ): () => void {
    assertEventName(event)
    const subscription = this.add(
      event,
      (typed) => handler(typed as HooksBusEventMap[E]),
      {
        priority: options.priority,
        timeoutMs: options.timeoutMs,
        source: options.source ?? 'runtime',
        label: options.label ?? 'runtime',
      },
    )
    return () => {
      this.remove(subscription.id)
    }
  }

  /**
   * Register a resolved declarative list in one call; a bad entry fails the
   * whole declaration with a clear error (event names are validated up front).
   */
  declare(subscriptions: readonly DeclarativeSubscription[]): () => void {
    for (const entry of subscriptions) {
      assertEventName(entry.event)
    }
    const ids: number[] = []
    for (const entry of subscriptions) {
      const subscription = this.add(
        entry.event,
        (typed) => entry.handler(typed as HooksBusEventMap[CatalogEventName]),
        {
          priority: entry.priority,
          timeoutMs: entry.timeoutMs,
          source: 'declarative',
          label: entry.label ?? 'declarative',
        },
      )
      ids.push(subscription.id)
    }
    return () => {
      for (const id of ids) {
        this.remove(id)
      }
    }
  }

  /** Pause or resume one subscription by id. Returns false for unknown ids. */
  setPaused(id: number, paused: boolean): boolean {
    const subscription = this.byId.get(id)
    if (subscription === undefined) {
      return false
    }
    subscription.paused = paused
    return true
  }

  /** Active subscribers for one event, highest priority first, stable by id. */
  subscribersOf(event: CatalogEventName): readonly Subscription[] {
    const list = this.byEvent.get(event)
    if (list === undefined || list.length === 0) {
      return []
    }
    const active = list.filter((entry) => !entry.paused)
    if (active.length === 0) {
      return []
    }
    return [...active].sort(
      (left, right) => right.priority - left.priority || left.id - right.id,
    )
  }

  count(event: CatalogEventName): number {
    return this.byEvent.get(event)?.length ?? 0
  }

  activeCount(event: CatalogEventName): number {
    return this.subscribersOf(event).length
  }

  listAll(): readonly Subscription[] {
    return [...this.byId.values()]
  }

  private add(
    event: CatalogEventName,
    handler: InternalHandler,
    options: {
      priority: number | undefined
      timeoutMs: number | undefined
      source: SubscriptionSource
      label: string
    },
  ): Subscription {
    const priority = options.priority ?? 0
    if (!Number.isFinite(priority)) {
      throw new TypeError(
        `hooks-bus priority must be a finite number, got ${String(options.priority)}`,
      )
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError(
        `hooks-bus timeoutMs must be a positive number, got ${String(options.timeoutMs)}`,
      )
    }
    const subscription: Subscription = {
      id: this.nextId++,
      event,
      priority,
      timeoutMs,
      handler,
      source: options.source,
      label: options.label,
      paused: false,
    }
    const list = this.byEvent.get(event) ?? []
    list.push(subscription)
    this.byEvent.set(event, list)
    this.byId.set(subscription.id, subscription)
    return subscription
  }

  private remove(id: number): void {
    const subscription = this.byId.get(id)
    if (subscription === undefined) {
      return
    }
    this.byId.delete(id)
    const list = this.byEvent.get(subscription.event)
    const index = list?.findIndex((entry) => entry.id === id) ?? -1
    if (index >= 0) {
      list?.splice(index, 1)
    }
  }
}

function assertEventName(event: CatalogEventName): void {
  if (!(event in CATALOG)) {
    throw new Error(
      `unknown hooks-bus event "${event}"; legal events: ${EVENT_NAMES.join(', ')}`,
    )
  }
}

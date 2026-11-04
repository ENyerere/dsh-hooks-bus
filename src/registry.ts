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
import { planDeclarativeOrder } from './declarative-order.ts'
import type { DeclarativeEventPlan } from './declarative-order.ts'
import { normalizeOwner } from './owner.ts'
import type { SubscriptionOwner } from './owner.ts'

export interface SubscribeOptions {
  /** Higher runs first. Default 0. */
  priority?: number
  /** Per-subscriber timeout override; defaults to the plugin `defaultTimeoutMs`. */
  timeoutMs?: number
  /** Subscription origin shown in the settings page. Default `runtime`. */
  source?: SubscriptionSource
  /** Human-readable owner label shown in the settings page. */
  label?: string
  /** Self-reported provenance shown for troubleshooting; never verified. */
  owner?: SubscriptionOwner
}

/** A resolved declarative subscription entry (handlers already loaded). */
export interface DeclarativeSubscription {
  event: CatalogEventName
  handler: HooksBusHandler
  priority?: number
  timeoutMs?: number
  label?: string
  /** Self-reported provenance shown for troubleshooting; never verified. */
  owner?: SubscriptionOwner
  /** Optional key scoped to one event inside one declare() batch. */
  key?: string
  /** Keys in this batch that must run after this entry. */
  before?: readonly string[]
  /** Keys in this batch that must run before this entry. */
  after?: readonly string[]
}

/** One declarative batch's ordering constraints for one event. */
interface DeclarativeBatch {
  readonly event: CatalogEventName
  readonly members: ReadonlySet<number>
  readonly edges: readonly (readonly [number, number])[]
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
  /** Normalized self-reported provenance; `undefined` for old consumers. */
  readonly owner: SubscriptionOwner | undefined
  paused: boolean
}

export class Registry {
  private readonly byEvent = new Map<CatalogEventName, Subscription[]>()
  private readonly byId = new Map<number, Subscription>()
  private readonly batches: DeclarativeBatch[] = []
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
        owner: options.owner,
      },
    )
    return () => {
      this.remove(subscription.id)
    }
  }

  /**
   * Register a resolved declarative list in one call.
   *
   * The whole batch is validated before any subscription is added: event names,
   * key/before/after scope, duplicate keys, missing or cross-event references,
   * and cycles. A registration failure also rolls back ids added earlier in the
   * loop, so no half-batch remains. Batches without before/after constraints
   * keep the exact legacy priority + registration order.
   */
  declare(subscriptions: readonly DeclarativeSubscription[]): () => void {
    for (const entry of subscriptions) {
      assertEventName(entry.event)
    }
    const plans = planDeclarativeOrder(subscriptions)
    const ids: number[] = []
    const batches: DeclarativeBatch[] = []
    try {
      const idByIndex = new Map<number, number>()
      for (const [index, entry] of subscriptions.entries()) {
        const subscription = this.add(
          entry.event,
          (typed) => entry.handler(typed as HooksBusEventMap[CatalogEventName]),
          {
            priority: entry.priority,
            timeoutMs: entry.timeoutMs,
            source: 'declarative',
            label: entry.label ?? 'declarative',
            owner: entry.owner,
          },
        )
        ids.push(subscription.id)
        idByIndex.set(index, subscription.id)
      }
      for (const plan of plans) {
        batches.push(this.batchFromPlan(plan, idByIndex))
      }
      this.batches.push(...batches)
    } catch (error) {
      for (const id of ids) {
        this.remove(id)
      }
      throw error
    }
    return () => {
      for (const id of ids) {
        this.remove(id)
      }
      for (const batch of batches) {
        const index = this.batches.indexOf(batch)
        if (index !== -1) {
          this.batches.splice(index, 1)
        }
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
    const sorted = [...active].sort(baseSubscriptionOrder)
    for (const batch of this.batches) {
      if (batch.event === event) {
        this.applyBatchOrder(sorted, batch)
      }
    }
    return sorted
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

  private batchFromPlan(
    plan: DeclarativeEventPlan,
    idByIndex: ReadonlyMap<number, number>,
  ): DeclarativeBatch {
    const members = new Set<number>()
    for (const index of plan.members) {
      const id = idByIndex.get(index)
      if (id === undefined) {
        throw new Error(
          'internal: declarative plan referenced an unregistered entry',
        )
      }
      members.add(id)
    }
    const edges: (readonly [number, number])[] = []
    for (const edge of plan.edges) {
      const from = idByIndex.get(edge.from)
      const to = idByIndex.get(edge.to)
      if (from === undefined || to === undefined) {
        throw new Error(
          'internal: declarative plan referenced an unregistered entry',
        )
      }
      edges.push([from, to])
    }
    return { event: plan.event, members, edges }
  }

  /**
   * Reorder this batch's active nodes inside the already base-sorted list.
   *
   * The topological sort includes paused batch nodes too, so a paused middle
   * node cannot drop the transitive constraint between the nodes around it.
   * Only positions occupied by this batch are rewritten; unrelated
   * subscriptions keep their base positions.
   */
  private applyBatchOrder(
    sorted: Subscription[],
    batch: DeclarativeBatch,
  ): void {
    const allMembers: Subscription[] = []
    for (const id of batch.members) {
      const subscription = this.byId.get(id)
      if (subscription !== undefined) {
        allMembers.push(subscription)
      }
    }
    if (allMembers.length < 2) {
      return
    }
    const ranked = [...allMembers].sort(baseSubscriptionOrder)
    const rankById = new Map<number, number>()
    for (const [index, subscription] of ranked.entries()) {
      rankById.set(subscription.id, index)
    }
    const adjacency = new Map<number, number[]>()
    const indegree = new Map<number, number>()
    for (const subscription of allMembers) {
      adjacency.set(subscription.id, [])
      indegree.set(subscription.id, 0)
    }
    let edgeCount = 0
    for (const [from, to] of batch.edges) {
      if (!adjacency.has(from) || !indegree.has(to)) {
        continue
      }
      adjacency.get(from)?.push(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
      edgeCount += 1
    }
    if (edgeCount === 0) {
      return
    }
    const remaining = new Set(allMembers)
    const ordered: Subscription[] = []
    while (remaining.size > 0) {
      let next: Subscription | undefined
      let nextRank = Number.POSITIVE_INFINITY
      for (const subscription of remaining) {
        if ((indegree.get(subscription.id) ?? 0) !== 0) {
          continue
        }
        const rank = rankById.get(subscription.id) ?? Number.POSITIVE_INFINITY
        if (rank < nextRank) {
          nextRank = rank
          next = subscription
        }
      }
      if (next === undefined) {
        // A validated graph cannot cycle; keep the base order defensively.
        return
      }
      ordered.push(next)
      remaining.delete(next)
      for (const target of adjacency.get(next.id) ?? []) {
        indegree.set(target, (indegree.get(target) ?? 1) - 1)
      }
    }
    const activeOrdered = ordered.filter((subscription) => !subscription.paused)
    const positions: number[] = []
    for (const [index, subscription] of sorted.entries()) {
      if (batch.members.has(subscription.id)) {
        positions.push(index)
      }
    }
    if (positions.length !== activeOrdered.length) {
      return
    }
    for (const [index, position] of positions.entries()) {
      const subscription = activeOrdered[index]
      if (subscription !== undefined) {
        sorted[position] = subscription
      }
    }
  }

  private add(
    event: CatalogEventName,
    handler: InternalHandler,
    options: {
      priority: number | undefined
      timeoutMs: number | undefined
      source: SubscriptionSource
      label: string
      owner: SubscriptionOwner | undefined
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
      owner: normalizeOwner(options.owner),
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

function baseSubscriptionOrder(
  left: Subscription,
  right: Subscription,
): number {
  return right.priority - left.priority || left.id - right.id
}

function assertEventName(event: CatalogEventName): void {
  if (!(event in CATALOG)) {
    throw new Error(
      `unknown hooks-bus event "${event}"; legal events: ${EVENT_NAMES.join(', ')}`,
    )
  }
}

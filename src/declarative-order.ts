/**
 * Validation and stable topological planning for one `declare()` batch.
 *
 * Ordering keys are scoped narrowly: one batch + one event. References never
 * escape that scope, and this module never touches the runtime `on()` path or a
 * second registry. The plan is intentionally index-based; the registry maps
 * input indices to subscription ids only after the whole batch validates.
 *
 * @module dsh-hooks-bus/declarative-order
 */

import type { CatalogEventName } from './catalog.ts'
import type { DeclarativeSubscription } from './registry.ts'

/** One directed "from runs before to" edge, as input-array indices. */
export interface DeclarativeEdge {
  from: number
  to: number
}

/** Validated ordering constraints for one event inside a batch. */
export interface DeclarativeEventPlan {
  event: CatalogEventName
  /** Input indices of nodes touched by at least one edge. */
  members: readonly number[]
  edges: readonly DeclarativeEdge[]
}

interface EntryMetadata {
  index: number
  event: CatalogEventName
  key: string | undefined
  before: readonly string[]
  after: readonly string[]
}

const MAX_KEY_LENGTH = 200

/**
 * Validate key/before/after metadata and build per-event ordering plans.
 *
 * @param subscriptions - Entries of one declarative batch, in declaration
 *   order.
 * @returns One plan per event that has at least one constraint edge.
 * @throws When a key is invalid or duplicated, a reference is unknown or
 *   cross-event, or the same-event graph has a cycle. The caller must not have
 *   registered any entry when this throws.
 */
export function planDeclarativeOrder(
  subscriptions: readonly DeclarativeSubscription[],
): DeclarativeEventPlan[] {
  const metadata = subscriptions.map((entry, index) =>
    readMetadata(entry, index),
  )
  const byEvent = groupByEvent(metadata)
  const keyEvents = collectKeyEvents(metadata)
  const plans: DeclarativeEventPlan[] = []

  for (const [event, entries] of byEvent) {
    const keyed = new Map<string, EntryMetadata>()
    for (const entry of entries) {
      if (entry.key === undefined) {
        continue
      }
      if (keyed.has(entry.key)) {
        throw new Error(
          `duplicate declarative key "${entry.key}" in event "${event}" within one declare() batch`,
        )
      }
      keyed.set(entry.key, entry)
    }
    const edges: DeclarativeEdge[] = []
    for (const entry of entries) {
      for (const reference of entry.before) {
        edges.push({
          from: entry.index,
          to: resolveReference(reference, entry, keyed, keyEvents).index,
        })
      }
      for (const reference of entry.after) {
        edges.push({
          from: resolveReference(reference, entry, keyed, keyEvents).index,
          to: entry.index,
        })
      }
    }
    if (edges.length === 0) {
      continue
    }
    detectCycle(event, entries, edges)
    const members = new Set<number>()
    for (const edge of edges) {
      members.add(edge.from)
      members.add(edge.to)
    }
    plans.push({ event, members: [...members].sort((a, b) => a - b), edges })
  }
  return plans
}

function readMetadata(
  entry: DeclarativeSubscription,
  index: number,
): EntryMetadata {
  const key = readKey(entry.key, index, entry.event)
  return {
    index,
    event: entry.event,
    key,
    before: readReferences(entry.before, 'before', index, entry.event),
    after: readReferences(entry.after, 'after', index, entry.event),
  }
}

function readKey(
  value: string | undefined,
  index: number,
  event: CatalogEventName,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new TypeError(
      `declarative key must be a string (entry #${index}, event "${event}")`,
    )
  }
  const key = value.trim()
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(
      `declarative key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters (entry #${index}, event "${event}")`,
    )
  }
  return key
}

function readReferences(
  value: unknown,
  field: 'before' | 'after',
  index: number,
  event: CatalogEventName,
): readonly string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      `declarative ${field} must be an array of keys (entry #${index}, event "${event}")`,
    )
  }
  return value.map((reference) => {
    if (typeof reference !== 'string') {
      throw new TypeError(
        `declarative ${field} entries must be strings (entry #${index}, event "${event}")`,
      )
    }
    const key = reference.trim()
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new TypeError(
        `declarative ${field} reference must be a non-empty string of at most ${MAX_KEY_LENGTH} characters (entry #${index}, event "${event}")`,
      )
    }
    return key
  })
}

function groupByEvent(
  metadata: readonly EntryMetadata[],
): Map<CatalogEventName, EntryMetadata[]> {
  const byEvent = new Map<CatalogEventName, EntryMetadata[]>()
  for (const entry of metadata) {
    const bucket = byEvent.get(entry.event)
    if (bucket === undefined) {
      byEvent.set(entry.event, [entry])
    } else {
      bucket.push(entry)
    }
  }
  return byEvent
}

function collectKeyEvents(
  metadata: readonly EntryMetadata[],
): Map<string, Set<CatalogEventName>> {
  const keyEvents = new Map<string, Set<CatalogEventName>>()
  for (const entry of metadata) {
    if (entry.key === undefined) {
      continue
    }
    const events = keyEvents.get(entry.key) ?? new Set()
    events.add(entry.event)
    keyEvents.set(entry.key, events)
  }
  return keyEvents
}

function resolveReference(
  reference: string,
  entry: EntryMetadata,
  keyed: ReadonlyMap<string, EntryMetadata>,
  keyEvents: ReadonlyMap<string, Set<CatalogEventName>>,
): EntryMetadata {
  const target = keyed.get(reference)
  if (target !== undefined) {
    return target
  }
  const events = keyEvents.get(reference)
  if (events !== undefined && events.size > 0) {
    throw new Error(
      `declarative key "${reference}" referenced by entry #${entry.index} (event "${entry.event}") belongs to event "${[...events].join('", "')}" in this batch; references must target the same event`,
    )
  }
  throw new Error(
    `unknown declarative key "${reference}" referenced by entry #${entry.index} (event "${entry.event}"); keys and references are scoped to the same declare() batch and event`,
  )
}

function detectCycle(
  event: CatalogEventName,
  entries: readonly EntryMetadata[],
  edges: readonly DeclarativeEdge[],
): void {
  const labelByIndex = new Map<number, string>()
  for (const entry of entries) {
    labelByIndex.set(entry.index, entry.key ?? `#${entry.index}`)
  }
  const adjacency = new Map<number, number[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? []
    targets.push(edge.to)
    adjacency.set(edge.from, targets)
  }
  const state = new Map<number, 1 | 2>()
  const stack: number[] = []

  const visit = (node: number): void => {
    state.set(node, 1)
    stack.push(node)
    for (const target of adjacency.get(node) ?? []) {
      const targetState = state.get(target)
      if (targetState === 1) {
        const start = stack.indexOf(target)
        const cycle = [...stack.slice(start), target].map(
          (index) => labelByIndex.get(index) ?? `#${index}`,
        )
        throw new Error(
          `declarative ordering cycle in event "${event}": ${cycle.join(' -> ')}`,
        )
      }
      if (targetState === undefined) {
        visit(target)
      }
    }
    stack.pop()
    state.set(node, 2)
  }

  for (const entry of entries) {
    if (state.get(entry.index) === undefined) {
      visit(entry.index)
    }
  }
}

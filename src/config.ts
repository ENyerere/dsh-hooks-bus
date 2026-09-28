/**
 * Serializable configuration, schema, and direct-call defaults.
 *
 * @module dsh-hooks-bus/config
 */

import schema from 'schemastery'

/** Plugin configuration supplied by the profile composition. */
interface Config {
  /** Default per-subscriber timeout; per-subscription `timeoutMs` overrides it. */
  defaultTimeoutMs?: number
  /** Capacity of the in-memory dispatch log ring buffer. */
  logCapacity?: number
  /**
   * Store full payloads in the dispatch log (default: truncated summaries
   * only).
   */
  logFullPayload?: boolean
  /** Truncation length for payload summaries. */
  payloadSummaryMaxChars?: number
}

/** Configuration after defaults have been resolved. */
interface ResolvedConfig {
  defaultTimeoutMs: number
  logCapacity: number
  logFullPayload: boolean
  payloadSummaryMaxChars: number
}

/** Loader-visible configuration schema and defaults. */
const Config: schema<Config> = schema.object({
  defaultTimeoutMs: schema.number().default(5000),
  logCapacity: schema.number().default(500),
  logFullPayload: schema.boolean().default(false),
  payloadSummaryMaxChars: schema.number().default(200),
})

/**
 * Resolve the same defaults (and clamp ranges) for direct callers that bypass
 * the Cordis Loader.
 *
 * @param config - Partial serialized configuration.
 * @returns Configuration with defaults applied and values clamped to sane
 *   ranges.
 */
function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    defaultTimeoutMs: clamp(config.defaultTimeoutMs, 1, 3_600_000, 5000),
    logCapacity: clamp(config.logCapacity, 1, 100_000, 500),
    logFullPayload: config.logFullPayload ?? false,
    payloadSummaryMaxChars: clamp(
      config.payloadSummaryMaxChars,
      10,
      100_000,
      200,
    ),
  }
}

function clamp(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

export { Config, resolveConfig, type ResolvedConfig }

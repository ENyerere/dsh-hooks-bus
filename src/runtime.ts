/**
 * Loader-facing activation for dsh-hooks-bus.
 *
 * The service lives in `service.ts`; this module owns the Cordis activation
 * (`apply`), the `ctx.hooksBus` declaration, and the public re-exports.
 *
 * @module dsh-hooks-bus/runtime
 */

import type { Context } from 'cordis'

import { CATALOG, CATALOG_VERSION } from './catalog.ts'
import type { Config } from './config.ts'
import { HooksBusService } from './service.ts'

/**
 * Apply the plugin to its Cordis context.
 *
 * @param ctx - Scoped plugin context; registrations must be owned by its
 *   effects.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
function apply(ctx: Context, config: Config): void {
  ctx.plugin(HooksBusService, config)
  ctx.logger.info(
    '[hooks-bus] active (catalog %s, %d events)',
    CATALOG_VERSION,
    Object.keys(CATALOG).length,
  )
}

declare module 'cordis' {
  interface Context {
    hooksBus: HooksBusService
  }
}

export { apply }
export { HooksBusService } from './service.ts'
export type { PluginRuntime } from './adapters.ts'

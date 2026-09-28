import { Context } from 'cordis'

import type { Config as PluginConfig } from '#src/config'
import { Config, apply, inject, name } from '#src/index'
import type { HooksBusService } from '#src/runtime'

const plugin = { Config, apply, inject, name }

export interface PluginHarness {
  ctx: Context
  hooksBus: HooksBusService
  dispose: () => Promise<void>
}

/** Mount the production plugin on a real Cordis context. */
export async function createPluginHarness(
  config: PluginConfig = {},
): Promise<PluginHarness> {
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, config)
  const { hooksBus } = ctx as unknown as { hooksBus: HooksBusService }
  return {
    ctx,
    hooksBus,
    async dispose(): Promise<void> {
      await fiber.dispose()
    },
  }
}

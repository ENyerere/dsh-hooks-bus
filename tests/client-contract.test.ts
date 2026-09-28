import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface ClientModule {
  inject: string[]
  apply: (ctx: unknown) => void
}

interface SlotEntry {
  name: string
  id: string
  order?: number
  label?: unknown
  locale?: string
}

interface CapturedRegistration {
  entry: SlotEntry
  component: () => { tag: string }
}

/** Execute client/client.js with a stubbed module loader and a fake React. */
function loadClientModule(): ClientModule {
  const react = {
    createElement: (
      tag: unknown,
      props: unknown,
      ...children: unknown[]
    ): { tag: unknown; props: unknown; children: unknown[] } => ({
      tag,
      props,
      children,
    }),
    useState: (initial: unknown): unknown[] => [initial, (): void => {}],
    useEffect: (): void => {},
  }
  let loaded: ClientModule | undefined
  const windowStub = {
    __ModuleLoader__: {
      load(entry: {
        id?: string
        factory: (require: (name: string) => unknown) => unknown
      }): void {
        expect(entry.id).toBe('dsh-hooks-bus')
        loaded = entry.factory((name: string) => {
          if (name === 'react') {
            return react
          }
          throw new Error(`unexpected require: ${name}`)
        }) as ClientModule
      },
    },
  }
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  runInNewContext(source, { window: windowStub })
  if (loaded === undefined) {
    throw new Error('client module did not load')
  }
  return loaded
}

function applyWith(module: ClientModule): {
  dictionary: unknown
  injectCalls: string[]
  registrations: CapturedRegistration[]
} {
  const registrations: CapturedRegistration[] = []
  const injectCalls: string[] = []
  let dictionary: unknown
  const ctx = {
    effect(callback: () => unknown): void {
      callback()
    },
    locale: {
      register(_namespace: string, dict: unknown): void {
        dictionary = dict
      },
      bind(): (key: string) => string {
        return (key: string) => key
      },
    },
    slots: {
      inject(slot: string, callback: () => unknown): void {
        injectCalls.push(slot)
        callback()
      },
      register(entry: SlotEntry, component: () => { tag: string }): void {
        registrations.push({ entry, component })
      },
    },
  }
  module.apply(ctx)
  return { dictionary, injectCalls, registrations }
}

describe('client module contract', () => {
  it('declares every service it uses', () => {
    const module = loadClientModule()
    expect([...module.inject]).toStrictEqual(['slots', 'locale'])
  })

  it('registers locale dictionaries and the Plugins settings tab slot', () => {
    const module = loadClientModule()
    const { dictionary, injectCalls, registrations } = applyWith(module)
    expect(dictionary).toMatchObject({
      en: { tab: 'Hooks Bus' },
      zh: { tab: 'Hooks Bus' },
    })
    expect(injectCalls).toStrictEqual(['settings.plugins.tab'])
    expect(registrations).toHaveLength(1)
  })

  it('registers the tab entry with the official options shape and renders', () => {
    const module = loadClientModule()
    const { registrations } = applyWith(module)
    const registration = registrations[0]
    expect(registration).toBeDefined()
    if (registration === undefined) {
      return
    }
    expect(registration.entry).toMatchObject({
      name: 'settings.plugins.tab',
      id: 'hooks-bus',
      locale: 'settings.hooksBus',
    })
    const labelResult = (registration.entry.label as () => string)()
    expect(labelResult).toBeTypeOf('string')

    // First render with empty state must not throw (loading branch).
    expect(registration.component().tag).toBe('div')
  })

  it('binds the master switch as "enabled" (ON = running, OFF = paused)', () => {
    // The page header shows "running" next to the switch, so the switch must
    // read as an enable toggle. Binding it to state.paused directly once made
    // a running bus render as OFF — pin the inversion. (Source-level check:
    // the stateful branch is unreachable with the stubbed React hooks.)
    loadClientModule()
    const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
    expect(source).toMatch(/checked:\s*!state\.paused/)
    expect(source).not.toMatch(/checked:\s*state\.paused/)
  })
})

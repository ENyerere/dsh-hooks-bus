/**
 * Client half of dsh-hooks-bus: the "Hooks Bus" page inside Settings → Plugins.
 *
 * Contract (mirrors the official companion packages, e.g.
 * `@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js`):
 * - lazy-CJS factory module under `window.__ModuleLoader__`;
 * - the returned module MUST declare `inject` for every service it uses
 *   (`slots` for registration, `locale` for visible text);
 * - all visible text goes through the Client locale service;
 * - no Harness client package imports; styling uses only theme tokens.
 * Data comes from the Host HTTP API under /api/hooks-bus/.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hooks-bus',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.hooksBus'

    const en = {
      tab: 'Hooks Bus',
      title: 'Hooks Bus',
      pausedBadge: 'bus globally paused',
      runningBadge: 'running',
      eventsTitle: 'Event catalog',
      colEvent: 'Event',
      colOfficial: 'Official mechanism',
      colInterceptable: 'Interception',
      colSubscribers: 'Subscribers',
      colTriggers: 'Triggers',
      colDuration: 'Total time',
      intercept: 'intercept',
      observe: 'observe',
      subscribersTitle: 'Subscribers',
      subscribersEmpty: 'No subscriptions yet. Other plugins subscribe via ctx.hooksBus.on(...) or a declarative manifest.',
      colId: 'ID',
      colSource: 'Source',
      colPriority: 'Priority',
      colTimeout: 'Timeout',
      colStatus: 'Status',
      pausedAction: 'Paused (click to resume)',
      runningAction: 'Running (click to pause)',
      logsTitle: 'Dispatch log',
      filterAll: 'All events',
      filterBySubscriber: 'Filter by subscriber ID',
      colSeq: '#',
      colTime: 'Time',
      colSession: 'Session',
      colDecision: 'Decision',
      loading: 'Loading…',
      stateError: 'Cannot read bus state',
      pauseLabel: 'Master switch (off pauses the whole bus)',
    }

    const zh = {
      tab: 'Hooks Bus',
      title: 'Hooks Bus',
      pausedBadge: '总线已全局暂停',
      runningBadge: '运行中',
      eventsTitle: '事件目录',
      colEvent: '事件',
      colOfficial: '官方机制',
      colInterceptable: '可拦截',
      colSubscribers: '订阅者',
      colTriggers: '累计触发',
      colDuration: '总耗时',
      intercept: '拦截',
      observe: '观察',
      subscribersTitle: '订阅者',
      subscribersEmpty: '暂无订阅。其他插件可通过 ctx.hooksBus.on(...) 或声明式清单订阅。',
      colId: 'ID',
      colSource: '来源',
      colPriority: '优先级',
      colTimeout: '超时',
      colStatus: '状态',
      pausedAction: '已停用（点击启用）',
      runningAction: '运行中（点击停用）',
      logsTitle: '执行日志',
      filterAll: '全部事件',
      filterBySubscriber: '按订阅者 ID 过滤',
      colSeq: '#',
      colTime: '时间',
      colSession: '会话',
      colDecision: '决策',
      loading: '加载中…',
      stateError: '无法读取总线状态',
      pauseLabel: '总线总开关（关闭即全局暂停）',
    }

    const css = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '16px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      row: { display: 'flex', alignItems: 'center', gap: '12px' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      subtitle: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        margin: 0,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      cardTitle: {
        fontSize: '13px',
        fontWeight: 600,
        margin: 0,
        color: 'var(--dsw-alias-label-primary)',
      },
      table: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px',
      },
      th: {
        textAlign: 'left',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 500,
        padding: '4px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      td: { padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      mono: { fontFamily: 'monospace', fontSize: '11px' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      switch: {
        position: 'relative',
        width: '36px',
        height: '20px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        cursor: 'pointer',
        padding: 0,
      },
      switchKnob: {
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '14px',
        height: '14px',
        borderRadius: '7px',
        transition: 'left 120ms ease',
      },
      badge: {
        display: 'inline-block',
        borderRadius: '4px',
        padding: '1px 6px',
        fontSize: '11px',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      select: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '4px 8px',
        fontSize: '12px',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '4px 8px',
        fontSize: '12px',
      },
    }

    async function fetchJson(path, options) {
      const response = await fetch(path, options)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response.json()
    }

    function postPause(paused) {
      return fetchJson('/api/hooks-bus/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused }),
      })
    }

    function postSubscription(id, paused) {
      return fetchJson('/api/hooks-bus/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, paused }),
      })
    }

    function Switch(props) {
      const { checked, onToggle, label } = props
      const knob = {
        ...css.switchKnob,
        left: checked ? '18px' : '2px',
        background: checked
          ? 'var(--dsw-alias-brand-primary)'
          : 'var(--dsw-alias-state-idle-primary)',
      }
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          style: css.switch,
          onClick: onToggle,
        },
        h('span', { style: knob }),
      )
    }

    function Badge(props) {
      const { text, color } = props
      return h(
        'span',
        {
          style: {
            ...css.badge,
            color,
            border: `1px solid ${color}`,
          },
        },
        text,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'hooks-bus: dictionaries',
        )
        const t = ctx.locale.bind(NS)

        function HooksBusPage() {
          const [state, setState] = React.useState(null)
          const [error, setError] = React.useState('')
          const [eventFilter, setEventFilter] = React.useState('all')
          const [subscriberFilter, setSubscriberFilter] = React.useState('')

          React.useEffect(() => {
            let alive = true
            const load = () => {
              fetchJson('/api/hooks-bus/state')
                .then((next) => {
                  if (alive) {
                    setState(next)
                    setError('')
                  }
                })
                .catch((reason) => {
                  if (alive) {
                    setError(String(reason))
                  }
                })
            }
            load()
            const handle = setInterval(load, 5000)
            return () => {
              alive = false
              clearInterval(handle)
            }
          }, [])

          if (error !== '') {
            return h(
              'div',
              { style: css.wrap },
              h('p', { style: css.error }, `${t('stateError')}：${error}`),
            )
          }
          if (state === null) {
            return h('div', { style: css.wrap }, h('p', { style: css.subtitle }, t('loading')))
          }

          const events = state.events ?? []
          const subscriptions = state.subscriptions ?? []
          const logs = (state.logs ?? []).filter((record) => {
            if (eventFilter !== 'all' && record.event !== eventFilter) {
              return false
            }
            if (subscriberFilter !== '') {
              const ids = (record.subscribers ?? []).map((entry) => String(entry.subscriptionId))
              if (!ids.includes(subscriberFilter)) {
                return false
              }
            }
            return true
          })

          const togglePause = () => {
            const next = !state.paused
            postPause(next)
              .then(() => setState({ ...state, paused: next }))
              .catch((reason) => setError(String(reason)))
          }

          const toggleSubscription = (id, paused) => {
            postSubscription(id, paused)
              .then(() => {
                setState({
                  ...state,
                  subscriptions: state.subscriptions.map((entry) =>
                    entry.id === id ? { ...entry, paused } : entry,
                  ),
                })
              })
              .catch((reason) => setError(String(reason)))
          }

          return h(
            'div',
            { style: css.wrap },
            h(
              'div',
              { style: css.row },
              h('h2', { style: css.title }, t('title')),
              h(
                'p',
                { style: css.subtitle },
                `catalog v${state.catalogVersion} · ${state.paused ? t('pausedBadge') : t('runningBadge')}`,
              ),
              Switch({
                // Switch reads as "bus enabled": ON = running, OFF = paused.
                checked: !state.paused,
                onToggle: togglePause,
                label: t('pauseLabel'),
              }),
            ),
            h(
              'section',
              { style: css.card },
              h('h3', { style: css.cardTitle }, t('eventsTitle')),
              h(
                'table',
                { style: css.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: css.th }, t('colEvent')),
                    h('th', { style: css.th }, t('colOfficial')),
                    h('th', { style: css.th }, t('colInterceptable')),
                    h('th', { style: css.th }, t('colSubscribers')),
                    h('th', { style: css.th }, t('colTriggers')),
                    h('th', { style: css.th }, t('colDuration')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  events.map((event) =>
                    h(
                      'tr',
                      { key: event.name },
                      h('td', { style: { ...css.td, ...css.mono } }, event.name),
                      h('td', { style: { ...css.td, ...css.mono } }, event.official),
                      h(
                        'td',
                        { style: css.td },
                        Badge({
                          text: event.interceptable ? t('intercept') : t('observe'),
                          color: event.interceptable
                            ? 'var(--dsw-alias-state-warn-primary)'
                            : 'var(--dsw-alias-state-idle-primary)',
                        }),
                      ),
                      h('td', { style: css.td }, `${event.activeSubscribers}/${event.subscribers}`),
                      h('td', { style: css.td }, String(event.stats?.count ?? 0)),
                      h('td', { style: css.td }, `${event.stats?.totalDurationMs ?? 0}ms`),
                    ),
                  ),
                ),
              ),
            ),
            h(
              'section',
              { style: css.card },
              h('h3', { style: css.cardTitle }, t('subscribersTitle')),
              subscriptions.length === 0
                ? h('p', { style: css.subtitle }, t('subscribersEmpty'))
                : h(
                    'table',
                    { style: css.table },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', { style: css.th }, t('colId')),
                        h('th', { style: css.th }, t('colEvent')),
                        h('th', { style: css.th }, t('colSource')),
                        h('th', { style: css.th }, t('colPriority')),
                        h('th', { style: css.th }, t('colTimeout')),
                        h('th', { style: css.th }, t('colStatus')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      subscriptions.map((entry) =>
                        h(
                          'tr',
                          { key: entry.id },
                          h('td', { style: { ...css.td, ...css.mono } }, String(entry.id)),
                          h('td', { style: { ...css.td, ...css.mono } }, entry.event),
                          h('td', { style: css.td }, entry.label),
                          h('td', { style: css.td }, String(entry.priority)),
                          h('td', { style: css.td }, `${entry.timeoutMs}ms`),
                          h(
                            'td',
                            { style: css.td },
                            h(
                              'button',
                              {
                                type: 'button',
                                style: css.button,
                                onClick: () => toggleSubscription(entry.id, !entry.paused),
                              },
                              entry.paused ? t('pausedAction') : t('runningAction'),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
            ),
            h(
              'section',
              { style: css.card },
              h('h3', { style: css.cardTitle }, t('logsTitle')),
              h(
                'div',
                { style: css.row },
                h(
                  'select',
                  {
                    style: css.select,
                    value: eventFilter,
                    onChange: (change) => setEventFilter(change.target.value),
                  },
                  h('option', { value: 'all' }, t('filterAll')),
                  ...events.map((event) =>
                    h('option', { key: event.name, value: event.name }, event.name),
                  ),
                ),
                h('input', {
                  style: css.input,
                  placeholder: t('filterBySubscriber'),
                  value: subscriberFilter,
                  onChange: (change) => setSubscriberFilter(change.target.value),
                }),
              ),
              h(
                'table',
                { style: css.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: css.th }, t('colSeq')),
                    h('th', { style: css.th }, t('colTime')),
                    h('th', { style: css.th }, t('colEvent')),
                    h('th', { style: css.th }, t('colSession')),
                    h('th', { style: css.th }, t('colDuration')),
                    h('th', { style: css.th }, t('colDecision')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  logs.slice(0, 100).map((record) =>
                    h(
                      'tr',
                      { key: record.seq },
                      h('td', { style: { ...css.td, ...css.mono } }, String(record.seq)),
                      h('td', { style: css.td }, new Date(record.time).toLocaleTimeString()),
                      h('td', { style: { ...css.td, ...css.mono } }, record.event),
                      h('td', { style: { ...css.td, ...css.mono } }, record.sessionId ?? '-'),
                      h('td', { style: css.td }, `${record.durationMs}ms`),
                      h('td', { style: { ...css.td, ...css.mono } }, record.decision),
                    ),
                  ),
                ),
              ),
            ),
          )
        }

        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'hooks-bus',
              order: 50,
              label: () => t('tab'),
              locale: NS,
            },
            HooksBusPage,
          ),
        )
      },
    }
  },
})

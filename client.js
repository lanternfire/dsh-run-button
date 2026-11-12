/**
 * dsh-run-button — browser half.
 *
 * One compact header button sitting immediately left of the open-in-app
 * control. It launches the script bound in `.dsh/run-button.json`, exactly
 * like double-clicking that file in Explorer.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-run-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-run-button'
    const SLOT = 'conversation.session.header.utilities'
    const API = '/api/dsh-run-button'
    const POLL_MS = 3000
    const FLASH_MS = 1500

    const DICT = {
      zh: {
        'button.label': '运行启动脚本',
        'run.title': '启动：{file}',
        'run.unbound': '未绑定启动脚本',
        'run.unboundHint': '未绑定 · 发现 {candidate}',
        'run.missing': '启动脚本不存在：{file}',
        'run.noWorkspace': '当前会话没有工作目录',
        'run.failed': '启动失败',
        'run.started': '已启动：{file}',
      },
      en: {
        'button.label': 'Run start script',
        'run.title': 'Run: {file}',
        'run.unbound': 'No start script bound',
        'run.unboundHint': 'Not bound · found {candidate}',
        'run.missing': 'Start script missing: {file}',
        'run.noWorkspace': 'No working directory for this session',
        'run.failed': 'Failed to start',
        'run.started': 'Started: {file}',
      },
    }

    const CSS = `
      .dsh-rb { box-sizing: border-box; display: inline-flex; align-items: stretch;
        border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
        height: 24px; overflow: hidden; font-family: var(--dsw-font-family); }
      .dsh-rb-button { display: inline-flex; align-items: center; justify-content: center;
        gap: 4px; padding: 3px 5px; margin: 0; font-size: 11px; line-height: 16px;
        border: 0; background: 0 0; color: var(--dsw-alias-label-primary);
        cursor: pointer; white-space: nowrap; }
      .dsh-rb-button:hover:not(:disabled),
      .dsh-rb-button:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-rb-button:disabled { cursor: default; color: var(--dsw-alias-label-secondary); opacity: .55; }
      .dsh-rb[data-flash='true'] .dsh-rb-button { color: var(--dsw-alias-state-success-primary); }
      .dsh-rb[data-state='error'] .dsh-rb-button { color: var(--dsw-alias-state-error-primary); }
    `

    function PlayIcon() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M5.35 3.28a.9.9 0 0 1 1.37-.77l6.4 4.72a.9.9 0 0 1 0 1.54l-6.4 4.72a.9.9 0 0 1-1.37-.77z',
          fill: 'currentColor',
        }),
      )
    }

    async function callRoute(route, init) {
      const response = await fetch(`${API}/${route}`, init)
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (response.ok !== true || body === null || body.ok !== true) {
        throw new Error(body?.error ?? `http-${response.status}`)
      }
      return body
    }

    function createButton(t) {
      return function RunButton(props) {
        const { sessionId, useSessions } = props
        const cwd =
          typeof useSessions === 'function'
            ? useSessions((state) => state.byId[sessionId]?.cwd)
            : undefined
        const [view, setView] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [flash, setFlash] = React.useState(false)
        const [failure, setFailure] = React.useState(null)

        React.useEffect(() => {
          if (cwd === undefined || cwd === null || cwd === '') {
            setView(null)
            return undefined
          }
          let live = true
          const load = () => {
            callRoute(`state?cwd=${encodeURIComponent(cwd)}`)
              .then((next) => {
                if (live) {
                  setView(next)
                  setFailure(null)
                }
              })
              .catch(() => {
                if (live) setFailure('unreachable')
              })
          }
          load()
          const timer = setInterval(load, POLL_MS)
          return () => {
            live = false
            clearInterval(timer)
          }
        }, [cwd])

        const state = failure !== null ? 'error' : (view?.state ?? 'unbound')
        const enabled = state === 'ready' && busy !== true
        const label =
          state === 'ready'
            ? t('run.title', { file: view.file })
            : state === 'missing'
              ? t('run.missing', { file: view.file })
              : state === 'unbound'
                ? view?.candidate
                  ? t('run.unboundHint', { candidate: view.candidate })
                  : t('run.unbound')
                : failure !== null
                  ? t('run.failed')
                  : t('run.noWorkspace')

        const onRun = () => {
          if (!enabled || typeof cwd !== 'string') return
          setBusy(true)
          callRoute('run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cwd }),
          })
            .then(() => {
              setFlash(true)
              setFailure(null)
              setTimeout(() => setFlash(false), FLASH_MS)
            })
            .catch(() => setFailure('launch'))
            .finally(() => setBusy(false))
        }

        return h(
          'div',
          {
            className: 'dsh-rb',
            'data-state': state,
            'data-flash': flash ? 'true' : 'false',
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-rb-button',
              disabled: enabled !== true,
              title: label,
              'aria-label': label,
              onClick: onRun,
            },
            h(PlayIcon),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-plugin', '@local/dsh-run-button')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'run-button: styles')

        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', DICT.zh)
          const disposeEn = ctx.locale.register(NS, 'en', DICT.en)
          return () => {
            disposeZh()
            disposeEn()
          }
        }, 'run-button: locale')

        const t = ctx.locale.bind(NS)
        const RunButton = createButton(t)

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'run-button',
              order: -11,
              label: () => t('button.label'),
            },
            RunButton,
          ),
        )
      },
    }
  },
})

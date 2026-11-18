/**
 * Browser half of the layout-governor bundle.
 *
 * It renders one sidebar panel titled "Layout": the space composition of the
 * audited tree, the findings of the last scan, and which rules produced them.
 * Every byte shown comes from the Host route; the panel never reads the disk
 * and never computes a verdict of its own, so the panel and the `layout_audit`
 * tool can never disagree.
 */
window.__ModuleLoader__.load({
  id: 'dsh-layout-governor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'dsh-layout-governor'
    const ROUTE = 'api/layout-governor/report'

    /** Client context captured by `apply`; the panel never receives it as a prop. */
    let clientContext = null

    /** Flat dictionaries: the locale registry stores key to template string. */
    const EN = {
      'panel.title': 'Layout',
      'panel.rescan': 'Scan again',
      'panel.scanning': 'Scanning…',
      'panel.failed': 'Scan failed',
      'panel.clean': 'No findings. The tree matches the policy.',
      'panel.composition': 'Space by class',
      'panel.findings': 'Findings',
      'panel.suggestion': 'Suggestion',
      'panel.paths': 'Paths',
      'panel.rules': 'Rules',
      'panel.footer': 'Read-only scan · {files} files · {bytes} · {ms} ms',
      'panel.showAll': 'Show all {count}',
      'panel.showLess': 'Show less',
      'panel.fixPlanHint': 'The fix plan is generated, never executed: run layout-governor --fix-plan in a terminal.',
      'panel.root': 'Root',
      'overall.fail': 'Needs action',
      'overall.warn': 'Worth a look',
      'overall.pass': 'Compliant',
      'class.regenerable': 'Regenerable',
      'class.backup': 'Backup',
      'class.protected': 'Protected',
      'class.canonical': 'Canonical',
      'class.unknown': 'Other',
    }

    const ZH = {
      'panel.title': '目录',
      'panel.rescan': '重新扫描',
      'panel.scanning': '扫描中…',
      'panel.failed': '扫描失败',
      'panel.clean': '没有发现问题，盘面与策略一致。',
      'panel.composition': '空间构成',
      'panel.findings': '问题清单',
      'panel.suggestion': '建议',
      'panel.paths': '路径',
      'panel.rules': '规则',
      'panel.footer': '只读扫描 · {files} 个文件 · {bytes} · {ms} ms',
      'panel.showAll': '展开全部 {count} 条',
      'panel.showLess': '收起',
      'panel.fixPlanHint': '修复方案只生成不执行：在终端跑 layout-governor --fix-plan 查看。',
      'panel.root': '根目录',
      'overall.fail': '需要处理',
      'overall.warn': '值得一看',
      'overall.pass': '合规',
      'class.regenerable': '可再生',
      'class.backup': '备份',
      'class.protected': '保护',
      'class.canonical': '正典',
      'class.unknown': '其它',
    }

    const SEVERITY_COLOR = { fail: '#d9424a', warn: '#d98324', info: '#5a7d9a' }
    const CLASS_COLOR = {
      regenerable: '#3f8f6b',
      backup: '#8a6fb0',
      protected: '#c2506b',
      canonical: '#3f74b0',
      unknown: '#8a8f98',
    }
    const MUTED = 'var(--color-text-secondary, rgba(128,128,128,0.95))'
    const BORDER = 'rgba(127,127,127,0.24)'
    const MONO = 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

    /**
     * Interpolate `{name}` placeholders in a template.
     * @param template - dictionary value.
     * @param params - replacement values.
     * @returns the rendered string.
     */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined ? match : String(params[key]),
      )
    }

    /**
     * Build a translator that prefers the Client locale service and degrades to
     * the embedded dictionaries when the registry rejects a key.
     * @param ctx - client context.
     * @returns a `t(key, params)` function.
     */
    function makeTranslator(ctx) {
      const local = (key, params) => {
        const template = EN[key] ?? key
        return interpolate(template, params)
      }
      try {
        const locale = ctx.locale
        if (locale !== undefined && typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          return (key, params) => {
            let text
            try {
              text = bound(key, params)
            } catch {
              return local(key, params)
            }
            if (typeof text !== 'string' || text === '' || text === key) return local(key, params)
            return text
          }
        }
      } catch {
        // The locale service is optional for a panel that must still render.
      }
      return local
    }

    /**
     * Format a byte count with a binary unit, one decimal above KiB.
     * @param bytes - size in bytes.
     * @returns a compact human string.
     */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
      let index = 0
      let scaled = value
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      const digits = index === 0 ? 0 : scaled >= 100 ? 0 : 1
      return `${scaled.toFixed(digits)} ${units[index]}`
    }

    /**
     * Shorten an absolute path for a narrow pane, keeping the tail.
     * @param value - path.
     * @returns the shortened path.
     */
    function tail(value) {
      const text = String(value ?? '')
      return text.length <= 62 ? text : `…${text.slice(-61)}`
    }

    /**
     * Fetch one report from the Host route.
     * @param force - bypass the Host cache.
     * @returns the route payload.
     */
    async function requestReport(force) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force === true ? { force: true } : {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? 'unexpected response')
      }
      return payload.value
    }

    /** One stacked bar; segment widths are proportional to class bytes. */
    function CompositionBar({ classes, t }) {
      const visible = classes.filter((entry) => entry.bytes > 0)
      const total = visible.reduce((sum, entry) => sum + entry.bytes, 0)
      if (total <= 0) return null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              height: 8,
              borderRadius: 999,
              overflow: 'hidden',
              background: 'rgba(127,127,127,0.16)',
            },
            role: 'img',
            'aria-label': t('panel.composition'),
          },
          visible.map((entry) =>
            h('div', {
              key: entry.id,
              title: `${entry.label ?? entry.id}: ${formatBytes(entry.bytes)}`,
              style: {
                width: `${(entry.bytes / total) * 100}%`,
                background: CLASS_COLOR[entry.id] ?? CLASS_COLOR.unknown,
              },
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11, color: MUTED } },
          visible.map((entry) =>
            h(
              'span',
              { key: entry.id, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', {
                style: {
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: CLASS_COLOR[entry.id] ?? CLASS_COLOR.unknown,
                },
              }),
              `${t(`class.${entry.id}`)} ${formatBytes(entry.bytes)}`,
            ),
          ),
        ),
      )
    }

    /** One finding row: severity dot, title, and an expandable body. */
    function FindingRow({ finding, t }) {
      const [open, setOpen] = useState(false)
      const color = SEVERITY_COLOR[finding.severity] ?? SEVERITY_COLOR.info
      return h(
        'div',
        { style: { borderTop: `1px solid ${BORDER}`, padding: '7px 0' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 7,
              width: '100%',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          h('span', {
            style: {
              flex: '0 0 auto',
              width: 7,
              height: 7,
              marginTop: 5,
              borderRadius: '50%',
              background: color,
            },
          }),
          h(
            'span',
            { style: { flex: '1 1 auto', fontSize: 12, lineHeight: 1.45 } },
            finding.title,
            h('span', { style: { color: MUTED, marginLeft: 6, fontSize: 11 } }, finding.rule),
          ),
          h('span', { style: { color: MUTED, fontSize: 11 } }, open ? '▾' : '▸'),
        ),
        open
          ? h(
              'div',
              { style: { paddingLeft: 14, marginTop: 5, display: 'flex', flexDirection: 'column', gap: 5 } },
              h('div', { style: { fontSize: 11.5, lineHeight: 1.5, color: MUTED } }, finding.detail),
              finding.suggestion !== undefined
                ? h(
                    'div',
                    { style: { fontSize: 11.5, lineHeight: 1.5 } },
                    h('strong', { style: { fontSize: 11, letterSpacing: 0.2 } }, `${t('panel.suggestion')}: `),
                    finding.suggestion,
                  )
                : null,
              (finding.paths ?? []).length > 0
                ? h(
                    'div',
                    { style: { fontSize: 11, color: MUTED, fontFamily: MONO, lineHeight: 1.6 } },
                    (finding.paths ?? []).slice(0, 6).map((value) =>
                      h('div', { key: value, title: value }, tail(value)),
                    ),
                    (finding.paths ?? []).length > 6
                      ? h('div', {}, `+${finding.paths.length - 6}`)
                      : null,
                  )
                : null,
            )
          : null,
      )
    }

    /** The panel registered into `sidebar.panellist`. */
    function LayoutPanel() {
      const [state, setState] = useState({ phase: 'loading' })
      const [showAll, setShowAll] = useState(false)
      const t = useMemo(() => makeTranslator(clientContext ?? {}), [])

      const scan = useCallback((force) => {
        setState((previous) =>
          previous.phase === 'ready' ? { ...previous, phase: 'refreshing' } : { phase: 'loading' },
        )
        requestReport(force)
          .then((report) => setState({ phase: 'ready', report }))
          .catch((error) =>
            setState({ phase: 'error', message: String(error?.message ?? error) }),
          )
      }, [])

      useEffect(() => {
        scan(false)
      }, [scan])

      const report = state.report
      const scanning = state.phase === 'loading' || state.phase === 'refreshing'
      const findings = report?.findings ?? []
      const shown = showAll ? findings : findings.slice(0, 8)

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('div', { style: { flex: '1 1 auto', fontSize: 12, fontWeight: 600 } }, t('panel.title')),
        h(
          'button',
          {
            type: 'button',
            onClick: () => scan(true),
            disabled: scanning,
            title: t('panel.rescan'),
            'aria-label': t('panel.rescan'),
            style: {
              border: `1px solid ${BORDER}`,
              background: 'transparent',
              color: 'inherit',
              borderRadius: 6,
              fontSize: 11,
              padding: '2px 7px',
              cursor: scanning ? 'default' : 'pointer',
              opacity: scanning ? 0.6 : 1,
            },
          },
          scanning ? '…' : '⟳',
        ),
      )

      const body = (() => {
        if (state.phase === 'error') {
          return h(
            'div',
            { style: { fontSize: 11.5, color: SEVERITY_COLOR.fail, lineHeight: 1.5 } },
            h('div', { style: { fontWeight: 600 } }, t('panel.failed')),
            h('div', { style: { color: MUTED, wordBreak: 'break-word' } }, state.message),
          )
        }
        if (report === undefined) {
          return h('div', { style: { fontSize: 11.5, color: MUTED } }, t('panel.scanning'))
        }
        const verdict = h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h(
            'span',
            {
              style: {
                fontSize: 11,
                fontWeight: 600,
                padding: '1px 7px',
                borderRadius: 999,
                color: '#fff',
                background: SEVERITY_COLOR[report.overall] ?? SEVERITY_COLOR.info,
              },
            },
            t(`overall.${report.overall}`),
          ),
          h(
            'span',
            { style: { fontSize: 11, color: MUTED } },
            `fail ${report.counts.fail} · warn ${report.counts.warn} · info ${report.counts.info}`,
          ),
        )
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
          verdict,
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            h('div', { style: { fontSize: 11, color: MUTED } }, t('panel.composition')),
            h(CompositionBar, { classes: report.composition?.classes ?? [], t }),
          ),
          findings.length === 0
            ? h('div', { style: { fontSize: 11.5, color: MUTED } }, t('panel.clean'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column' } },
                h(
                  'div',
                  { style: { fontSize: 11, color: MUTED, paddingBottom: 2 } },
                  `${t('panel.findings')} (${findings.length})`,
                ),
                shown.map((finding) => h(FindingRow, { key: finding.id, finding, t })),
                findings.length > 8
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => setShowAll((value) => !value),
                        style: {
                          marginTop: 5,
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          fontSize: 11,
                          textDecoration: 'underline',
                          cursor: 'pointer',
                          padding: 0,
                          textAlign: 'left',
                          opacity: 0.75,
                        },
                      },
                      showAll ? t('panel.showLess') : t('panel.showAll', { count: findings.length }),
                    )
                  : null,
              ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '3px 6px', fontSize: 10.5, color: MUTED } },
            (report.rules ?? []).map((rule) =>
              h(
                'span',
                {
                  key: rule.id,
                  title: `${rule.id} · ${rule.severity} · ${rule.findings}`,
                  style: {
                    padding: '0 5px',
                    borderRadius: 4,
                    border: `1px solid ${BORDER}`,
                    opacity: rule.enabled ? 1 : 0.45,
                  },
                },
                `${rule.id}${rule.enabled ? '' : ' · off'}`,
              ),
            ),
          ),
          h(
            'div',
            { style: { fontSize: 10.5, color: MUTED, lineHeight: 1.5, wordBreak: 'break-word' } },
            h('div', { title: report.root }, `${t('panel.root')}: ${tail(report.root)}`),
            t('panel.footer', {
              files: report.stats?.files ?? 0,
              bytes: formatBytes(report.stats?.bytes ?? 0),
              ms: report.stats?.durationMs ?? 0,
            }),
          ),
          h('div', { style: { fontSize: 10.5, color: MUTED, lineHeight: 1.5 } }, t('panel.fixPlanHint')),
        )
      })()

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px 12px 14px',
            fontSize: 12,
            color: 'inherit',
            height: '100%',
            overflowY: 'auto',
            boxSizing: 'border-box',
          },
        },
        header,
        body,
      )
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        clientContext = ctx
        let t = (key) => key
        try {
          t = makeTranslator(ctx)
          const locale = ctx.locale
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, 'en', EN), 'layout-governor: en dictionary')
            ctx.effect(() => locale.register(NS, 'zh', ZH), 'layout-governor: zh dictionary')
          }
        } catch {
          // Rendering falls back to the embedded English copy.
        }
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: NS,
              order: 40,
              label: () => t('panel.title'),
              locale: NS,
            },
            LayoutPanel,
          ),
        )
      },
    }
  },
})

/**
 * Browser half of the layout-governor bundle.
 *
 * One sidebar panel titled "Layout": the space composition of the audited tree,
 * the findings of the last scan, and which rules produced them. Every byte shown
 * comes from the Host route; the panel never reads the disk and never computes a
 * verdict of its own, so the panel and the `layout_audit` tool cannot disagree.
 *
 * The module is one file because the Web loader hands a client bundle
 * `require('react')` and nothing else — there is no relative import table to split
 * across files. Three things keep it navigable instead: one `STYLES` table rather
 * than inline literals in every element, pure helpers at the top (re-exported under
 * `helpers` so the Node test can reach them without a browser), and one component
 * per visual block.
 */
window.__ModuleLoader__.load({
  id: 'dsh-layout-governor',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useState } = React;
    const h = React.createElement;

    const NS = 'dsh-layout-governor';
    const ROUTE = 'api/layout-governor/report';
    const VISIBLE_FINDINGS = 8;
    /** Panel refresh cadence; the Host cache makes most ticks free. */
    const PANEL_POLL_MS = 15_000;
    const MAX_PATH = 62;

    /** Client context captured by `apply`; the panel never receives it as a prop. */
    let clientContext = null;

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
      'panel.rules': 'Rules',
      'panel.footer': 'Read-only scan · {files} files · {bytes} · {ms} ms',
      'panel.root': 'Root',
      'panel.showAll': 'Show all {count}',
      'panel.showLess': 'Show less',
      'panel.fixPlanHint':
        'The fix plan is generated, never executed: run layout-governor --fix-plan in a terminal.',
      'panel.autofixLive': 'Self-healing on: misplaced backups are moved into _archive automatically.',
      'panel.bounded': 'Quick bounded scan (top of the tree) — rescan for the full picture.',
      'panel.autofixDry': 'Self-healing on, dry run: the plan is reported but nothing moves.',
      'overall.fail': 'Needs action',
      'overall.warn': 'Worth a look',
      'overall.pass': 'Compliant',
      'class.regenerable': 'Regenerable',
      'class.backup': 'Backup',
      'class.protected': 'Protected',
      'class.canonical': 'Canonical',
      'class.unknown': 'Other',
    };

    const ZH = {
      'panel.title': '目录',
      'panel.rescan': '重新扫描',
      'panel.scanning': '扫描中…',
      'panel.failed': '扫描失败',
      'panel.clean': '没有发现问题，盘面与策略一致。',
      'panel.composition': '空间构成',
      'panel.findings': '问题清单',
      'panel.suggestion': '建议',
      'panel.rules': '规则',
      'panel.footer': '只读扫描 · {files} 个文件 · {bytes} · {ms} ms',
      'panel.root': '根目录',
      'panel.showAll': '展开全部 {count} 条',
      'panel.showLess': '收起',
      'panel.fixPlanHint': '修复方案只生成不执行：在终端跑 layout-governor --fix-plan 查看。',
      'panel.autofixLive': '自愈已开：位置错误的备份会被自动收进 _archive。',
      'panel.autofixDry': '自愈已开但为试运行：只出方案，不搬文件。',
      'panel.bounded': '本次是快速的有限扫描（只看树的浅层）——要看全貌请点重新扫描。',
      'overall.fail': '需要处理',
      'overall.warn': '值得一看',
      'overall.pass': '合规',
      'class.regenerable': '可再生',
      'class.backup': '备份',
      'class.protected': '保护',
      'class.canonical': '正典',
      'class.unknown': '其它',
    };

    const SEVERITY_COLOR = { fail: '#d9424a', warn: '#d98324', info: '#5a7d9a' };
    const CLASS_COLOR = {
      regenerable: '#3f8f6b',
      backup: '#8a6fb0',
      protected: '#c2506b',
      canonical: '#3f74b0',
      unknown: '#8a8f98',
    };
    const MUTED = 'var(--color-text-secondary, rgba(128,128,128,0.95))';
    const BORDER = 'rgba(127,127,127,0.24)';
    const MONO = 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

    /**
     * Every style the panel uses. Colours come from theme tokens with neutral
     * fallbacks so the pane follows light and dark mode without a stylesheet.
     */
    const STYLES = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px 14px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        fontSize: 12,
        color: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: 8 },
      title: { flex: '1 1 auto', fontSize: 12, fontWeight: 600 },
      iconButton: {
        padding: '2px 7px',
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      body: { display: 'flex', flexDirection: 'column', gap: 9 },
      section: { display: 'flex', flexDirection: 'column', gap: 5 },
      label: { fontSize: 11, color: MUTED },
      empty: { fontSize: 11.5, color: MUTED },
      verdictRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      verdictBadge: {
        fontSize: 11,
        fontWeight: 600,
        padding: '1px 7px',
        borderRadius: 999,
        color: '#fff',
      },
      verdictCounts: { fontSize: 11, color: MUTED },
      barTrack: {
        display: 'flex',
        height: 8,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'rgba(127,127,127,0.16)',
      },
      legend: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', fontSize: 11, color: MUTED },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      legendSwatch: { width: 7, height: 7, borderRadius: 2 },
      findings: { display: 'flex', flexDirection: 'column' },
      row: { borderTop: `1px solid ${BORDER}`, padding: '7px 0' },
      rowButton: {
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
      dot: { flex: '0 0 auto', width: 7, height: 7, marginTop: 5, borderRadius: '50%' },
      rowTitle: { flex: '1 1 auto', fontSize: 12, lineHeight: 1.45 },
      rowRule: { color: MUTED, marginLeft: 6, fontSize: 11 },
      chevron: { color: MUTED, fontSize: 11 },
      detail: {
        paddingLeft: 14,
        marginTop: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      },
      detailText: { fontSize: 11.5, lineHeight: 1.5, color: MUTED },
      suggestion: { fontSize: 11.5, lineHeight: 1.5 },
      suggestionLabel: { fontSize: 11, letterSpacing: 0.2 },
      paths: { fontSize: 11, color: MUTED, fontFamily: MONO, lineHeight: 1.6 },
      toggle: {
        marginTop: 5,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11,
        textDecoration: 'underline',
        cursor: 'pointer',
        textAlign: 'left',
        opacity: 0.75,
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '3px 6px', fontSize: 10.5, color: MUTED },
      chip: { padding: '0 5px', borderRadius: 4, border: `1px solid ${BORDER}` },
      error: { fontSize: 11.5, lineHeight: 1.5 },
      errorTitle: { fontWeight: 600 },
      errorMessage: { color: MUTED, wordBreak: 'break-word' },
      footer: { fontSize: 10.5, color: MUTED, lineHeight: 1.5, wordBreak: 'break-word' },
      hint: { fontSize: 10.5, color: MUTED, lineHeight: 1.5 },
    };

    /**
     * Interpolate `{name}` placeholders in a template.
     * @param {string} template Dictionary value.
     * @param {Record<string, unknown>} [params] Replacement values.
     * @returns {string} The rendered string.
     */
    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined ? match : String(params[key]),
      );
    }

    /**
     * Format a byte count with a binary unit, one decimal above KiB.
     * @param {number} bytes Size in bytes.
     * @returns {string} Compact human string.
     */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
      let index = 0;
      let scaled = value;
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
      }
      const digits = index === 0 || scaled >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits)} ${units[index]}`;
    }

    /**
     * Shorten an absolute path for a narrow pane, keeping the tail.
     * @param {unknown} value Path.
     * @returns {string} The shortened path.
     */
    function shortPath(value) {
      const text = String(value ?? '');
      return text.length <= MAX_PATH ? text : `…${text.slice(-(MAX_PATH - 1))}`;
    }

    /**
     * Which findings the panel currently shows.
     * @param {object[]} findings Report findings.
     * @param {boolean} expanded Whether the full list was requested.
     * @param {number} [limit] Collapsed row count.
     * @returns {{ shown: object[], hidden: number }} Visible rows and the remainder.
     */
    function pageFindings(findings, expanded, limit = VISIBLE_FINDINGS) {
      const all = Array.isArray(findings) ? findings : [];
      if (expanded === true) return { shown: all, hidden: 0 };
      return { shown: all.slice(0, limit), hidden: Math.max(0, all.length - limit) };
    }

    /**
     * Build a translator that prefers the Client locale service and degrades to
     * the embedded English copy when the registry rejects a key.
     * @param {object} ctx Client context.
     * @returns {(key: string, params?: Record<string, unknown>) => string} Translator.
     */
    function makeTranslator(ctx) {
      const local = (key, params) => interpolate(EN[key] ?? key, params);
      try {
        const locale = ctx?.locale;
        if (locale !== undefined && typeof locale.bind === 'function') {
          const bound = locale.bind(NS);
          return (key, params) => {
            let text;
            try {
              text = bound(key, params);
            } catch {
              return local(key, params);
            }
            if (typeof text !== 'string' || text === '' || text === key) return local(key, params);
            return text;
          };
        }
      } catch {
        // The locale service is optional for a panel that must still render.
      }
      return local;
    }

    /**
     * Fetch one report from the Host route.
     * @param {boolean} force Bypass the Host cache.
     * @returns {Promise<object>} The report value.
     */
    async function fetchReport(force) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(force === true ? { force: true } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? 'unexpected response');
      }
      return payload.value;
    }

    /** Verdict badge plus the three counters. */
    function VerdictLine({ report, t }) {
      return h(
        'div',
        { style: STYLES.verdictRow },
        h(
          'span',
          {
            style: {
              ...STYLES.verdictBadge,
              background: SEVERITY_COLOR[report.overall] ?? SEVERITY_COLOR.info,
            },
          },
          t(`overall.${report.overall}`),
        ),
        h(
          'span',
          { style: STYLES.verdictCounts },
          `fail ${report.counts.fail} · warn ${report.counts.warn} · info ${report.counts.info}`,
        ),
      );
    }

    /** One stacked bar; segment widths are proportional to class bytes. */
    function CompositionBar({ classes, t }) {
      const visible = (classes ?? []).filter((entry) => entry.bytes > 0);
      const total = visible.reduce((sum, entry) => sum + entry.bytes, 0);
      if (total <= 0) return null;
      return h(
        'div',
        { style: STYLES.section },
        h(
          'div',
          { role: 'img', 'aria-label': t('panel.composition'), style: STYLES.barTrack },
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
          { style: STYLES.legend },
          visible.map((entry) =>
            h(
              'span',
              { key: entry.id, style: STYLES.legendItem },
              h('span', {
                style: {
                  ...STYLES.legendSwatch,
                  background: CLASS_COLOR[entry.id] ?? CLASS_COLOR.unknown,
                },
              }),
              `${t(`class.${entry.id}`)} ${formatBytes(entry.bytes)}`,
            ),
          ),
        ),
      );
    }

    /** One finding row: severity dot, title, and an expandable body. */
    function FindingRow({ finding, t }) {
      const [open, setOpen] = useState(false);
      const paths = finding.paths ?? [];
      const detail = open
        ? h(
            'div',
            { style: STYLES.detail },
            h('div', { style: STYLES.detailText }, finding.detail),
            finding.suggestion !== undefined
              ? h(
                  'div',
                  { style: STYLES.suggestion },
                  h('strong', { style: STYLES.suggestionLabel }, `${t('panel.suggestion')}: `),
                  finding.suggestion,
                )
              : null,
            paths.length > 0
              ? h(
                  'div',
                  { style: STYLES.paths },
                  paths.slice(0, 6).map((value) => h('div', { key: value, title: value }, shortPath(value))),
                  paths.length > 6 ? h('div', {}, `+${paths.length - 6}`) : null,
                )
              : null,
          )
        : null;

      return h(
        'div',
        { style: STYLES.row },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            style: STYLES.rowButton,
          },
          h('span', {
            style: { ...STYLES.dot, background: SEVERITY_COLOR[finding.severity] ?? SEVERITY_COLOR.info },
          }),
          h(
            'span',
            { style: STYLES.rowTitle },
            finding.title,
            h('span', { style: STYLES.rowRule }, finding.rule),
          ),
          h('span', { style: STYLES.chevron }, open ? '▾' : '▸'),
        ),
        detail,
      );
    }

    /**
     * The findings block: rows, a show-all toggle, or the clean message.
     * @param {{ report: object, t: Function }} props Component props.
     * @returns {object} Element.
     */
    function FindingsBlock({ report, t }) {
      const [expanded, setExpanded] = useState(false);
      const findings = report.findings ?? [];
      if (findings.length === 0) return h('div', { style: STYLES.empty }, t('panel.clean'));
      const { shown } = pageFindings(findings, expanded);
      // Driven by the total, not by the remainder: once expanded the remainder is
      // zero, and a remainder-driven button could never collapse again.
      const overflow = findings.length > VISIBLE_FINDINGS;
      return h(
        'div',
        { style: STYLES.findings },
        h('div', { style: STYLES.label }, `${t('panel.findings')} (${findings.length})`),
        shown.map((finding) => h(FindingRow, { key: finding.id, finding, t })),
        overflow
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => setExpanded((value) => !value),
                style: STYLES.toggle,
              },
              expanded ? t('panel.showLess') : t('panel.showAll', { count: findings.length }),
            )
          : null,
      );
    }

    /** Rule chips: which rules ran, which were switched off by the policy. */
    function RuleChips({ rules }) {
      return h(
        'div',
        { style: STYLES.chips },
        (rules ?? []).map((rule) =>
          h(
            'span',
            {
              key: rule.id,
              title: `${rule.id} · ${rule.severity} · ${rule.findings}`,
              style: { ...STYLES.chip, opacity: rule.enabled ? 1 : 0.45 },
            },
            `${rule.id}${rule.enabled ? '' : ' · off'}`,
          ),
        ),
      );
    }

    /** Panel body for a loaded report. */
    function ReportBody({ report, t }) {
      return h(
        'div',
        { style: STYLES.body },
        h(VerdictLine, { report, t }),
        h(
          'div',
          { style: STYLES.section },
          h('div', { style: STYLES.label }, t('panel.composition')),
          h(CompositionBar, { classes: report.composition?.classes ?? [], t }),
        ),
        h(FindingsBlock, { report, t }),
        h('div', { style: STYLES.label }, t('panel.rules')),
        h(RuleChips, { rules: report.rules }),
        h(
          'div',
          { style: STYLES.footer },
          h('div', { title: report.root }, `${t('panel.root')}: ${shortPath(report.root)}`),
          t('panel.footer', {
            files: report.stats?.files ?? 0,
            bytes: formatBytes(report.stats?.bytes ?? 0),
            ms: report.stats?.durationMs ?? 0,
          }),
        ),
        report.stats?.truncated === true
          ? h('div', { style: STYLES.hint }, t('panel.bounded'))
          : null,
        report.autofix?.enabled === true
          ? h('div', { style: STYLES.hint }, t(report.autofix.dryRun === true ? 'panel.autofixDry' : 'panel.autofixLive'))
          : null,
        h('div', { style: STYLES.hint }, t('panel.fixPlanHint')),
      );
    }

    /** The panel registered into `sidebar.panellist`. */
    function LayoutPanel() {
      const [state, setState] = useState({ phase: 'loading' });
      const t = useMemo(() => makeTranslator(clientContext), []);

      const scan = useCallback((force) => {
        setState((previous) =>
          previous.phase === 'ready' ? { ...previous, phase: 'refreshing' } : { phase: 'loading' },
        );
        fetchReport(force)
          .then((report) => setState({ phase: 'ready', report }))
          .catch((error) => setState({ phase: 'error', message: String(error?.message ?? error) }));
      }, []);

      useEffect(() => {
        scan(false);
      }, [scan]);

      // The panel is a window onto the Host cache, so polling is cheap: the Host
      // only re-walks the tree when its own watcher fires or the report expires.
      // A hidden tab stays quiet, and a refocused one catches up immediately.
      useEffect(() => {
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          scan(false);
        };
        const handle = setInterval(tick, PANEL_POLL_MS);
        const onFocus = () => scan(false);
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('focus', onFocus);
        }
        return () => {
          clearInterval(handle);
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('focus', onFocus);
          }
        };
      }, [scan]);

      const scanning = state.phase === 'loading' || state.phase === 'refreshing';
      const header = h(
        'div',
        { style: STYLES.header },
        h('div', { style: STYLES.title }, t('panel.title')),
        h(
          'button',
          {
            type: 'button',
            onClick: () => scan(true),
            disabled: scanning,
            title: t('panel.rescan'),
            'aria-label': t('panel.rescan'),
            style: { ...STYLES.iconButton, cursor: scanning ? 'default' : 'pointer', opacity: scanning ? 0.6 : 1 },
          },
          scanning ? '…' : '⟳',
        ),
      );

      let body;
      if (state.phase === 'error') {
        body = h(
          'div',
          { style: { ...STYLES.error, color: SEVERITY_COLOR.fail } },
          h('div', { style: STYLES.errorTitle }, t('panel.failed')),
          h('div', { style: STYLES.errorMessage }, state.message),
        );
      } else if (state.report === undefined) {
        body = h('div', { style: STYLES.empty }, t('panel.scanning'));
      } else {
        body = h(ReportBody, { report: state.report, t });
      }

      return h('div', { style: STYLES.panel }, header, body);
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      /**
       * Pure helpers and the presentational blocks, exported so the Node test can
       * render them without a browser. Nothing here reads the DOM or the network.
       */
      helpers: {
        interpolate,
        formatBytes,
        shortPath,
        pageFindings,
        makeTranslator,
        components: { VerdictLine, CompositionBar, FindingRow, FindingsBlock, RuleChips, ReportBody },
      },
      apply(ctx) {
        clientContext = ctx;
        let t = (key) => key;
        try {
          t = makeTranslator(ctx);
          const locale = ctx.locale;
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, 'en', EN), 'layout-governor: en dictionary');
            ctx.effect(() => locale.register(NS, 'zh', ZH), 'layout-governor: zh dictionary');
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
        );
      },
    };
  },
});

/**
 * Structural test for the Client half.
 *
 * There is no browser in this environment, so the panel is verified the way a
 * headless plugin check can verify it: load the module exactly as the Web app
 * loads it (`window.__ModuleLoader__.load`), hand it a stub React and a recording
 * Client context, and assert the registration contract — one `sidebar.panellist`
 * entry, a callable label, both dictionaries registered, and a render function
 * that produces a tree instead of throwing.
 *
 * This does not prove what the panel looks like. It proves the module cannot take
 * the page down when it is activated.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * Minimal React stand-in: element factory plus the five hooks the panel uses.
 * `useEffect` deliberately does not run, so the panel stays in its first state.
 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useEffect() {},
};

/**
 * Walk a stub element tree and collect every rendered string.
 * @param {unknown} node Element, array, or scalar.
 * @param {string[]} out Collected strings.
 * @returns {string[]} the same array.
 */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out);
    return out;
  }
  if (typeof node === 'object' && 'type' in node) {
    // A function element is a component: call it, then walk what it returned.
    if (typeof node.type === 'function') return texts(node.type(node.props ?? {}), out);
    for (const child of node.children ?? []) texts(child, out);
  }
  return out;
}

/**
 * Load `lib/client.js` exactly as the Web app does, once per test process.
 *
 * ES modules are cached, so the `window.__ModuleLoader__.load` call only happens
 * on the first import; later imports must reuse the captured registration.
 * @returns {Promise<object>} The captured module registration.
 */
let capturedPromise;
function loadClientModule() {
  capturedPromise ??= (async () => {
    let captured;
    globalThis.window = {
      __ModuleLoader__: {
        load(module) {
          captured = module;
        },
      },
    };
    const file = path.join(import.meta.dirname, '..', 'lib', 'client.js');
    await import(pathToFileURL(file).href);
    assert.ok(captured, 'the module must call window.__ModuleLoader__.load');
    return captured;
  })();
  return capturedPromise;
}

test('the client module registers one sidebar panel', async () => {
  const captured = await loadClientModule();
  assert.equal(captured.id, 'dsh-layout-governor');

  const module = captured.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`the client module must not require "${name}"`);
  });

  assert.equal(module.name, 'dsh-layout-governor');
  assert.deepEqual(module.inject, ['slots', 'locale']);

  const registrations = [];
  const dictionaries = [];
  const context = {
    locale: {
      register(namespace, locale, dict) {
        dictionaries.push({ namespace, locale, dict });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    effect(run) {
      run();
    },
    slots: {
      inject(name, factory) {
        registrations.push({ name, registration: factory() });
      },
      register(options, component) {
        return { options, component };
      },
    },
  };

  module.apply(context);

  assert.equal(registrations.length, 1, 'exactly one slot registration');
  assert.equal(registrations[0].name, 'sidebar.panellist');

  const { options, component } = registrations[0].registration;
  assert.equal(options.name, 'sidebar.panellist');
  assert.equal(options.id, 'dsh-layout-governor');
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), 'Layout', 'the label resolves through the dictionary');

  assert.deepEqual(
    dictionaries.map((entry) => entry.locale).sort(),
    ['en', 'zh'],
    'both built-in locales are registered',
  );
  for (const entry of dictionaries) {
    for (const [key, value] of Object.entries(entry.dict)) {
      assert.equal(typeof value, 'string', `${entry.locale} key ${key} must be a string`);
    }
  }
  for (const key of Object.keys(dictionaries[0].dict)) {
    assert.ok(
      key in dictionaries[1].dict,
      `zh is missing ${key}, which en declares`,
    );
  }

  const tree = component({});
  assert.equal(tree.type, 'div');
  const rendered = texts(tree).join(' ');
  assert.match(rendered, /Layout/);
});

test('helpers format, shorten, page and translate without a browser', async () => {
  const captured = await loadClientModule();
  const module = captured.factory(() => fakeReact);
  const { interpolate, formatBytes, shortPath, pageFindings, makeTranslator } = module.helpers;

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1024 * 1024 * 190.4), '190 MiB');
  assert.equal(formatBytes(96 * 1024 ** 3), '96.0 GiB');
  assert.equal(formatBytes(Number.NaN), '0 B', 'a missing size must not render NaN');
  assert.equal(formatBytes(-5), '0 B');

  assert.equal(shortPath('/a/short/path'), '/a/short/path');
  const long = `/${'x'.repeat(120)}/tail.txt`;
  const shortened = shortPath(long);
  assert.equal(shortened.length, 62);
  assert.ok(shortened.startsWith('…'));
  assert.ok(shortened.endsWith('tail.txt'));
  assert.equal(shortPath(undefined), '');

  assert.equal(interpolate('a {b} c', { b: 2 }), 'a 2 c');
  assert.equal(interpolate('a {b} c'), 'a {b} c');
  assert.equal(interpolate('{missing}', {}), '{missing}');

  const items = Array.from({ length: 11 }, (_, index) => ({ id: String(index) }));
  assert.equal(pageFindings(items, false).shown.length, 8);
  assert.equal(pageFindings(items, false).hidden, 3);
  assert.equal(pageFindings(items, true).shown.length, 11);
  assert.equal(pageFindings(items, true).hidden, 0);
  assert.deepEqual(pageFindings(null, false), { shown: [], hidden: 0 });
  assert.equal(pageFindings(items, false, 3).shown.length, 3);

  // Fallback translator: the embedded English copy, with interpolation.
  const fallback = makeTranslator(undefined);
  assert.equal(fallback('panel.title'), 'Layout');
  assert.equal(fallback('panel.showAll', { count: 4 }), 'Show all 4');
  assert.equal(fallback('unknown.key'), 'unknown.key');

  // Bound translator: an empty reply from the registry falls back to the copy.
  const bound = makeTranslator({ locale: { bind: () => (key) => (key === 'panel.title' ? '' : key) } });
  assert.equal(bound('panel.title'), 'Layout');
  assert.equal(bound('panel.showLess'), 'Show less');
});

test('the presentational blocks render every state without a DOM', async () => {
  const captured = await loadClientModule();
  const module = captured.factory(() => fakeReact);
  const { components, makeTranslator } = module.helpers;
  const t = makeTranslator(undefined);

  const finding = (index) => ({
    id: `f${index}`,
    rule: 'duplicates',
    severity: index === 0 ? 'fail' : 'warn',
    title: `finding ${index}`,
    detail: 'because',
    suggestion: 'do this',
    paths: Array.from({ length: index === 0 ? 8 : 1 }, (_, at) => `/tmp/p${index}/${at}`),
  });

  const stats = { files: 3, bytes: 2048, durationMs: 12 };
  const report = {
    root: '/tmp/tree',
    overall: 'warn',
    counts: { fail: 1, warn: 1, info: 0 },
    stats,
    rules: [
      { id: 'duplicates', enabled: true, severity: 'fail', findings: 1 },
      { id: 'docs', enabled: false, severity: 'fail', findings: 0 },
    ],
    composition: {
      classes: [
        { id: 'canonical', label: 'Canonical', bytes: 2048, files: 3 },
        { id: 'regenerable', label: 'Regenerable', bytes: 0, files: 0 },
      ],
    },
    findings: Array.from({ length: 10 }, (_, index) => finding(index)),
  };

  const verdict = texts(components.VerdictLine({ report, t })).join(' ');
  assert.match(verdict, /Worth a look/);
  assert.match(verdict, /fail 1 · warn 1 · info 0/);

  const bar = texts(components.CompositionBar({ classes: report.composition.classes, t })).join(' ');
  assert.match(bar, /Canonical 2\.0 KiB/);
  assert.ok(!bar.includes('Regenerable'), 'a zero-byte class is not drawn');

  assert.equal(
    components.CompositionBar({ classes: [{ id: 'canonical', label: 'C', bytes: 0, files: 0 }], t }),
    null,
    'no bytes means no bar at all',
  );

  const row = texts(components.FindingRow({ finding: finding(0), t })).join(' ');
  assert.match(row, /finding 0/);

  const openRow = components.FindingRow({ finding: finding(1), t });
  assert.equal(openRow.props.style.borderTop.includes('1px solid'), true);

  const chips = texts(components.RuleChips({ rules: report.rules })).join(' ');
  assert.match(chips, /duplicates/);
  assert.match(chips, /docs · off/, 'a disabled rule says so');

  const body = texts(components.ReportBody({ report, t })).join(' ');
  assert.match(body, /Findings \(10\)/);
  assert.match(body, /Show all 10/, 'the collapsed list offers the rest');
  assert.match(body, /Root: \/tmp\/tree/);
  assert.match(body, /3 files/);
  assert.match(body, /--fix-plan/);

  const clean = texts(
    components.ReportBody({
      report: { ...report, findings: [], overall: 'pass', counts: { fail: 0, warn: 0, info: 0 } },
      t,
    }),
  ).join(' ');
  assert.match(clean, /No findings/);
  assert.ok(!clean.includes('Show all'));
});

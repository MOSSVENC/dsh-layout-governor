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
    for (const child of node.children ?? []) texts(child, out);
  }
  return out;
}

test('the client module registers one sidebar panel', async () => {
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

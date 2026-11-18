/**
 * Root resolution decides which tree gets audited, so its precedence is not a
 * detail: a wrong answer here quietly audits the wrong directory and reports
 * "compliant" for a tree nobody asked about.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { resolveRoot, typedField } from '../lib/host/root.js';

/**
 * Context whose `workingDirectory` service is present, absent, or throwing.
 * @param {'present'|'absent'|'throws'} mode Service behaviour.
 * @param {string} [directory] Directory the service reports.
 * @returns {{ get: (name: string) => unknown }}
 */
function context(mode, directory = '/from/service') {
  return {
    get(name) {
      if (name !== 'workingDirectory') return undefined;
      if (mode === 'throws') throw new Error('service unavailable');
      if (mode === 'absent') return undefined;
      return { defaultDirectory: directory };
    },
  };
}

test('an explicit request wins over everything', () => {
  const resolved = resolveRoot(context('present'), { root: '/from/config' }, '/from/request');
  assert.equal(resolved, path.resolve('/from/request'));
});

test('the configured root is used when the caller says nothing', () => {
  const resolved = resolveRoot(context('present'), { root: '/from/config' }, undefined);
  assert.equal(resolved, path.resolve('/from/config'));
});

test('the session working directory is the fallback', () => {
  const resolved = resolveRoot(context('present', '/session/dir'), {}, undefined);
  assert.equal(resolved, path.resolve('/session/dir'));
});

test('a throwing or absent service falls back to the process directory', () => {
  assert.equal(resolveRoot(context('throws'), {}, undefined), process.cwd());
  assert.equal(resolveRoot(context('absent'), {}, undefined), process.cwd());
  assert.equal(resolveRoot({ get: () => ({ defaultDirectory: '' }) }, {}, undefined), process.cwd());
});

test('blank and non-string values are ignored', () => {
  assert.equal(resolveRoot(context('present'), {}, '   '), path.resolve('/from/service'));
  assert.equal(resolveRoot(context('present'), { root: '  ' }, ''), path.resolve('/from/service'));
  assert.equal(resolveRoot(context('present'), { root: 42 }, null), path.resolve('/from/service'));
});

test('typedField only accepts the declared primitive', () => {
  const config = { text: 'value', number: 7, flag: true, wrong: '7' };
  assert.equal(typedField(config, 'text', 'string'), 'value');
  assert.equal(typedField(config, 'number', 'number'), 7);
  assert.equal(typedField(config, 'flag', 'boolean'), true);
  assert.equal(typedField(config, 'wrong', 'number'), undefined);
  assert.equal(typedField(config, 'missing', 'string'), undefined);
  assert.equal(typedField(undefined, 'text', 'string'), undefined);
});

test('a tool call uses its session directory, not the host default', () => {
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') {
        return { defaultDirectory: '/host/home', get: (session) => (session === 's1' ? '/mnt/d/studio' : undefined) };
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [{ path: '/from/registry' }] };
      }
      return undefined;
    },
  };
  // The session wins over the open workspace and over the host's default home.
  assert.equal(resolveRoot(ctx, {}, undefined, 's1'), path.resolve('/mnt/d/studio'));
  // An unknown session falls through to the workspace list.
  assert.equal(resolveRoot(ctx, {}, undefined, 'other'), path.resolve('/from/registry'));
  // No session at all (the HTTP route) also uses the open workspace.
  assert.equal(resolveRoot(ctx, {}, undefined), path.resolve('/from/registry'));
});

test('a host with no workspace list falls back to its default directory', () => {
  const ctx = { get: () => ({ defaultDirectory: '/host/home' }) };
  assert.equal(resolveRoot(ctx, {}, undefined), path.resolve('/host/home'));
});

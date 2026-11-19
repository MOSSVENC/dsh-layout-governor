/**
 * Formatting is the surface most people actually read, and it is pure: a report
 * object in, a string out. These tests pin the parts that carry meaning — the
 * verdict, the honest "no policy" warning, the truncation marker, and the
 * unreadable-path counter that used to be invisible.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReport } from '../lib/engine/format.js';

/**
 * Minimal report builder.
 * @param {object} [overrides] Fields to override.
 * @returns {object} A report-shaped object.
 */
function report(overrides = {}) {
  return {
    engine: 'dsh-layout-governor',
    engineVersion: '0.2.0',
    generatedAt: '2026-11-18T00:00:00.000Z',
    root: '/tmp/tree',
    policy: { path: '/tmp/tree/layout.policy.yml', sha256: 'abcdef0123456789', version: 1, present: true },
    registry: { path: '/tmp/tree/layout.registry.yml', present: false },
    overall: 'fail',
    counts: { fail: 1, warn: 0, info: 0 },
    rules: [{ id: 'duplicates', enabled: true, severity: 'fail', findings: 1, durationMs: 3 }],
    findings: [
      {
        id: 'duplicates:abc',
        rule: 'duplicates',
        severity: 'fail',
        title: '2 identical copies',
        detail: 'same sha256',
        paths: ['/tmp/tree/a', '/tmp/tree/b'],
        suggestion: 'keep a',
        fixable: true,
      },
    ],
    stats: {
      entries: 4,
      files: 3,
      directories: 1,
      symlinks: 0,
      bytes: 4096,
      hashedFiles: 2,
      hashedBytes: 4096,
      durationMs: 12,
      truncated: false,
      unreadable: 0,
    },
    composition: {
      classes: [{ id: 'canonical', label: 'Canonical', bytes: 4096, files: 3 }],
      topLevel: [{ name: 'writings', bytes: 4096, files: 3, class: 'canonical' }],
    },
    ...overrides,
  };
}

test('text and markdown both name the verdict and the counts', () => {
  const text = formatReport(report(), 'text');
  assert.match(text, /overall: FAIL/);
  assert.match(text, /fail 1 \| warn 0 \| info 0/);
  assert.match(text, /duplicates/);
  assert.match(text, /suggestion: keep a/);

  const markdown = formatReport(report(), 'markdown');
  assert.match(markdown, /^\| Layout audit|^# Layout audit/m);
  assert.match(markdown, /\*\*Overall:\*\* FAIL/);
});

test('a missing policy is stated, not silently green', () => {
  const missing = report({
    policy: { path: '/tmp/tree/layout.policy.yml', sha256: '', version: 1, present: false },
    overall: 'pass',
    counts: { fail: 0, warn: 0, info: 0 },
    findings: [],
  });

  const text = formatReport(missing, 'text');
  assert.match(text, /no policy file found/);
  const markdown = formatReport(missing, 'markdown');
  assert.match(markdown, /## No policy/);
  assert.match(markdown, /not found/);
});

test('truncation and unreadable paths are reported', () => {
  const partial = report({
    stats: { ...report().stats, truncated: true, unreadable: 3 },
  });

  const text = formatReport(partial, 'text');
  assert.match(text, /TRUNCATED/);
  assert.match(text, /3 unreadable path\(s\)/);

  const markdown = formatReport(partial, 'markdown');
  assert.match(markdown, /truncated/);
  assert.match(markdown, /3 unreadable path\(s\)/);
});

test('an empty findings list says none in both surfaces', () => {
  const clean = report({ overall: 'pass', counts: { fail: 0, warn: 0, info: 0 }, findings: [] });
  assert.match(formatReport(clean, 'text'), /findings: none/);
  assert.match(formatReport(clean, 'markdown'), /## Findings\n\nNone\./);
});

test('json is the report, not a stringified summary', () => {
  const source = report();
  const parsed = JSON.parse(formatReport(source, 'json'));
  assert.deepEqual(parsed, source);
});

test('an unknown format falls back to text', () => {
  assert.equal(formatReport(report(), 'yaml'), formatReport(report(), 'text'));
});

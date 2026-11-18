/**
 * The report cache exists so a sidebar refresh does not start a second 35-second
 * walk while the first one is still running. Its two behaviours are worth pinning
 * down: a fresh report is reused, and concurrent callers share one scan.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReportCache } from '../lib/host/report-cache.js';

/**
 * A producer that records how often it ran and resolves on demand.
 * @param {string} label Value the report carries.
 * @returns {{ produce: () => Promise<object>, runs: () => number }}
 */
function counted(label) {
  let runs = 0;
  return {
    runs: () => runs,
    async produce() {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { label };
    },
  };
}

test('a fresh report is reused inside the window', async () => {
  const cache = createReportCache({ maxAgeMs: 1000 });
  const first = counted('a');

  const one = await cache.read('k', first.produce);
  const two = await cache.read('k', first.produce);

  assert.equal(one, two, 'the same report object is returned');
  assert.equal(first.runs(), 1);
  assert.equal(cache.size(), 1);
});

test('force bypasses a fresh report', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000 });
  const source = counted('a');

  await cache.read('k', source.produce);
  await cache.read('k', source.produce, { force: true });

  assert.equal(source.runs(), 2);
});

test('an expired report is rescanned', async () => {
  const cache = createReportCache({ maxAgeMs: 0 });
  const source = counted('a');

  await cache.read('k', source.produce);
  await cache.read('k', source.produce);

  assert.equal(source.runs(), 2, 'maxAgeMs 0 disables reuse of finished reports');
});

test('concurrent callers share one scan', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000 });
  const source = counted('a');

  const [one, two, three] = await Promise.all([
    cache.read('k', source.produce),
    cache.read('k', source.produce),
    cache.read('k', source.produce),
  ]);

  assert.equal(source.runs(), 1, 'the second and third callers join the first scan');
  assert.equal(one, two);
  assert.equal(two, three);
});

test('different keys do not share a scan', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000 });
  const left = counted('left');
  const right = counted('right');

  const [one, two] = await Promise.all([cache.read('a', left.produce), cache.read('b', right.produce)]);

  assert.equal(left.runs(), 1);
  assert.equal(right.runs(), 1);
  assert.equal(one.label, 'left');
  assert.equal(two.label, 'right');
});

test('eviction keeps the most recent reports', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000, limit: 2 });
  const source = counted('a');

  await cache.read('one', source.produce);
  await cache.read('two', source.produce);
  await cache.read('three', source.produce);

  assert.equal(cache.size(), 2);
  // "one" was evicted, so asking for it scans again; "three" is still fresh.
  await cache.read('one', source.produce);
  assert.equal(source.runs(), 4);
  await cache.read('three', source.produce);
  assert.equal(source.runs(), 4);
});

test('a failed scan is not cached', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000 });
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error('disk gone');
  };

  await assert.rejects(() => cache.read('k', failing), /disk gone/);
  await assert.rejects(() => cache.read('k', failing), /disk gone/);

  assert.equal(attempts, 2, 'the next caller must retry instead of receiving the failure');
  assert.equal(cache.size(), 0);
});

test('clear drops both finished and in-flight state', async () => {
  const cache = createReportCache({ maxAgeMs: 60_000 });
  const source = counted('a');
  await cache.read('k', source.produce);
  assert.equal(cache.size(), 1);

  cache.clear();

  assert.equal(cache.size(), 0);
  await cache.read('k', source.produce);
  assert.equal(source.runs(), 2, 'after a clear the next caller rescans');
});

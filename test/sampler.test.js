import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plan, makeRng, timelinePositions, validateConfig, weightedSampleIndices } from '../src/sampler.js';
import { DEFAULT_CONFIG, TIMELINE_SPLIT } from '../src/config.js';

/** The worked example from the request: 10 follows, "recent 3 / older 4 / ancient 3". */
function exampleItems() {
  const ages = [10, 20, 30, 100, 150, 200, 250, 400, 600, 800];
  return ages.map((ageDays, index) => ({ id: `up${index}`, label: `UP ${index}`, ageDays }));
}

const config = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });

function bucketsOf(result) {
  return Object.fromEntries(result.buckets.map((bucket) => [bucket.name, bucket]));
}

test('reproduces the requested 3 / 2 / 1 outcome', () => {
  const result = plan(exampleItems(), config());

  assert.equal(result.buckets.length, 3);
  assert.deepEqual(
    result.buckets.map((bucket) => [bucket.name, bucket.total, bucket.keep]),
    [['fresh', 3, 3], ['normal', 4, 2], ['stale', 3, 1]],
  );
  assert.equal(result.keep.length, 6);
  assert.equal(result.drop.length, 4);
});

test('the ruler is relative: scaling every age by 1000 changes nothing', () => {
  const base = exampleItems();
  const scaled = base.map((item) => ({ ...item, ageDays: item.ageDays * 1000 }));

  const a = plan(base, config({ seed: 7 }));
  const b = plan(scaled, config({ seed: 7 }));

  assert.deepEqual(a.keep.map((i) => i.id), b.keep.map((i) => i.id));
  assert.deepEqual(a.drop.map((i) => i.id), b.drop.map((i) => i.id));
  // Only the reported age ranges scale; membership and counts must not.
  assert.deepEqual(
    a.buckets.map((x) => [x.name, x.total, x.keep]),
    b.buckets.map((x) => [x.name, x.total, x.keep]),
  );
});

test('the ruler is relative: shifting every age by a constant changes nothing', () => {
  const base = exampleItems();
  const shifted = base.map((item) => ({ ...item, ageDays: item.ageDays + 5000 }));

  const a = plan(base, config({ seed: 3 }));
  const b = plan(shifted, config({ seed: 3 }));

  assert.deepEqual(a.keep.map((i) => i.id), b.keep.map((i) => i.id));
});

test('the kept COUNT is deterministic; only the members vary', () => {
  const counts = new Set();
  for (let seed = 0; seed < 60; seed += 1) {
    const result = plan(exampleItems(), config({ seed }));
    counts.add(JSON.stringify(result.buckets.map((b) => b.keep)));
  }
  assert.deepEqual([...counts], ['[3,2,1]']);
});

test('the same seed replays the same plan', () => {
  const a = plan(exampleItems(), config({ seed: 42 }));
  const b = plan(exampleItems(), config({ seed: 42 }));
  assert.deepEqual(a.drop.map((i) => i.id), b.drop.map((i) => i.id));
});

test('different seeds choose different victims', () => {
  const picks = new Set();
  for (let seed = 0; seed < 40; seed += 1) {
    picks.add(plan(exampleItems(), config({ seed })).drop.map((i) => i.id).join(','));
  }
  assert.ok(picks.size > 1, 'expected the selection to vary across seeds');
});

test('weight is a pure function of age, so nothing accumulates between runs', () => {
  const items = exampleItems();
  const first = plan(items, config({ seed: 11 }));
  // Simulate "the run happened": the survivors are now the whole population.
  const survivors = plan(first.keep, config({ seed: 11 }));

  assert.deepEqual(first, plan(items, config({ seed: 11 })));
  assert.ok(survivors.keep.length <= first.keep.length);
});

test('quantile positions are rank based and ignore the gaps', () => {
  const items = [{ ageDays: 0 }, { ageDays: 1 }, { ageDays: 5000 }];
  assert.deepEqual(timelinePositions(items, 'quantile'), [0, 0.5, 1]);
});

test('span positions are linear inside min..max', () => {
  const items = [{ ageDays: 100 }, { ageDays: 150 }, { ageDays: 200 }];
  assert.deepEqual(timelinePositions(items, 'span'), [0, 0.5, 1]);
});

test('span mode is stretched by one outlier -- the documented trade-off', () => {
  // Nine recent follows plus one ancient one. The literal span ruler calls the
  // nine "fresh" because they sit near the young end of a very wide range.
  const items = [...Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, ageDays: i + 1 })),
    { id: 'ancient', ageDays: 1000 }];

  const span = bucketsOf(plan(items, config({ mode: 'span' })));
  const quantile = bucketsOf(plan(items, config({ mode: 'quantile' })));

  assert.equal(span.fresh.total, 9);
  assert.equal(span.normal.total, 0);
  assert.equal(span.stale.total, 1);

  assert.deepEqual(
    [quantile.fresh.total, quantile.normal.total, quantile.stale.total],
    [3, 4, 3],
  );
});

test('within a bucket the younger are likelier to survive', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `item${i}`, ageDays: i }));
  const single = { ...DEFAULT_CONFIG, buckets: [{ name: 'all', to: 1, keep: 0.5 }] };

  const runs = 400;
  const tally = new Map();
  for (let seed = 0; seed < runs; seed += 1) {
    for (const kept of plan(items, { ...single, seed }).keep) {
      tally.set(kept.id, (tally.get(kept.id) ?? 0) + 1);
    }
  }
  const freq = (index) => tally.get(`item${index}`) ?? 0;

  // The precise probabilities are not the contract; the gradient is.
  assert.ok(freq(0) > freq(9) * 4, `youngest=${freq(0)} oldest=${freq(9)}`);

  const youngerHalf = [0, 1, 2, 3, 4].reduce((sum, i) => sum + freq(i), 0) / 5;
  const olderHalf = [5, 6, 7, 8, 9].reduce((sum, i) => sum + freq(i), 0) / 5;
  assert.ok(youngerHalf > olderHalf * 2, `younger=${youngerHalf} older=${olderHalf}`);

  // Every run keeps exactly five, so the tallies must add up to the total kept.
  assert.equal([...tally.values()].reduce((sum, n) => sum + n, 0), runs * 5);
});

test('keep = 1 keeps everything and keep = 0 drops everything', () => {
  const keepAll = { ...DEFAULT_CONFIG, buckets: [{ name: 'all', to: 1, keep: 1 }] };
  const dropAll = { ...DEFAULT_CONFIG, buckets: [{ name: 'all', to: 1, keep: 0 }] };

  assert.equal(plan(exampleItems(), keepAll).drop.length, 0);
  assert.equal(plan(exampleItems(), keepAll).keep.length, 10);
  assert.equal(plan(exampleItems(), dropAll).keep.length, 0);
  assert.equal(plan(exampleItems(), dropAll).drop.length, 10);
});

test('an empty list is not an error', () => {
  const result = plan([], config());
  assert.deepEqual(result.keep, []);
  assert.deepEqual(result.drop, []);
  assert.ok(result.buckets.every((b) => b.total === 0 && b.keep === 0));
});

test('a single item is handled', () => {
  const result = plan([{ id: 'only', ageDays: 5 }], config());
  assert.equal(result.keep.length + result.drop.length, 1);
});

test('identical ages do not divide by zero', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, ageDays: 100 }));
  assert.doesNotThrow(() => plan(items, config({ mode: 'span' })));
  assert.doesNotThrow(() => plan(items, config({ mode: 'quantile' })));
  assert.deepEqual(timelinePositions(items, 'span'), [0, 0, 0, 0, 0]);
});

test('a large population is split in the configured proportions', () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, ageDays: i }));
  const result = plan(items, config());
  const buckets = bucketsOf(result);

  assert.equal(buckets.fresh.total, 300);
  assert.equal(buckets.normal.total, 400);
  assert.equal(buckets.stale.total, 300);
  assert.equal(result.keep.length, 285 + 200 + 90);
});

test('the input array and its order are left alone', () => {
  const items = exampleItems();
  const before = items.map((i) => i.id);
  plan(items, config({ seed: 5 }));
  assert.deepEqual(items.map((i) => i.id), before);
});

test('drops are ordered oldest first, ready for the driver to walk', () => {
  const result = plan(exampleItems(), config({ seed: 2 }));
  const ages = result.drop.map((item) => item.ageDays);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
});

test('bucket ages are reported for review', () => {
  const buckets = bucketsOf(plan(exampleItems(), config()));
  assert.equal(buckets.fresh.minAgeDays, 10);
  assert.equal(buckets.fresh.maxAgeDays, 30);
  assert.equal(buckets.stale.minAgeDays, 400);
  assert.equal(buckets.stale.maxAgeDays, 800);
});

test('invalid configuration is rejected loudly', () => {
  const cases = [
    ['buckets empty', { buckets: [] }],
    ['bad mode', { mode: 'nonsense' }],
    ['tau zero', { tau: 0 }],
    ['tau not a number', { tau: 'x' }],
    ['to not ascending', { buckets: [{ name: 'a', to: 0.7, keep: 1 }, { name: 'b', to: 0.3, keep: 1 }] }],
    ['last bucket does not close at 1', { buckets: [{ name: 'a', to: 0.9, keep: 1 }] }],
    ['keep above 1', { buckets: [{ name: 'a', to: 1, keep: 1.5 }] }],
    ['keep below 0', { buckets: [{ name: 'a', to: 1, keep: -0.1 }] }],
    ['missing name', { buckets: [{ to: 1, keep: 1 }] }],
  ];

  for (const [label, override] of cases) {
    assert.throws(() => plan(exampleItems(), config(override)), undefined, label);
  }
});

test('negative ages are rejected', () => {
  assert.throws(() => plan([{ id: 'a', ageDays: -1 }], config()), /ageDays/);
  assert.throws(() => plan([{ id: 'a' }], config()), /ageDays/);
});

test('validateConfig accepts the shipped default', () => {
  assert.doesNotThrow(() => validateConfig(DEFAULT_CONFIG));
  assert.doesNotThrow(() => validateConfig({ ...DEFAULT_CONFIG, mode: 'span' }));
});

test('weightedSampleIndices respects k and stays in range', () => {
  const rng = makeRng(9);
  const weights = [1, 1, 1, 1, 1];
  assert.deepEqual(weightedSampleIndices(weights, 0, rng), []);
  assert.deepEqual(weightedSampleIndices(weights, 5, rng), [0, 1, 2, 3, 4]);
  const two = weightedSampleIndices(weights, 2, rng);
  assert.equal(two.length, 2);
  assert.equal(new Set(two).size, 2);
  assert.ok(two.every((i) => i >= 0 && i < weights.length));
});

test('a zero weight is never selected', () => {
  const rng = makeRng(1);
  for (let i = 0; i < 50; i += 1) {
    const picked = weightedSampleIndices([0, 1, 0, 1], 2, rng);
    assert.deepEqual(picked, [1, 3]);
  }
});

test('the default split covers the whole timeline', () => {
  assert.equal(TIMELINE_SPLIT[TIMELINE_SPLIT.length - 1].to, 1);
  assert.equal(TIMELINE_SPLIT[0].to, 0.3);
});

// ------------------------------------------------------------- protection
test('a protected item is never dropped, across many seeds', () => {
  // up9 is the oldest, so without protection it is dropped nearly every time.
  const items = exampleItems().map((item) => ({ ...item, lock: item.id === 'up9' }));
  const config = { ...DEFAULT_CONFIG, isProtected: (item) => item.lock };

  for (let seed = 0; seed < 30; seed += 1) {
    const result = plan(items, { ...config, seed });
    assert.ok(!result.drop.some((i) => i.id === 'up9'), `seed ${seed} dropped a protected item`);
  }
});

test('protection consumes the bucket quota instead of adding to it', () => {
  const items = exampleItems().map((item) => ({ ...item, lock: item.id === 'up7' || item.id === 'up8' }));
  const result = plan(items, { ...DEFAULT_CONFIG, seed: 1, isProtected: (i) => i.lock });
  const stale = result.buckets.find((b) => b.name === 'stale');

  assert.equal(stale.total, 3);
  assert.equal(stale.protected, 2);
  // round(3 * 0.3) would be 1, but two protected members force the bucket to 2.
  assert.equal(stale.keep, 2);
  assert.equal(stale.dropped, 1);
});

test('a fully protected bucket drops nothing', () => {
  const items = exampleItems().map((item) => ({ ...item, lock: true }));
  const result = plan(items, { ...DEFAULT_CONFIG, isProtected: (i) => i.lock });
  assert.equal(result.drop.length, 0);
  assert.equal(result.keep.length, 10);
});

test('protection is counted per bucket', () => {
  const items = exampleItems().map((item) => ({ ...item, lock: Number(item.id.slice(2)) < 3 }));
  const result = plan(items, { ...DEFAULT_CONFIG, isProtected: (i) => i.lock });
  assert.equal(result.buckets.reduce((sum, b) => sum + b.protected, 0), 3);
});

test('without an isProtected function nothing is protected', () => {
  const result = plan(exampleItems(), DEFAULT_CONFIG);
  assert.ok(result.buckets.every((b) => b.protected === 0));
});

// ------------------------------------------------------------------ capDays
test('an absolute cap pushes old items out of a young bucket', () => {
  // Ages 0..900 step 100. Ranks 0,1,2 land in fresh (ages 0,100,200).
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, ageDays: i * 100 }));
  const bare = [
    { name: 'fresh', to: 0.3, keep: 0.95 },
    { name: 'normal', to: 0.7, keep: 0.5 },
    { name: 'stale', to: 1, keep: 0.3 },
  ];
  const capped = bare.map((bucket) => (bucket.name === 'fresh' ? { ...bucket, capDays: 150 } : bucket));

  const without = plan(items, { ...DEFAULT_CONFIG, buckets: bare });
  const withCap = plan(items, { ...DEFAULT_CONFIG, buckets: capped });

  assert.equal(without.buckets[0].total, 3);
  // The 200-day item is over the cap, so it drops down into normal.
  assert.equal(withCap.buckets[0].total, 2);
  assert.equal(withCap.buckets[1].total, without.buckets[1].total + 1);
});

test('a cap never loses an item, even on the final bucket', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, ageDays: i * 50 }));
  const buckets = [
    { name: 'fresh', to: 0.3, keep: 0.9, capDays: 10 },
    { name: 'normal', to: 0.7, keep: 0.5, capDays: 20 },
    { name: 'stale', to: 1, keep: 0.3, capDays: 5 },
  ];
  const result = plan(items, { ...DEFAULT_CONFIG, buckets });

  assert.equal(result.buckets.reduce((sum, b) => sum + b.total, 0), 20);
  assert.equal(result.keep.length + result.drop.length, 20);
  // Only the 0-day item fits a 10-day cap; everything else cascades onward.
  assert.equal(result.buckets[0].total, 1);
  assert.equal(result.buckets[1].total, 0);
  assert.equal(result.buckets[2].total, 19);
});

test('caps are reported per bucket alongside the observed range', () => {
  const buckets = [
    { name: 'fresh', to: 0.3, keep: 0.9, capDays: 180 },
    { name: 'normal', to: 0.7, keep: 0.5 },
    { name: 'stale', to: 1, keep: 0.3 },
  ];
  const result = plan(exampleItems(), { ...DEFAULT_CONFIG, buckets });

  assert.equal(result.buckets[0].capDays, 180);
  assert.equal(result.buckets[1].capDays, null);
  assert.equal(result.buckets[0].maxAgeDays, 30, 'the observed range is still reported');
});

test('an invalid cap is rejected', () => {
  const withCap = (capDays) => [{ name: 'a', to: 1, keep: 1, capDays }];
  assert.throws(() => plan(exampleItems(), { ...DEFAULT_CONFIG, buckets: withCap(0) }), RangeError);
  assert.throws(() => plan(exampleItems(), { ...DEFAULT_CONFIG, buckets: withCap(-5) }), RangeError);
  assert.throws(() => plan(exampleItems(), { ...DEFAULT_CONFIG, buckets: withCap('x') }), TypeError);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysBetween, followingsProtection, favoritesProtection,
  UNFOLLOW_PRESET, FAVORITE_PRESET, DEFAULT_CONFIG,
} from '../src/config.js';

test('daysBetween measures whole and fractional days', () => {
  const to = new Date('2026-01-11T00:00:00Z');
  assert.equal(Math.round(daysBetween(new Date('2026-01-01T00:00:00Z'), to)), 10);
  assert.equal(daysBetween(to, to), 0);
});

test('a future timestamp clamps to zero rather than going negative', () => {
  const from = new Date('2026-02-01T00:00:00Z');
  assert.equal(daysBetween(from, new Date('2026-01-01T00:00:00Z')), 0);
});

test('an unparseable timestamp becomes 0 so the item is protected, not purged', () => {
  // The whole point: a row we cannot date must land at the fresh end.
  // null and 0 are the dangerous ones -- new Date(null) is the 1970 epoch, so a
  // naive parse makes a missing timestamp look ancient and purge it.
  for (const bad of [undefined, null, '', '   ', 'not-a-date', NaN, 0, '0']) {
    assert.equal(daysBetween(bad, new Date()), 0, `expected 0 for ${JSON.stringify(bad)}`);
  }
});

test('real timestamps are still parsed', () => {
  const to = new Date('2026-01-11T00:00:00Z');
  // A plausible unix-seconds timestamp, the shape the API actually returns.
  assert.equal(Math.round(daysBetween(new Date(1767225600 * 1000), to)), 10);
  assert.ok(daysBetween(new Date(1700000000 * 1000), to) > 0);
  // Bare numeric strings are treated as unix seconds, not as date strings.
  assert.equal(Math.round(daysBetween('1767225600', to)), 10);
});

test('followings protection covers special and mutual by default', () => {
  const guard = followingsProtection();
  assert.equal(guard({ id: '1', raw: { special: true, mutual: false } }), true);
  assert.equal(guard({ id: '2', raw: { special: false, mutual: true } }), true);
  assert.equal(guard({ id: '3', raw: { special: false, mutual: false } }), false);
});

test('followings protection can be relaxed', () => {
  const guard = followingsProtection({ special: false, mutual: false });
  assert.equal(guard({ id: '1', raw: { special: true, mutual: true } }), false);
});

test('followings protection honours an explicit allow list', () => {
  const guard = followingsProtection({ special: false, mutual: false, extra: [946974] });
  assert.equal(guard({ id: '946974', raw: {} }), true);
  assert.equal(guard({ id: 946974, raw: {} }), true, 'numeric ids match string entries');
  assert.equal(guard({ id: '5', raw: {} }), false);
});

test('followings protection reads a raw row passed directly', () => {
  const guard = followingsProtection();
  assert.equal(guard({ mid: 9, special: true }), true);
});

test('followings protection survives a missing raw row', () => {
  const guard = followingsProtection();
  assert.equal(guard({}), false);
  assert.equal(guard(undefined), false);
});

test('favourites protection honours an allow list and nothing else', () => {
  const guard = favoritesProtection({ extra: ['123'] });
  assert.equal(guard({ id: '123' }), true);
  assert.equal(guard({ id: '124' }), false);
  assert.equal(favoritesProtection()({ id: '123' }), false);
});

test('the two presets differ in the direction that risk demands', () => {
  // Unfollowing is hard to undo, so it must be the more conservative one:
  // it keeps at least as much of every bucket, moves slower, and caps lower.
  UNFOLLOW_PRESET.buckets.forEach((bucket, index) => {
    assert.ok(
      bucket.keep >= FAVORITE_PRESET.buckets[index].keep,
      `bucket "${bucket.name}" must be at least as conservative for unfollowing`,
    );
  });
  assert.ok(UNFOLLOW_PRESET.maxPerRun < FAVORITE_PRESET.maxPerRun);
  assert.ok(UNFOLLOW_PRESET.minGapMs > FAVORITE_PRESET.minGapMs);
  assert.equal(UNFOLLOW_PRESET.protectSpecial, true);
  assert.equal(UNFOLLOW_PRESET.protectMutual, true);
});

test('both presets use the relative ruler by default', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'quantile');
  assert.equal(UNFOLLOW_PRESET.mode, 'quantile');
  assert.equal(FAVORITE_PRESET.mode, 'quantile');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { followingsToItems, favoritesToItems, renderPlan, planFromRows } from '../src/report.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const NOW = new Date('2026-01-01T00:00:00Z');
const daysAgo = (days) => Math.floor(NOW.getTime() / 1000) - days * 86400;

test('followings rows become items with an age in days', () => {
  const items = followingsToItems([{ mid: 7, uname: 'someone', mtime: daysAgo(10) }], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '7');
  assert.equal(items[0].label, 'someone');
  assert.equal(Math.round(items[0].ageDays), 10);
});

test('a following with no name still gets a label', () => {
  const items = followingsToItems([{ mid: 7, uname: '', mtime: daysAgo(1) }], NOW);
  assert.equal(items[0].label, 'mid 7');
});

test('favourite rows accept either favTime spelling', () => {
  const camel = favoritesToItems([{ id: 1, title: 'a', favTime: daysAgo(5) }], NOW);
  const snake = favoritesToItems([{ id: 1, title: 'a', fav_time: daysAgo(5) }], NOW);
  assert.equal(Math.round(camel[0].ageDays), 5);
  assert.equal(camel[0].ageDays, snake[0].ageDays);
});

test('a missing timestamp becomes age 0 rather than NaN', () => {
  const items = favoritesToItems([{ id: 1, title: 'a' }], NOW);
  assert.equal(Number.isFinite(items[0].ageDays), true);
});

test('the plan listing shows buckets, counts and victims', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    mid: i, uname: `UP${i}`, mtime: daysAgo(10 * (i + 1)),
  }));
  const { result } = planFromRows(rows, 'followings', DEFAULT_CONFIG, NOW);
  const text = renderPlan(result, { title: 'TEST PLAN', listLimit: 3 });

  assert.match(text, /TEST PLAN/);
  assert.match(text, /bucket/);
  assert.match(text, /fresh/);
  assert.match(text, /normal/);
  assert.match(text, /stale/);
  assert.match(text, /-> keep \d+, remove \d+ of 10/);
  assert.match(text, /would be removed/);
});

test('the victim list is truncated with a remainder note', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    mid: i, uname: `UP${i}`, mtime: daysAgo(30 * (i + 1)),
  }));
  const { result } = planFromRows(rows, 'followings', DEFAULT_CONFIG, NOW);
  const text = renderPlan(result, { listLimit: 2 });
  const listed = text.split('\n').filter((line) => /^\s+\d+d\s/.test(line));

  assert.equal(listed.length, 2);
  if (result.drop.length > 2) assert.match(text, /and \d+ more/);
});

test('an empty plan renders without victims', () => {
  const { result } = planFromRows([], 'followings', DEFAULT_CONFIG, NOW);
  const text = renderPlan(result);
  assert.match(text, /keep 0, remove 0 of 0/);
  assert.ok(!text.includes('would be removed'));
});

test('a favourite plan routes through the favourite mapping', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i, title: `video${i}`, favTime: daysAgo(100 * (i + 1)),
  }));
  const { items, result } = planFromRows(rows, 'favorites', DEFAULT_CONFIG, NOW);
  assert.equal(items[0].label, 'video0');
  assert.equal(result.keep.length + result.drop.length, 10);
});

test('the rendered plan never contains a raw credential-ish field', () => {
  const { result } = planFromRows(
    [{ mid: 1, uname: 'x', mtime: daysAgo(1), raw: { sessdata: 'SECRET' } }],
    'followings',
    DEFAULT_CONFIG,
    NOW,
  );
  assert.ok(!renderPlan(result).includes('SECRET'));
});

test('a zero list limit renders the summary without any list', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ mid: 100 + i, uname: `up${i}`, mtime: daysAgo(30 * (i + 1)) }));
  const { result } = planFromRows(rows, 'followings', DEFAULT_CONFIG, NOW);
  const output = renderPlan(result, { listLimit: 0 });

  assert.ok(result.drop.length > 0, 'the fixture must actually drop something');
  assert.ok(!output.includes('would be removed'));
  assert.ok(!output.includes('... and'));
  assert.match(output, /-> keep \d+, remove \d+ of 10/);
});

test('a positive list limit still renders the list', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ mid: 100 + i, uname: `up${i}`, mtime: daysAgo(30 * (i + 1)) }));
  const { result } = planFromRows(rows, 'followings', DEFAULT_CONFIG, NOW);
  assert.match(renderPlan(result, { listLimit: 3 }), /would be removed/);
});

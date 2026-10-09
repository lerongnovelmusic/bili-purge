import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UNFOLLOW_PRESET, FAVORITE_PRESET } from '../src/config.js';
import { withFreshCap, confirmToken, buildUnfollowRun, buildFavoriteRun, favoriteDeadReason } from '../src/run.js';
import { readUndoList } from '../refollow.js';

const NOW = new Date('2026-10-08T00:00:00Z');
const dayAgo = (days) => Math.floor(NOW.getTime() / 1000 - days * 86400);

/** Followings rows in the shape the API normaliser produces. */
function makeRows(ages, overrides = {}) {
  return ages.map((age, index) => ({
    mid: 1000 + index,
    uname: `UP${index}`,
    mtime: dayAgo(age),
    special: false,
    mutual: false,
    ...(overrides[index] ?? {}),
  }));
}

const SPREAD = Array.from({ length: 40 }, (_, index) => 5 + index * 30);

// ------------------------------------------------------------------ caps
test('withFreshCap only touches the youngest bucket', () => {
  const buckets = [{ name: 'a', to: 0.3, keep: 1 }, { name: 'b', to: 1, keep: 0 }];
  const capped = withFreshCap(buckets, 365);

  assert.equal(capped[0].capDays, 365);
  assert.equal(capped[1].capDays, undefined);
  assert.equal(buckets[0].capDays, undefined, 'the input is not mutated');
});

test('a null or non-finite cap leaves the ladder alone', () => {
  const buckets = [{ name: 'a', to: 0.3, keep: 1 }, { name: 'b', to: 1, keep: 0 }];
  for (const cap of [null, undefined, Infinity]) {
    assert.equal(withFreshCap(buckets, cap), buckets);
  }
});

// ---------------------------------------------------------------- tokens
test('confirmToken is stable and order-sensitive', () => {
  assert.equal(confirmToken({ a: 1 }), confirmToken({ a: 1 }));
  assert.notEqual(confirmToken({ ids: [1, 2] }), confirmToken({ ids: [2, 1] }));
  assert.equal(confirmToken({ a: 1 }).length, 8);
});

test('the same inputs produce the same run and token', () => {
  const args = { rows: makeRows(SPREAD), cap: 365, seed: 1, limit: 5, now: NOW };
  const first = buildUnfollowRun(args);
  const second = buildUnfollowRun(args);

  assert.equal(first.token, second.token);
  assert.deepEqual(first.actions.map((i) => i.id), second.actions.map((i) => i.id));
});

test('changing the cap changes the token', () => {
  const base = { rows: makeRows(SPREAD), seed: 1, limit: 5, now: NOW };
  assert.notEqual(
    buildUnfollowRun({ ...base, cap: 365 }).token,
    buildUnfollowRun({ ...base, cap: 730 }).token,
  );
});

test('changing the seed changes the token', () => {
  const base = { rows: makeRows(SPREAD), cap: 365, limit: 5, now: NOW };
  assert.notEqual(
    buildUnfollowRun({ ...base, seed: 1 }).token,
    buildUnfollowRun({ ...base, seed: 2 }).token,
  );
});

test('changing the action list changes the token', () => {
  const base = { rows: makeRows(SPREAD), cap: 365, seed: 1, now: NOW };
  assert.notEqual(
    buildUnfollowRun({ ...base, limit: 5 }).token,
    buildUnfollowRun({ ...base, limit: 6 }).token,
  );
});

// ------------------------------------------------------------- behaviour
test('actions are the oldest entries first and bounded by the limit', () => {
  const run = buildUnfollowRun({ rows: makeRows(SPREAD), cap: 365, seed: 1, limit: 5, now: NOW });

  assert.equal(run.actions.length, 5);
  const ages = run.actions.map((item) => item.ageDays);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a), 'oldest first');

  const planned = new Set(run.result.drop.map((item) => item.id));
  assert.ok(run.actions.every((item) => planned.has(item.id)), 'actions come from the plan');
});

test('the action list is a prefix of the full removal plan', () => {
  const rows = makeRows(SPREAD);
  const small = buildUnfollowRun({ rows, cap: 365, seed: 1, limit: 3, now: NOW });
  const large = buildUnfollowRun({ rows, cap: 365, seed: 1, limit: 10, now: NOW });

  assert.deepEqual(small.actions.map((i) => i.id), large.actions.slice(0, 3).map((i) => i.id));
});

test('the budget defaults to the preset per-run cap', () => {
  const run = buildUnfollowRun({ rows: makeRows(SPREAD), cap: 365, now: NOW });
  assert.equal(run.actions.length, Math.min(run.result.drop.length, UNFOLLOW_PRESET.maxPerRun));
});

test('a limit larger than the plan does not invent actions', () => {
  const run = buildUnfollowRun({ rows: makeRows(SPREAD), cap: 365, limit: 10_000, now: NOW });
  assert.equal(run.actions.length, run.result.drop.length);
});

test('special and mutual follows never reach the action list', () => {
  const overrides = {
    0: { special: true },
    1: { mutual: true },
    39: { special: true, mutual: true },
  };
  const run = buildUnfollowRun({ rows: makeRows(SPREAD, overrides), cap: 365, limit: 10_000, now: NOW });

  const actionIds = new Set(run.actions.map((item) => item.id));
  for (const index of Object.keys(overrides)) {
    assert.ok(!actionIds.has(String(1000 + Number(index))), `UP${index} must be protected`);
  }
});

test('a whitelisted mid is protected even when it is the oldest', () => {
  const rows = makeRows(SPREAD);
  const oldest = String(1000 + SPREAD.length - 1);
  const run = buildUnfollowRun({
    rows, cap: 365, seed: 1, limit: 10_000, now: NOW, keep: [oldest],
  });

  assert.ok(!run.actions.some((item) => item.id === oldest));
  assert.ok(run.result.keep.some((item) => item.id === oldest));
});

test('every follow ends up either kept or planned for removal', () => {
  const run = buildUnfollowRun({ rows: makeRows(SPREAD), cap: 365, now: NOW });
  assert.equal(run.result.keep.length + run.result.drop.length, SPREAD.length);
});

// -------------------------------------------------------------- favourites
function favoriteRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 5000 + index,
    // The real death signal is the placeholder title, not a cached boolean.
    title: index % 10 === 0 ? '已失效视频' : `video ${index}`,
    bvid: `BV${1000 + index}`,
    favTime: dayAgo(5 + index * 20),
  }));
}

test('dead favourite entries are actioned first', () => {
  const run = buildFavoriteRun({ rows: favoriteRows(60), cap: 365, seed: 1, limit: 20, now: NOW });
  const dead = run.actions.filter((item) => favoriteDeadReason(item) !== null).length;
  const totalDead = run.result.drop.filter((item) => favoriteDeadReason(item) !== null).length;

  assert.ok(totalDead > 0, 'the fixture must actually contain dead entries');
  assert.equal(dead, Math.min(20, totalDead));
  assert.ok(run.actions.slice(0, dead).every((item) => favoriteDeadReason(item) !== null));
});

test('a stale invalid flag does not queue a live entry for early deletion', () => {
  // A snapshot written before a detection change keeps its old verdict. If the
  // ordering trusted that flag, live entries would be deleted first.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: 7000 + index,
    title: `live video ${index}`,
    bvid: `BV${2000 + index}`,
    favTime: dayAgo(5 + index * 20),
    invalid: true,
    invalidReason: 'attr=16',
    attr: 16,
  }));

  const run = buildFavoriteRun({ rows, cap: 365, seed: 1, limit: 10, now: NOW });
  assert.ok(run.actions.length > 0);
  assert.ok(
    run.actions.every((item) => favoriteDeadReason(item) === null),
    'no entry should be treated as dead on the strength of a cached flag',
  );
});

test('ordering dead entries first can be turned off', () => {
  const args = { rows: favoriteRows(60), cap: 365, seed: 1, limit: 20, now: NOW };
  const ordered = buildFavoriteRun(args);
  const plain = buildFavoriteRun({ ...args, deadFirst: false });
  assert.notDeepEqual(ordered.actions.map((i) => i.id), plain.actions.map((i) => i.id));
});

test('the favourite budget defaults to its own preset', () => {
  const run = buildFavoriteRun({ rows: favoriteRows(200), cap: 365, now: NOW });
  assert.equal(run.actions.length, Math.min(run.result.drop.length, FAVORITE_PRESET.maxPerRun));
});

// ------------------------------------------------------------- undo log
test('readUndoList returns only the successful unfollows', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-')), 'log.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ kind: 'header', token: 'ABC' }),
    JSON.stringify({ action: 'unfollow', mid: 111, uname: 'A', ok: true }),
    JSON.stringify({ action: 'unfollow', mid: 222, uname: 'B', ok: false, code: '-352' }),
    JSON.stringify({ action: 'unfollow', mid: 333, uname: 'C', ok: true }),
    JSON.stringify({ kind: 'summary', ok: 2, failed: 1 }),
    '',
  ].join('\n'), 'utf8');

  const entries = readUndoList(file);
  assert.deepEqual(entries.map((entry) => entry.mid), ['111', '333']);
  assert.equal(entries[0].uname, 'A');
});

test('readUndoList survives a truncated final line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-')), 'log.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ action: 'unfollow', mid: 111, ok: true })}\n{"action":"unfol`, 'utf8');
  assert.deepEqual(readUndoList(file).map((entry) => entry.mid), ['111']);
});

test('readUndoList on an empty log yields nothing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-')), 'log.jsonl');
  fs.writeFileSync(file, '', 'utf8');
  assert.deepEqual(readUndoList(file), []);
});

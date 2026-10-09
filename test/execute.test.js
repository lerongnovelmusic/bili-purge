import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeUnfollow, executeFavorites, chunk } from '../src/execute.js';
import { BiliApiError } from '../src/http.js';
import { newestSnapshot, readHistory, ranOnLocalDate, logFiles } from '../src/history.js';

/** A client whose postForm behaviour is scripted per call. */
function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    async postForm(url, params) {
      calls.push({ url, params });
      return behaviour(calls.length, params);
    },
    stats: { requestCount: calls.length, retryCount: 0 },
  };
}

const items = (count, start = 0) => Array.from({ length: count }, (_, index) => ({
  id: 1000 + start + index,
  label: `user ${start + index}`,
  ageDays: 500 + index,
}));

// ------------------------------------------------------------------ chunk
test('chunk splits into full batches plus a remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

// --------------------------------------------------------- executeUnfollow
test('unfollow records every success', async () => {
  const records = [];
  const client = fakeClient(async () => ({}));
  const summary = await executeUnfollow({
    client, actions: items(4), csrf: 'tok', onRecord: (r) => records.push(r),
  });

  assert.equal(summary.ok, 4);
  assert.equal(summary.failed, 0);
  assert.equal(summary.aborted, false);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((r) => r.mid), [1000, 1001, 1002, 1003]);
  assert.ok(records.every((r) => r.ok === true));
});

test('unfollow sends the fid, the csrf token and act=2', async () => {
  const client = fakeClient(async () => ({}));
  await executeUnfollow({ client, actions: items(1), csrf: 'MYCSRF' });
  const { url, params } = client.calls[0];
  assert.match(url, /relation\/modify/);
  assert.equal(params.fid, 1000);
  assert.equal(params.act, 2);
  assert.equal(params.csrf, 'MYCSRF');
  assert.equal(params.re_src, 11);
});

test('unfollow keeps going after an ordinary failure', async () => {
  const client = fakeClient(async (call) => {
    if (call === 2) throw new BiliApiError(-400, '请求错误');
    return {};
  });
  const summary = await executeUnfollow({ client, actions: items(5), csrf: 't' });

  assert.equal(summary.ok, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.aborted, false);
  assert.equal(summary.records[1].code, -400);
  assert.equal(summary.records[1].message, '请求错误');
});

test('unfollow stops immediately on risk control', async () => {
  const client = fakeClient(async (call) => {
    if (call === 3) throw new BiliApiError(-352, '风控校验失败');
    return {};
  });
  const summary = await executeUnfollow({ client, actions: items(10), csrf: 't' });

  assert.equal(summary.aborted, true);
  assert.equal(summary.records.length, 3, 'nothing is attempted after the refusal');
  assert.equal(summary.ok, 2);
  assert.equal(client.calls.length, 3);
  assert.equal(summary.records[2].code, -352);
});

test('a network-style error does not abort the run', async () => {
  // -352 means "stop"; a plain failure means "skip this one and continue".
  const client = fakeClient(async (call) => {
    if (call === 1) throw new BiliApiError('network', 'socket hang up');
    return {};
  });
  const summary = await executeUnfollow({ client, actions: items(3), csrf: 't' });
  assert.equal(summary.aborted, false);
  assert.equal(summary.ok, 2);
  assert.equal(summary.records[0].code, 'network');
});

test('every risk-control code aborts, not just -352', async () => {
  for (const code of [-352, -412, -509, -799]) {
    const client = fakeClient(async () => { throw new BiliApiError(code, 'throttled'); });
    const summary = await executeUnfollow({ client, actions: items(5), csrf: 't' });
    assert.equal(summary.aborted, true, `code ${code} must abort`);
    assert.equal(summary.records.length, 1);
  }
});

test('unfollow records carry the position for logging', async () => {
  const client = fakeClient(async () => ({}));
  const summary = await executeUnfollow({ client, actions: items(3), csrf: 't' });
  assert.deepEqual(summary.records.map((r) => r.position), [1, 2, 3]);
  assert.ok(summary.records.every((r) => r.total === 3));
  assert.ok(summary.records.every((r) => r.action === 'unfollow'));
});

test('unfollow rounds the age it records', async () => {
  const client = fakeClient(async () => ({}));
  const summary = await executeUnfollow({
    client, actions: [{ id: 1, label: 'x', ageDays: 123.7 }], csrf: 't',
  });
  assert.equal(summary.records[0].ageDays, 124);
});

test('an empty action list is a no-op', async () => {
  const client = fakeClient(async () => ({}));
  const summary = await executeUnfollow({ client, actions: [], csrf: 't' });
  assert.deepEqual({ ok: summary.ok, failed: summary.failed, aborted: summary.aborted },
    { ok: 0, failed: 0, aborted: false });
  assert.equal(client.calls.length, 0);
});

// -------------------------------------------------------- executeFavorites
const favItems = (count) => Array.from({ length: count }, (_, index) => ({
  id: 5000 + index,
  label: `video ${index}`,
  ageDays: 900 + index,
  raw: { type: 2, bvid: `BV${index}` },
}));

test('favourites are deleted in batches of the given size', async () => {
  const client = fakeClient(async () => ({}));
  const batches = [];
  const summary = await executeFavorites({
    client, mediaId: '60971020', actions: favItems(45), csrf: 't', batchSize: 20,
    onBatch: (b) => batches.push(b),
  });

  assert.equal(client.calls.length, 3, '45 items in batches of 20 is three requests');
  assert.deepEqual(batches.map((b) => b.size), [20, 20, 5]);
  assert.equal(summary.batches, 3);
  assert.equal(summary.ok, 45);
});

test('favourite batches carry media_id and an encoded resource list', async () => {
  const client = fakeClient(async () => ({}));
  await executeFavorites({
    client, mediaId: '60971020', actions: favItems(2), csrf: 'MYCSRF', batchSize: 20,
  });

  const { url, params } = client.calls[0];
  assert.match(url, /resource\/batch-del/);
  assert.equal(params.media_id, '60971020');
  assert.equal(params.csrf, 'MYCSRF');
  assert.equal(params.resources, '5000:2,5001:2');
});

test('a failed batch marks every member failed, because the API cannot say which landed', async () => {
  const client = fakeClient(async (call) => {
    if (call === 2) throw new BiliApiError(-400, 'bad request');
    return {};
  });
  const summary = await executeFavorites({
    client, mediaId: '1', actions: favItems(30), csrf: 't', batchSize: 10,
  });

  assert.equal(summary.records.length, 30);
  assert.equal(summary.ok, 20);
  assert.equal(summary.failed, 10);
  assert.ok(summary.records.slice(10, 20).every((r) => r.ok === false));
  assert.ok(summary.records.slice(20).every((r) => r.ok === true), 'the run continues past a failed batch');
});

test('a risk-control batch stops the whole run', async () => {
  const client = fakeClient(async (call) => {
    if (call === 2) throw new BiliApiError(-412, '请求被拦截');
    return {};
  });
  const summary = await executeFavorites({
    client, mediaId: '1', actions: favItems(50), csrf: 't', batchSize: 10,
  });

  assert.equal(summary.aborted, true);
  assert.equal(client.calls.length, 2, 'no batch is attempted after the refusal');
  assert.equal(summary.records.length, 20);
});

test('favourite records carry the id, type and bvid needed to restore them', async () => {
  const client = fakeClient(async () => ({}));
  const summary = await executeFavorites({
    client, mediaId: '77', actions: favItems(2), csrf: 't',
  });
  const [first] = summary.records;
  assert.equal(first.action, 'favorites');
  assert.equal(first.mediaId, '77');
  assert.equal(first.id, 5000);
  assert.equal(first.type, 2);
  assert.equal(first.bvid, 'BV0');
  assert.equal(first.title, 'video 0');
});

test('a missing type is not silently sent as zero', async () => {
  // type 0 is not a valid resource type; encodeType must fall back to video.
  const client = fakeClient(async () => ({}));
  await executeFavorites({
    client, mediaId: '1', csrf: 't',
    actions: [{ id: 1, label: 'x', ageDays: 1, raw: { type: 0, bvid: 'BV1' } }],
  });
  assert.match(client.calls[0].params.resources, /^1:2$/);
});

// ------------------------------------------------------------- history
function tempLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bili-hist-'));
}

test('newestSnapshot picks the most recently written file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-snap-'));
  fs.writeFileSync(path.join(dir, 'followings-old.json'), '{}');
  fs.writeFileSync(path.join(dir, 'followings-new.json'), '{}');
  fs.writeFileSync(path.join(dir, 'fav-1.json'), '{}');
  // mtime ordering is what counts, not the name.
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(dir, 'followings-old.json'), now - 100, now - 100);
  fs.utimesSync(path.join(dir, 'followings-new.json'), now, now);

  assert.match(newestSnapshot('followings-', dir), /followings-new\.json$/);
  assert.match(newestSnapshot('fav-', dir), /fav-1\.json$/);
});

test('newestSnapshot returns null rather than throwing', () => {
  assert.equal(newestSnapshot('nope-', path.join(os.tmpdir(), 'bili-nothing-here')), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-snap-'));
  assert.equal(newestSnapshot('followings-', empty), null);
});

test('readHistory pairs a header with its summary', () => {
  const dir = tempLogDir();
  fs.writeFileSync(path.join(dir, 'unfollow-1.jsonl'), [
    JSON.stringify({ kind: 'header', ts: '2026-10-08T17:00:00.000Z', action: 'unfollow', source: 'gui', planned: 5 }),
    JSON.stringify({ action: 'unfollow', mid: 1, ok: true }),
    JSON.stringify({ kind: 'summary', ok: 4, failed: 1, aborted: false }),
  ].join('\n'), 'utf8');

  const [entry] = readHistory(dir, 5);
  assert.equal(entry.action, 'unfollow');
  assert.equal(entry.source, 'gui');
  assert.equal(entry.planned, 5);
  assert.equal(entry.ok, 4);
  assert.equal(entry.failed, 1);
  assert.equal(entry.finished, true);
});

test('a run that crashed before its summary is marked unfinished', () => {
  const dir = tempLogDir();
  fs.writeFileSync(path.join(dir, 'unfollow-1.jsonl'),
    JSON.stringify({ kind: 'header', ts: '2026-10-08T17:00:00.000Z', action: 'unfollow' }), 'utf8');

  const [entry] = readHistory(dir, 5);
  assert.equal(entry.finished, false);
  assert.equal(entry.ok, null);
});

test('readHistory survives a truncated or junk log file', () => {
  const dir = tempLogDir();
  fs.writeFileSync(path.join(dir, 'unfollow-bad.jsonl'), '{"kind":"header"\nnot json at all\n', 'utf8');
  assert.deepEqual(readHistory(dir, 5), []);
});

test('readHistory honours its limit and orders newest first', () => {
  const dir = tempLogDir();
  for (const name of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(dir, `${name}.jsonl`),
      JSON.stringify({ kind: 'header', ts: '2026-01-01T00:00:00.000Z', action: 'unfollow' }), 'utf8');
  }
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(dir, 'a.jsonl'), now - 300, now - 300);
  fs.utimesSync(path.join(dir, 'b.jsonl'), now - 200, now - 200);
  fs.utimesSync(path.join(dir, 'c.jsonl'), now, now);

  assert.equal(readHistory(dir, 2).length, 2);
  assert.match(readHistory(dir, 1)[0].file, /c\.jsonl$/);
});

test('logFiles ignores anything that is not a jsonl log', () => {
  const dir = tempLogDir();
  fs.writeFileSync(path.join(dir, 'x.jsonl'), '{}');
  fs.writeFileSync(path.join(dir, 'x.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
  assert.equal(logFiles(dir).length, 1);
});

test('ranOnLocalDate matches on the local calendar day', () => {
  const dir = tempLogDir();
  const when = new Date(2026, 9, 8, 14, 30);
  const key = `2026-10-08`;
  fs.writeFileSync(path.join(dir, 'unfollow-1.jsonl'),
    JSON.stringify({ kind: 'header', ts: when.toISOString(), action: 'unfollow' }), 'utf8');

  assert.equal(ranOnLocalDate(key, dir), true);
  assert.equal(ranOnLocalDate('2026-10-09', dir), false);
});

test('ranOnLocalDate is false when there are no logs at all', () => {
  assert.equal(ranOnLocalDate('2026-10-08', path.join(os.tmpdir(), 'bili-no-logs-here')), false);
});

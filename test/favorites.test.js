import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeType, addFavoriteResource, removeFavoriteBatch } from '../src/actions.js';
import { readRestoreList } from '../restore-favorites.js';
import { pickSnapshot, favoriteSnapshots } from '../purge-favorites.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async postForm(url, params) {
      calls.push({ url: new URL(url), params });
      return { code: 0 };
    },
  };
}

// The normaliser stores 0 when the API omits `type`, and `id:0` would target a
// nonsense type. This is the bug that made encodeType necessary.
test('a missing or zero type encodes as video', () => {
  assert.equal(encodeType(0), 2);
  assert.equal(encodeType(undefined), 2);
  assert.equal(encodeType(null), 2);
  assert.equal(encodeType(''), 2);
  assert.equal(encodeType('abc'), 2);
  assert.equal(encodeType(-1), 2);
});

test('real type codes pass through untouched', () => {
  assert.equal(encodeType(2), 2);
  assert.equal(encodeType(12), 12);
  assert.equal(encodeType(21), 21);
  assert.equal(encodeType('12'), 12);
});

test('a zero type never reaches the wire as 0', async () => {
  const client = fakeClient();
  await removeFavoriteBatch(client, {
    mediaId: 1, csrf: 'T', resources: [{ id: 5, type: 0 }, { id: 6, type: 12 }],
  });
  assert.equal(client.calls[0].params.resources, '5:2,6:12');
  assert.ok(!client.calls[0].params.resources.includes(':0'));
});

test('restoring posts rid, type and the target folder', async () => {
  const client = fakeClient();
  await addFavoriteResource(client, { mediaId: 60971020, id: 111, type: 2, csrf: 'TOKEN' });

  const [{ url, params }] = client.calls;
  assert.equal(url.pathname, '/x/v3/fav/resource/deal');
  assert.equal(params.rid, 111);
  assert.equal(params.type, 2);
  assert.equal(params.add_media_ids, 60971020);
  assert.equal(params.csrf, 'TOKEN');
});

// ------------------------------------------------------------ restore logs
function tempLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-fav-'));
  const file = path.join(dir, 'favorites-x.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

test('readRestoreList pulls the folder from the header and the deleted entries', () => {
  const file = tempLog([
    JSON.stringify({ kind: 'header', action: 'favorites', mediaId: 60971020, folderTitle: '默认收藏夹' }),
    JSON.stringify({ action: 'favorites', id: '111', type: 2, title: 'A', ok: true }),
    JSON.stringify({ action: 'favorites', id: '222', type: 12, title: 'B', ok: true }),
    JSON.stringify({ action: 'favorites', id: '333', type: 2, title: 'C', ok: false, code: -352 }),
    JSON.stringify({ kind: 'summary', ok: 2, failed: 1 }),
  ]);

  const result = readRestoreList(file);
  assert.equal(result.mediaId, 60971020);
  assert.equal(result.folderTitle, '默认收藏夹');
  assert.deepEqual(result.entries.map((entry) => entry.id), ['111', '222']);
  assert.equal(result.entries[1].type, 12);
});

test('readRestoreList ignores a failed batch, which may be partly applied', () => {
  const file = tempLog([
    JSON.stringify({ kind: 'header', action: 'favorites', mediaId: 1 }),
    JSON.stringify({ action: 'favorites', id: '9', type: 2, ok: false, code: 500 }),
  ]);
  assert.deepEqual(readRestoreList(file).entries, []);
});

test('readRestoreList survives a truncated final line', () => {
  const file = tempLog([
    JSON.stringify({ kind: 'header', action: 'favorites', mediaId: 1 }),
    JSON.stringify({ action: 'favorites', id: '9', type: 2, ok: true }),
    '{"action":"favor',
  ]);
  assert.deepEqual(readRestoreList(file).entries.map((entry) => entry.id), ['9']);
});

test('readRestoreList reports a null folder when there is no header', () => {
  const file = tempLog([JSON.stringify({ action: 'favorites', id: '9', type: 2, ok: true })]);
  const result = readRestoreList(file);
  assert.equal(result.mediaId, null);
  assert.equal(result.entries.length, 1);
});

// --------------------------------------------------------- pickSnapshot
function snapshotDir(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-snap-'));
  for (const [name, payload] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(payload), 'utf8');
  }
  return dir;
}

test('a snapshot stores mediaId as a string, and the filter still matches it', () => {
  // This is the bug: the dry run printed an --execute command containing
  // --folder=<id>, and that command then failed to find its own snapshot
  // because the comparison was String === Number.
  const dir = snapshotDir({
    'fav-60971020-2026-01-01.json': { mediaId: '60971020', title: '默认收藏夹', fetched: 3228 },
  });

  assert.match(pickSnapshot('60971020', dir), /fav-60971020/);
  assert.match(pickSnapshot(60971020, dir), /fav-60971020/, 'a numeric filter works too');
  assert.match(pickSnapshot(' 60971020 ', dir), /fav-60971020/, 'stray whitespace is tolerated');
});

test('the newest snapshot is used when no folder is given', () => {
  const dir = snapshotDir({
    'fav-1-old.json': { mediaId: '1', title: 'old', fetched: 1 },
    'fav-2-new.json': { mediaId: '2', title: 'new', fetched: 1 },
  });
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(dir, 'fav-1-old.json'), now - 500, now - 500);
  fs.utimesSync(path.join(dir, 'fav-2-new.json'), now, now);

  assert.match(pickSnapshot(undefined, dir), /fav-2-new/);
  assert.match(pickSnapshot('', dir), /fav-2-new/);
  assert.match(pickSnapshot(null, dir), /fav-2-new/);
});

test('the right folder is chosen out of several', () => {
  const dir = snapshotDir({
    'fav-111.json': { mediaId: '111', title: 'A', fetched: 5 },
    'fav-222.json': { mediaId: '222', title: 'B', fetched: 6 },
  });
  assert.match(pickSnapshot('222', dir), /fav-222/);
  assert.match(pickSnapshot('111', dir), /fav-111/);
});

test('an unknown folder lists what is available instead of guessing', () => {
  const dir = snapshotDir({
    'fav-111.json': { mediaId: '111', title: 'A', fetched: 5 },
  });
  assert.throws(() => pickSnapshot('999', dir), (error) => {
    assert.match(error.message, /no snapshot for folder 999/);
    assert.match(error.message, /fav-111\.json/, 'the message names the snapshots that do exist');
    return true;
  });
});

test('having no snapshots at all explains how to make one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-snap-'));
  assert.throws(() => pickSnapshot(undefined, dir), /fetch-snapshot\.js/);
});

test('favoriteSnapshots ignores unrelated files', () => {
  const dir = snapshotDir({
    'fav-111.json': { mediaId: '111' },
    'followings-1.json': { fetched: 1 },
    'folders-1.json': { folders: [] },
    'fav-111.txt': 'nope',
  });
  assert.equal(favoriteSnapshots(dir).length, 1);
});

test('a corrupt snapshot does not take the whole listing down', () => {
  const dir = snapshotDir({ 'fav-111.json': { mediaId: '111', title: 'A', fetched: 5 } });
  fs.writeFileSync(path.join(dir, 'fav-broken.json'), '{not json', 'utf8');
  // The good one is still selectable by folder. Directory order is not
  // guaranteed and the two files can share an mtime, so this must hold
  // whichever of them is examined first.
  assert.match(pickSnapshot('111', dir), /fav-111/);
});

test('the "no such folder" help still lists the good snapshots when one is corrupt', () => {
  // The help message re-reads every file to describe it. If that read throws,
  // the message that is supposed to explain the failure fails instead.
  const dir = snapshotDir({ 'fav-111.json': { mediaId: '111', title: 'A', fetched: 5 } });
  fs.writeFileSync(path.join(dir, 'fav-broken.json'), '{not json', 'utf8');
  assert.throws(() => pickSnapshot('999', dir), (error) => {
    assert.match(error.message, /fav-111\.json/, 'the readable snapshot is described');
    assert.match(error.message, /fav-broken\.json/, 'the corrupt one is still named');
    assert.match(error.message, /unreadable/, 'and it is explained, not silently dropped');
    return true;
  });
});

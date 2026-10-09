import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getNav, getRelationStat, listAllFollowings, listFavoriteFolders, listAllFavoriteResources,
  normalizeFollowing, normalizeFavorite, invalidReason,
  followingsUrl, favoriteResourcesUrl, favoriteFoldersUrl,
} from '../src/bili.js';

/** A client whose only job is to answer by pathname and record the URLs asked. */
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async get(url) {
      const parsed = new URL(url);
      calls.push(parsed);
      return handler(parsed, calls.length);
    },
  };
}

const rows = (count, offset = 0) => Array.from({ length: count }, (_, i) => ({ mid: offset + i + 1 }));

test('getNav returns the identity when logged in', async () => {
  const client = fakeClient(() => ({ isLogin: true, mid: 777, uname: 'tester' }));
  assert.deepEqual(await getNav(client), { mid: 777, uname: 'tester', vip: null });
});

test('getNav refuses a logged-out cookie', async () => {
  const client = fakeClient(() => ({ isLogin: false }));
  await assert.rejects(getNav(client), /not logged in/);
});

test('getRelationStat reads the counters', async () => {
  const client = fakeClient(() => ({ following: 1755, follower: 594 }));
  assert.deepEqual(await getRelationStat(client, 777), { following: 1755, follower: 594 });
  assert.equal(client.calls[0].pathname, '/x/relation/stat');
  assert.equal(client.calls[0].searchParams.get('vmid'), '777');
});

test('getRelationStat tolerates missing counters', async () => {
  const client = fakeClient(() => ({}));
  assert.deepEqual(await getRelationStat(client, 777), { following: null, follower: null });
});

test('the followings url asks for newest-first ordering', () => {
  const url = new URL(followingsUrl(777, 2, 50));
  assert.equal(url.pathname, '/x/relation/followings');
  assert.equal(url.searchParams.get('vmid'), '777');
  assert.equal(url.searchParams.get('pn'), '2');
  assert.equal(url.searchParams.get('ps'), '50');
  assert.equal(url.searchParams.get('order'), 'desc');
  assert.equal(url.searchParams.get('order_type'), 'attention');
});

test('followings are paginated until a short page', async () => {
  const client = fakeClient((url) => {
    const page = Number(url.searchParams.get('pn'));
    if (page === 1) return { list: rows(50, 0), total: 103 };
    if (page === 2) return { list: rows(50, 50), total: 103 };
    return { list: rows(3, 100), total: 103 };
  });

  const { rows: all, total, complete } = await listAllFollowings(client, 777);
  assert.equal(all.length, 103);
  assert.equal(total, 103);
  assert.equal(complete, true);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls.map((c) => c.searchParams.get('pn')), ['1', '2', '3']);
});

test('pagination stops as soon as the reported total is reached', async () => {
  const client = fakeClient(() => ({ list: rows(50), total: 50 }));
  const { rows: all } = await listAllFollowings(client, 777);
  assert.equal(all.length, 50);
  assert.equal(client.calls.length, 1, 'a full page that already covers the total needs no second call');
});

test('pagination stops at maxPages and reports incompleteness', async () => {
  const client = fakeClient(() => ({ list: rows(50), total: 5000 }));
  const { rows: all, complete } = await listAllFollowings(client, 777, { maxPages: 3 });
  assert.equal(all.length, 150);
  assert.equal(complete, false);
  assert.equal(client.calls.length, 3);
});

test('a capped followings response is surfaced as incomplete', async () => {
  // The API can report more follows than it is willing to page through.
  const client = fakeClient((url) => {
    const page = Number(url.searchParams.get('pn'));
    return page === 1 ? { list: rows(50), total: 1760 } : { list: [], total: 1760 };
  });
  const { rows: all, total, complete } = await listAllFollowings(client, 777);
  assert.equal(all.length, 50);
  assert.equal(total, 1760);
  assert.equal(complete, false, 'callers must be able to warn about this');
});

test('an empty followings list is not an error', async () => {
  const client = fakeClient(() => ({ list: [], total: 0 }));
  const { rows: all, complete } = await listAllFollowings(client, 777);
  assert.deepEqual(all, []);
  assert.equal(complete, true);
});

test('a malformed followings payload does not throw', async () => {
  const client = fakeClient(() => ({ unexpected: true }));
  const { rows: all } = await listAllFollowings(client, 777);
  assert.deepEqual(all, []);
});

test('favourite folders are mapped and the default one is flagged', async () => {
  const client = fakeClient(() => ({
    list: [
      { id: 111, title: '默认收藏夹', media_count: 3277, attr: 1 },
      { id: 222, title: '日语流行', media_count: 1, attr: 0 },
    ],
  }));

  const folders = await listFavoriteFolders(client, 777);
  assert.equal(folders.length, 2);
  assert.deepEqual(
    folders.map((f) => [f.mediaId, f.title, f.count, f.isDefault]),
    [[111, '默认收藏夹', 3277, true], [222, '日语流行', 1, false]],
  );
  assert.equal(client.calls[0].searchParams.get('up_mid'), '777');
});

test('favourite folder listing tolerates a missing list', async () => {
  const client = fakeClient(() => ({}));
  assert.deepEqual(await listFavoriteFolders(client, 777), []);
});

test('favourite contents are paginated until has_more is false', async () => {
  const client = fakeClient((url) => {
    const page = Number(url.searchParams.get('pn'));
    if (page === 1) return { medias: rows(20, 0), has_more: true, info: { media_count: 23, title: '默认收藏夹' } };
    return { medias: rows(3, 20), has_more: false, info: { media_count: 23, title: '默认收藏夹' } };
  });

  const { rows: all, info } = await listAllFavoriteResources(client, 111);
  assert.equal(all.length, 23);
  assert.equal(info.title, '默认收藏夹');
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((c) => c.searchParams.get('pn')), ['1', '2']);
});

test('favourite pagination stops on an empty page even if has_more lies', async () => {
  const client = fakeClient(() => ({ medias: [], has_more: true }));
  const { rows: all } = await listAllFavoriteResources(client, 111);
  assert.deepEqual(all, []);
  assert.equal(client.calls.length, 1);
});

test('the favourite resources url pins the folder and ordering', () => {
  const url = new URL(favoriteResourcesUrl(111, 3, 20));
  assert.equal(url.pathname, '/x/v3/fav/resource/list');
  assert.equal(url.searchParams.get('media_id'), '111');
  assert.equal(url.searchParams.get('pn'), '3');
  assert.equal(url.searchParams.get('ps'), '20');
  assert.equal(url.searchParams.get('order'), 'mtime');
});

test('the folder list url is scoped to the owner', () => {
  const url = new URL(favoriteFoldersUrl(777));
  assert.equal(url.searchParams.get('up_mid'), '777');
});

test('following rows decode the attribute bit field', () => {
  assert.deepEqual(
    normalizeFollowing({ mid: 5, uname: 'a', mtime: 100, special: 1, attribute: 6 }),
    {
      mid: '5', uname: 'a', mtime: 100, special: true, mutual: true, attribute: 6, face: '', sign: '',
    },
  );
  assert.equal(normalizeFollowing({ mid: 5, attribute: 2 }).mutual, false);
  assert.equal(normalizeFollowing({ mid: 5, attribute: 0 }).mutual, false);
  assert.equal(normalizeFollowing({ mid: 5, special: 0 }).special, false);
});

test('following rows survive missing fields', () => {
  const row = normalizeFollowing({});
  assert.equal(row.mid, '');
  assert.equal(row.mtime, 0);
  assert.equal(row.special, false);
  assert.equal(row.mutual, false);
});

test('dead favourites are detected with a reason', () => {
  assert.equal(invalidReason({ title: '正常视频', bvid: 'BV1', attr: 0 }), null);
  assert.match(invalidReason({ title: '已失效视频', attr: 0 }), /placeholder/);
  assert.match(invalidReason({ title: '已失效', attr: 0 }), /placeholder/);
  assert.match(invalidReason({ title: '', bvid: '' }), /no title/);
  assert.match(invalidReason({ title: 'x', bvid: '', attr: 0 }), /missing bvid/);
  assert.match(invalidReason(null), /empty/);
});

test('a non-zero attr does NOT mark an entry dead', () => {
  // attr carries genre/official flags (互动视频 used 16, 央视春晚 used 2), not
  // validity. Treating it as a death signal mislabelled 28 live videos.
  assert.equal(invalidReason({ title: '你被困在2025年10月25日', bvid: 'BV1bhspzoENJ', attr: 16 }), null);
  assert.equal(invalidReason({ title: '胡彦斌《红颜》', bvid: 'BV1vZ4oeyENs', attr: 2 }), null);
});

test('favourite rows are normalised with the folder attached', () => {
  const item = normalizeFavorite({
    id: 42,
    type: 2,
    bvid: 'BV1xx',
    title: '标题',
    upper: { mid: 9, name: 'UP主' },
    fav_time: 1700000000,
    duration: 300,
    attr: 0,
  }, { mediaId: 111, title: '默认收藏夹' });

  assert.equal(item.id, '42');
  assert.equal(item.upper, 'UP主');
  assert.equal(item.upperMid, '9');
  assert.equal(item.favTime, 1700000000);
  assert.equal(item.invalid, false);
  assert.equal(item.folderId, 111);
  assert.equal(item.folderTitle, '默认收藏夹');
});

test('a dead favourite is flagged in the normalised row', () => {
  const item = normalizeFavorite({ id: 1, title: '已失效视频', attr: 0 });
  assert.equal(item.invalid, true);
  assert.ok(item.invalidReason);
  assert.equal(item.folderId, null);
});

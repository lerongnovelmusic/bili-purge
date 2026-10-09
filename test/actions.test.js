import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  unfollow, refollow, removeFavoriteBatch, chunkResources,
  RELATION_ACTION, FAVORITE_BATCH_SIZE,
} from '../src/actions.js';

/** Records what a write call would send, without touching the network. */
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

test('unfollow posts the relation change with the CSRF token', async () => {
  const client = fakeClient();
  await unfollow(client, { fid: '546195', csrf: 'TOKEN' });

  const [{ url, params }] = client.calls;
  assert.equal(url.pathname, '/x/relation/modify');
  assert.equal(params.fid, '546195');
  assert.equal(params.act, RELATION_ACTION.unfollow);
  assert.equal(params.act, 2);
  assert.equal(params.csrf, 'TOKEN');
});

test('refollow differs only in the action code', async () => {
  const client = fakeClient();
  await refollow(client, { fid: '546195', csrf: 'TOKEN' });

  assert.equal(client.calls[0].params.act, 1);
  assert.equal(client.calls[0].params.act, RELATION_ACTION.follow);
});

test('favourite batches encode id:type pairs', async () => {
  const client = fakeClient();
  await removeFavoriteBatch(client, {
    mediaId: 60971020,
    csrf: 'TOKEN',
    resources: [{ id: 111, type: 2 }, { id: 222, type: 12 }],
  });

  const [{ url, params }] = client.calls;
  assert.equal(url.pathname, '/x/v3/fav/resource/batch-del');
  assert.equal(params.media_id, 60971020);
  assert.equal(params.resources, '111:2,222:12');
  assert.equal(params.csrf, 'TOKEN');
});

test('an entry with no type defaults to video', async () => {
  const client = fakeClient();
  await removeFavoriteBatch(client, { mediaId: 1, csrf: 'T', resources: [{ id: 5 }] });
  assert.equal(client.calls[0].params.resources, '5:2');
});

test('chunking respects the batch size and keeps every entry', () => {
  const entries = Array.from({ length: 45 }, (_, i) => ({ id: i, type: 2 }));
  const batches = chunkResources(entries);

  assert.equal(batches.length, Math.ceil(45 / FAVORITE_BATCH_SIZE));
  assert.equal(batches.flat().length, 45);
  assert.deepEqual(batches[0].length, FAVORITE_BATCH_SIZE);
  assert.deepEqual(batches[batches.length - 1].length, 5);
});

test('chunking an empty list yields no batches', () => {
  assert.deepEqual(chunkResources([]), []);
});

test('a custom batch size is honoured', () => {
  const batches = chunkResources([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1);
});

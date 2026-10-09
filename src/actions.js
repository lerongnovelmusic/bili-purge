/**
 * The two write actions. Everything else in this project is read-only.
 *
 * Both endpoints are idempotent, which is why the HTTP layer may retry them
 * after a network failure without risking a double effect.
 */
import { buildUrl } from './http.js';

const API_BASE = 'https://api.bilibili.com';

/** Relation actions accepted by /x/relation/modify. */
export const RELATION_ACTION = {
  follow: 1,
  unfollow: 2,
};

/**
 * Follow or unfollow one user.
 * @param {object} client    from createClient
 * @param {{fid: string|number, csrf: string, act?: number}} params
 */
export async function modifyRelation(client, { fid, csrf, act = RELATION_ACTION.unfollow }) {
  return client.postForm(buildUrl('/x/relation/modify', {}, API_BASE), {
    fid,
    act,
    re_src: 11,
    csrf,
  });
}

export const unfollow = (client, { fid, csrf }) => modifyRelation(client, { fid, csrf, act: RELATION_ACTION.unfollow });
export const refollow = (client, { fid, csrf }) => modifyRelation(client, { fid, csrf, act: RELATION_ACTION.follow });

/**
 * Remove entries from a favourite folder.
 * @param {object} client
 * @param {{mediaId: string|number, resources: Array<{id: string|number, type: number}>, csrf: string}} params
 */
export async function removeFavoriteBatch(client, { mediaId, resources, csrf }) {
  const encoded = resources.map(({ id, type }) => `${id}:${encodeType(type)}`).join(',');
  return client.postForm(buildUrl('/x/v3/fav/resource/batch-del', {}, API_BASE), {
    media_id: mediaId,
    resources: encoded,
    csrf,
  });
}

/**
 * Put one entry back into a favourite folder.
 *
 * This is the undo for a deletion. It restores the entry but NOT the original
 * favourite time, so a restored item looks freshly collected to later runs.
 */
export async function addFavoriteResource(client, { mediaId, id, type, csrf }) {
  return client.postForm(buildUrl('/x/v3/fav/resource/deal', {}, API_BASE), {
    rid: id,
    type: encodeType(type),
    add_media_ids: mediaId,
    csrf,
  });
}

/**
 * Bilibili's favourite type codes: 2 video, 12 audio, 21 video collection.
 * The normaliser stores 0 when the API omits the field, and sending `id:0`
 * would silently target a nonsense type, so 0 is treated as "video".
 */
export function encodeType(type) {
  const value = Number(type);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

/** How many resources go into one batch-del call. */
export const FAVORITE_BATCH_SIZE = 20;

/** Split favourite entries into delete-sized batches. */
export function chunkResources(entries, size = FAVORITE_BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < entries.length; index += size) {
    batches.push(entries.slice(index, index + size));
  }
  return batches;
}

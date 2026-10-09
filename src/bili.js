/**
 * Read-only Bilibili API wrappers. GET requests only -- nothing here can change
 * account state.
 *
 * Endpoints used:
 *   /x/web-interface/nav                   who am I (validates the cookie, gives mid)
 *   /x/relation/followings                 who I follow, with mtime + special flags
 *   /x/v3/fav/folder/created/list-all      my favourite folders
 *   /x/v3/fav/resource/list                the videos inside one folder
 */
import { buildUrl } from './http.js';

export const API_BASE = 'https://api.bilibili.com';

/** Who the current cookie belongs to. Throws if the cookie is not logged in. */
export async function getNav(client) {
  const data = await client.get(buildUrl('/x/web-interface/nav', {}, API_BASE));
  if (!data?.isLogin) {
    throw new Error('this cookie is not logged in (nav.isLogin is false) -- SESSDATA is stale or wrong');
  }
  return { mid: data.mid, uname: data.uname, vip: data.vipStatus ?? null };
}

/**
 * Follower / following counters for a user.
 *
 * `/x/web-interface/nav` does NOT carry these, so this is a separate call. It
 * is one request, which makes it the cheapest way to confirm server-side that a
 * batch run actually changed the account.
 */
export async function getRelationStat(client, mid) {
  const data = await client.get(buildUrl('/x/relation/stat', { vmid: mid }, API_BASE));
  return {
    following: Number.isFinite(data?.following) ? data.following : null,
    follower: Number.isFinite(data?.follower) ? data.follower : null,
  };
}

export function followingsUrl(mid, page, pageSize) {
  return buildUrl('/x/relation/followings', {
    vmid: mid,
    pn: page,
    ps: pageSize,
    order: 'desc',
    order_type: 'attention',
    web_location: '333.1387',
  }, API_BASE);
}

const FOLLOWINGS_PAGE_SIZE = 50;

/**
 * Walk every page of the followings list.
 * @returns {Promise<{rows: object[], total: number|null, complete: boolean}>}
 */
export async function listAllFollowings(client, mid, options = {}) {
  const { pageSize = FOLLOWINGS_PAGE_SIZE, maxPages = 400, onPage } = options;
  const rows = [];
  let total = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await client.get(followingsUrl(mid, page, pageSize));
    const list = Array.isArray(data?.list) ? data.list : [];
    if (typeof data?.total === 'number') total = data.total;
    rows.push(...list);
    onPage?.({ page, got: list.length, rows: rows.length, total });

    if (list.length < pageSize) break;
    if (total !== null && rows.length >= total) break;
  }

  return { rows, total, complete: total === null || rows.length >= total };
}

export function favoriteFoldersUrl(mid) {
  return buildUrl('/x/v3/fav/folder/created/list-all', {
    up_mid: mid,
    web_location: '333.1387',
  }, API_BASE);
}

export async function listFavoriteFolders(client, mid) {
  const data = await client.get(favoriteFoldersUrl(mid));
  const list = Array.isArray(data?.list) ? data.list : [];
  return list.map((folder) => ({
    mediaId: folder.id,
    title: folder.title,
    count: folder.media_count,
    isDefault: Boolean(folder.attr & 1),
    raw: folder,
  }));
}

export function favoriteResourcesUrl(mediaId, page, pageSize) {
  return buildUrl('/x/v3/fav/resource/list', {
    media_id: mediaId,
    pn: page,
    ps: pageSize,
    platform: 'web',
    order: 'mtime',
    type: 0,
    tid: 0,
    web_location: '333.1387',
  }, API_BASE);
}

const FAVORITES_PAGE_SIZE = 20;

/**
 * Walk every page of one favourite folder.
 * @returns {Promise<{rows: object[], info: object|null}>}
 */
export async function listAllFavoriteResources(client, mediaId, options = {}) {
  const { pageSize = FAVORITES_PAGE_SIZE, maxPages = 1000, onPage } = options;
  const rows = [];
  let info = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await client.get(favoriteResourcesUrl(mediaId, page, pageSize));
    if (data?.info) info = data.info;
    const medias = Array.isArray(data?.medias) ? data.medias : [];
    rows.push(...medias);
    onPage?.({
      page,
      got: medias.length,
      rows: rows.length,
      total: data?.info?.media_count ?? null,
      hasMore: Boolean(data?.has_more),
    });

    if (!data?.has_more || medias.length === 0) break;
  }

  return { rows, info };
}

/** Titles Bilibili substitutes for an entry that no longer resolves. */
const PLACEHOLDER_TITLES = new Set(['已失效视频', '已失效', '视频已失效']);

/**
 * Is this favourite entry dead? Deliberately conservative: it reports a reason
 * so the raw values can be checked against reality before trusting it.
 *
 * `attr` is NOT used as a signal. It is not a validity flag -- a real folder
 * showed attr=16 on 互动视频 (interactive videos) and attr=2 on official
 * uploads (央视春晚, 中秋漫游夜), all with live titles and valid bvids. Treating
 * a non-zero attr as "dead" mislabelled 28 live entries and, through the
 * dead-first ordering, queued them for deletion ahead of everything else.
 *
 * @returns {string|null} reason, or null when the entry looks alive
 */
export function invalidReason(media) {
  if (!media || typeof media !== 'object') return 'empty entry';
  const title = typeof media.title === 'string' ? media.title.trim() : '';
  const bvid = media.bvid ?? media.bv_id ?? '';
  if (title === '' && !bvid) return 'no title and no bvid';
  if (PLACEHOLDER_TITLES.has(title)) return `placeholder title "${title}"`;
  if (!bvid) return 'missing bvid';
  return null;
}

/**
 * Normalise a followings row. `attribute` is a bit field: bit 2 means "I follow
 * them", bit 4 means "they follow me", so 6 is mutual.
 */
export function normalizeFollowing(row) {
  const attribute = Number(row?.attribute ?? 0);
  return {
    mid: String(row?.mid ?? ''),
    uname: row?.uname ?? '',
    mtime: Number(row?.mtime ?? 0),
    special: Number(row?.special ?? 0) === 1,
    mutual: (attribute & 4) === 4,
    attribute,
    face: row?.face ?? '',
    sign: row?.sign ?? '',
  };
}

export function normalizeFavorite(media, folder = {}) {
  const reason = invalidReason(media);
  return {
    id: String(media?.id ?? ''),
    type: Number(media?.type ?? 0),
    bvid: media?.bvid ?? media?.bv_id ?? '',
    title: media?.title ?? '',
    upper: media?.upper?.name ?? '',
    upperMid: String(media?.upper?.mid ?? ''),
    favTime: Number(media?.fav_time ?? 0),
    duration: Number(media?.duration ?? 0),
    attr: Number(media?.attr ?? 0),
    invalid: reason !== null,
    invalidReason: reason,
    folderId: folder.mediaId ?? null,
    folderTitle: folder.title ?? '',
  };
}

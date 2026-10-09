/**
 * Shared run construction: turn a snapshot into the exact list of actions that
 * a run would perform, plus the token that authorises it.
 *
 * The token is derived from the action list, the ruler settings and the seed,
 * so it can only confirm the plan that was actually printed. Change the cap,
 * the seed or the whitelist and the token changes with it.
 */
import { createHash } from 'node:crypto';

import { UNFOLLOW_PRESET, FAVORITE_PRESET, followingsProtection, favoritesProtection } from './config.js';
import { followingsToItems, favoritesToItems } from './report.js';
import { invalidReason } from './bili.js';
import { plan } from './sampler.js';

/**
 * Why a favourite entry looks dead, recomputed from its fields.
 *
 * The snapshot also carries an `invalid` boolean, but that is a cached verdict:
 * a snapshot written before a detection change keeps the old answer forever.
 * Recomputing means a stale snapshot cannot queue live entries for deletion.
 */
export function favoriteDeadReason(item) {
  return invalidReason(item?.raw ?? item ?? null);
}

/** Apply an absolute cap to the first (youngest) bucket only. */
export function withFreshCap(buckets, cap) {
  if (cap === null || cap === undefined || !Number.isFinite(cap)) return buckets;
  return buckets.map((bucket, index) => (index === 0 ? { ...bucket, capDays: cap } : bucket));
}

export function confirmToken(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 8).toUpperCase();
}

/**
 * Build the unfollow run.
 *
 * The oldest entries are actioned first, so a small trial batch always starts
 * with the items least likely to be regretted.
 */
export function buildUnfollowRun(options) {
  const {
    rows, cap = null, seed = UNFOLLOW_PRESET.seed, mode = UNFOLLOW_PRESET.mode,
    keep = [], limit = null, now = new Date(), preset = UNFOLLOW_PRESET,
  } = options;

  const items = followingsToItems(rows, now);
  const buckets = withFreshCap(preset.buckets, cap);
  const config = {
    ...preset,
    mode,
    seed,
    buckets,
    isProtected: followingsProtection({
      special: preset.protectSpecial,
      mutual: preset.protectMutual,
      extra: keep,
    }),
  };

  const result = plan(items, config);
  const budget = Math.min(result.drop.length, limit ?? preset.maxPerRun);
  const actions = result.drop.slice(0, budget);
  const token = confirmToken({
    kind: 'unfollow',
    ids: actions.map((item) => item.id),
    mode,
    seed,
    cap: Number.isFinite(cap) ? cap : null,
  });

  return { items, result, actions, budget, token, config, cap };
}

/** Build the favourite-purge run for one folder. */
export function buildFavoriteRun(options) {
  const {
    rows, cap = null, seed = FAVORITE_PRESET.seed, mode = FAVORITE_PRESET.mode,
    keep = [], limit = null, now = new Date(), preset = FAVORITE_PRESET, deadFirst = true,
  } = options;

  const items = favoritesToItems(rows, now);
  const buckets = withFreshCap(preset.buckets, cap);
  const config = {
    ...preset,
    mode,
    seed,
    buckets,
    isProtected: favoritesProtection({ extra: keep }),
  };

  const result = plan(items, config);

  // Dead entries are worth removing first: they carry no value at all, and
  // clearing them cannot lose anything the user might still want.
  const deadness = (item) => (favoriteDeadReason(item) === null ? 0 : 1);
  const ordered = deadFirst
    ? [...result.drop].sort((a, b) => deadness(b) - deadness(a))
    : result.drop;

  const budget = Math.min(ordered.length, limit ?? preset.maxPerRun);
  const actions = ordered.slice(0, budget);
  const token = confirmToken({
    kind: 'favorites',
    ids: actions.map((item) => item.id),
    mode,
    seed,
    cap: Number.isFinite(cap) ? cap : null,
  });

  return { items, result, actions, budget, token, config, cap };
}

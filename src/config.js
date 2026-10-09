/**
 * Default knobs. Two presets, because the two operations carry different risk:
 * unfollowing is hard to undo and is the more aggressively rate-limited action,
 * while removing a favourite is recoverable by simply favouriting again.
 */

/** Fractions of the timeline, not day counts. The last bucket must end at 1. */
export const TIMELINE_SPLIT = [
  { name: 'fresh', to: 0.3, keep: 0.95 },
  { name: 'normal', to: 0.7, keep: 0.5 },
  { name: 'stale', to: 1.0, keep: 0.3 },
];

export const DEFAULT_CONFIG = {
  /**
   * 'quantile' = buckets hold fixed shares of ITEMS (rank-based).
   * 'span'     = buckets sit at fixed positions inside the age range min..max.
   */
  mode: 'quantile',
  /** How sharply keep-preference decays along the timeline. Smaller = harsher on the old. */
  tau: 0.35,
  /** Fix a seed to replay the exact same plan before executing it. */
  seed: 1,
  buckets: TIMELINE_SPLIT,
};

/**
 * Unfollowing: conservative caps, because there is no undo button.
 *
 * The gap is deliberately much slower than any read operation. A comparable
 * maintained tool uses 5-20s and describes that as conservative enough to
 * "basically never" trip 风控, so the default here sits at the slow end of that
 * band rather than the fast end. The daily cap matters more than the gap: a
 * burst of hundreds in one sitting is what looks non-human, not the interval.
 */
export const UNFOLLOW_PRESET = {
  ...DEFAULT_CONFIG,
  buckets: [
    { name: 'fresh', to: 0.3, keep: 0.95 },
    { name: 'normal', to: 0.7, keep: 0.5 },
    { name: 'stale', to: 1.0, keep: 0.35 },
  ],
  maxPerRun: 30,
  maxPerDay: 150,
  minGapMs: 8000,
  maxGapMs: 20000,
  protectSpecial: true,
  protectMutual: true,
};

/**
 * Favourite cleanup: recoverable, so it may run wider and faster.
 *
 * A deletion can be undone (the aid is logged, and /x/v3/fav/resource/deal puts
 * it back), which is the whole reason this preset is allowed to be more
 * aggressive than the unfollow one. Still batched and still capped, because a
 * thousand deletions in one minute is a pattern regardless of how recoverable
 * it is.
 */
export const FAVORITE_PRESET = {
  ...DEFAULT_CONFIG,
  buckets: [
    { name: 'fresh', to: 0.3, keep: 0.9 },
    { name: 'normal', to: 0.7, keep: 0.45 },
    { name: 'stale', to: 1.0, keep: 0.25 },
  ],
  maxPerRun: 100,
  maxPerDay: 400,
  minGapMs: 2500,
  maxGapMs: 6000,
  dropInvalid: true,
};

/**
 * Age in days between two instants.
 *
 * An unparseable timestamp returns 0, which places the item at the "fresh" end
 * of the timeline. That is deliberate: this project deletes things, so a row we
 * cannot date must be protected, never quietly treated as ancient and removed.
 */
/**
 * Parse a timestamp to milliseconds, or NaN when it is not a usable instant.
 *
 * `null`, `undefined` and `""` are rejected explicitly because `new Date(null)`
 * is NOT invalid -- it is the 1970 epoch, which would make a row with a missing
 * timestamp look ~20,000 days old and get purged as ancient. For the same reason
 * an exact 0 is rejected: the API uses 0 to mean "not set", and no real Bilibili
 * timestamp is anywhere near the epoch.
 */
function toMillis(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return NaN;
    // A bare number is unix seconds -- what the API returns. It must not reach
    // `new Date`, because new Date('0') silently means the year 2000.
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      return seconds > 0 ? seconds * 1000 : NaN;
    }
  }
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(millis) || millis === 0) return NaN;
  return millis;
}

/**
 * Age in days between two instants.
 *
 * An unparseable or missing timestamp returns 0, which places the item at the
 * "fresh" end of the timeline. That is deliberate: this project deletes things,
 * so a row we cannot date must be protected, never treated as ancient.
 */
export function daysBetween(from, to) {
  const start = toMillis(from);
  const end = toMillis(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, (end - start) / 86400000);
}

/**
 * Never-drop rules for followings, as a predicate the sampler understands.
 *
 * `special` is 特别关注 and `mutual` is 互相关注; both are relationships the user
 * deliberately maintains, so losing them to a batch run would be the worst kind
 * of surprise. Row shape is the normalised followings row produced by bili.js.
 */
export function followingsProtection(options = {}) {
  const { special = true, mutual = true, extra = [] } = options;
  const allowed = new Set(extra.map(String));
  return (item) => {
    const row = item?.raw ?? item ?? {};
    if (allowed.has(String(item?.id ?? row.mid ?? ''))) return true;
    if (special && row.special) return true;
    if (mutual && row.mutual) return true;
    return false;
  };
}

/** Never-drop rules for favourites: already-dead entries plus an explicit list. */
export function favoritesProtection(options = {}) {
  const { extra = [] } = options;
  const allowed = new Set(extra.map(String));
  return (item) => allowed.has(String(item?.id ?? ''));
}

/** Turn raw API rows into the { id, ageDays, label } shape the sampler wants. */
export function fromFollowings(rows, now = new Date()) {
  return rows.map((row) => ({
    id: String(row.mid),
    label: row.uname,
    ageDays: daysBetween(new Date(row.mtime * 1000), now),
    raw: row,
  }));
}

export function fromFavorites(rows, now = new Date()) {
  return rows.map((row) => ({
    id: String(row.id),
    label: row.title,
    ageDays: daysBetween(new Date((row.favTime ?? row.fav_time) * 1000), now),
    raw: row,
  }));
}

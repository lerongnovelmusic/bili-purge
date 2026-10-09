/**
 * Proportion-based, age-weighted selection for batch unfollow / favourite purge.
 *
 * The ruler for "how stale is this?" is derived from the data itself. No
 * absolute day counts appear anywhere in this module.
 *
 * Two rulers are supported, and they are NOT equivalent:
 *
 *   quantile  Buckets hold a fixed SHARE OF ITEMS: the youngest 30%, the next
 *             40%, the oldest 30%. Every bucket always has members, so the
 *             outcome is stable no matter how the ages are distributed. This is
 *             what reproduces an intent like "3 recent, 4 middling, 3 ancient
 *             -> keep 3 / 2 / 1".
 *
 *   span      Buckets are fixed POSITIONS INSIDE THE AGE RANGE min..max. This is
 *             the literal reading of "proportion of the time span", but a single
 *             very old follow stretches the range and can drag middling items
 *             into the fresh bucket.
 *
 * Both are seeded, so a plan can be printed, reviewed, and only then executed.
 */

const DEFAULT_TAU = 0.35;

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

/**
 * Deterministic PRNG (mulberry32) so the same seed replays the same plan.
 * @param {number} seed
 * @returns {() => number} generator yielding [0, 1)
 */
export function makeRng(seed = 1) {
  assertFiniteNumber(seed, 'seed');
  let state = (Math.trunc(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Position of every item on the observed timeline, 0 = youngest, 1 = oldest.
 *
 * In `quantile` mode this is the RANK position, which ignores the actual gaps
 * between ages and therefore ignores outliers.
 * In `span` mode this is the LINEAR position inside min..max.
 *
 * @param {Array<{ageDays: number}>} items
 * @param {'quantile'|'span'} mode
 * @returns {number[]} position per item, in the input order
 */
export function timelinePositions(items, mode) {
  const n = items.length;
  const positions = new Array(n).fill(0);
  if (n === 0) return positions;

  const ages = items.map((item) => {
    assertFiniteNumber(item?.ageDays, 'item.ageDays');
    if (item.ageDays < 0) throw new RangeError(`item.ageDays must be >= 0, got ${item.ageDays}`);
    return item.ageDays;
  });

  if (mode === 'span') {
    const min = Math.min(...ages);
    const max = Math.max(...ages);
    const span = max - min;
    // A zero span means every item is equally stale; they all sit at position 0
    // and therefore land in the first bucket.
    if (span === 0) return positions;
    return ages.map((age) => (age - min) / span);
  }

  if (n === 1) return positions;
  const order = ages.map((_, index) => index).sort((a, b) => ages[a] - ages[b]);
  order.forEach((index, rank) => {
    positions[index] = rank / (n - 1);
  });
  return positions;
}

/**
 * Validate a bucket ladder. Buckets are half-open [previous, to), ascending,
 * and the last one must close the timeline at 1.
 */
export function validateConfig(config) {
  if (config === null || typeof config !== 'object') throw new TypeError('config must be an object');
  const { buckets, mode, tau, seed } = config;

  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError('buckets must be a non-empty array');
  }
  if (mode !== 'quantile' && mode !== 'span') {
    throw new TypeError(`mode must be "quantile" or "span", got ${String(mode)}`);
  }
  assertFiniteNumber(tau, 'tau');
  if (tau <= 0) throw new RangeError(`tau must be > 0, got ${tau}`);
  assertFiniteNumber(seed, 'seed');

  let previous = 0;
  buckets.forEach((bucket, index) => {
    const label = `buckets[${index}]`;
    if (typeof bucket?.name !== 'string' || bucket.name === '') {
      throw new TypeError(`${label}.name must be a non-empty string`);
    }
    assertFiniteNumber(bucket.to, `${label}.to`);
    assertFiniteNumber(bucket.keep, `${label}.keep`);
    if (!(bucket.to > previous)) {
      throw new RangeError(`${label}.to must ascend strictly: ${bucket.to} after ${previous}`);
    }
    if (bucket.keep < 0 || bucket.keep > 1) {
      throw new RangeError(`${label}.keep must be within [0, 1], got ${bucket.keep}`);
    }
    if (bucket.capDays !== undefined) {
      assertFiniteNumber(bucket.capDays, `${label}.capDays`);
      if (bucket.capDays <= 0) throw new RangeError(`${label}.capDays must be > 0, got ${bucket.capDays}`);
    }
    previous = bucket.to;
  });

  const last = buckets[buckets.length - 1];
  if (Math.abs(last.to - 1) > 1e-9) {
    throw new RangeError(`the last bucket must close the timeline at to = 1, got ${last.to}`);
  }
}

/**
 * Weighted sampling without replacement, via the Efraimidis-Spirakis trick:
 * keep the k largest keys ln(U)/w. Using the log form avoids the overflow of
 * U^(1/w) and preserves the same ordering, since ln is monotonic on (0, 1).
 *
 * @param {number[]} weights  keep-preference per candidate, > 0 to be eligible
 * @param {number} k          how many to keep
 * @param {() => number} rng
 * @returns {number[]} indices of the kept candidates, ascending
 */
export function weightedSampleIndices(weights, k, rng) {
  if (k <= 0) return [];
  if (k >= weights.length) return weights.map((_, index) => index);

  const keyed = weights.map((weight, index) => {
    const roll = Math.max(rng(), Number.EPSILON);
    // A non-positive weight means "never keep this one".
    const key = weight > 0 ? Math.log(roll) / weight : -Infinity;
    return { index, key };
  });

  keyed.sort((a, b) => (b.key - a.key) || (a.index - b.index));
  return keyed.slice(0, k).map((entry) => entry.index).sort((a, b) => a - b);
}

/**
 * Decide what to keep and what to drop for one batch run.
 *
 * Weight is a pure function of age, so nothing accumulates between runs: the
 * "reset after every batch" requirement holds by construction, with no stored
 * state to clear.
 *
 * @param {Array<{id: string, ageDays: number, label?: string}>} items
 * @param {object} config  see validateConfig
 * @returns {{keep: object[], drop: object[], buckets: object[], mode: string, seed: number}}
 */
export function plan(items, config) {
  validateConfig(config);
  if (!Array.isArray(items)) throw new TypeError('items must be an array');

  const { buckets, mode, tau, seed } = config;
  const positions = timelinePositions(items, mode);
  const rng = makeRng(seed);

  const isProtected = typeof config.isProtected === 'function' ? config.isProtected : () => false;

  /**
   * Which bucket an item belongs to.
   *
   * The position on the timeline picks the bucket first. Then an optional
   * absolute `capDays` on a bucket can push the item into a later one, so the
   * relative ruler never protects something merely because this account is old
   * overall. The final bucket never pushes further, so every item lands
   * somewhere.
   */
  function bucketIndexFor(position, ageDays) {
    let index = 0;
    while (index < buckets.length - 1 && position >= buckets[index].to) index += 1;
    while (index < buckets.length - 1) {
      const cap = buckets[index].capDays;
      if (cap === undefined || ageDays <= cap) break;
      index += 1;
    }
    return index;
  }

  const grouped = buckets.map(() => []);
  items.forEach((item, index) => {
    const position = positions[index];
    grouped[bucketIndexFor(position, item.ageDays)].push({
      item,
      position,
      protected: Boolean(isProtected(item)),
    });
  });

  const keep = [];
  const drop = [];
  const summary = [];

  buckets.forEach((bucket, bucketIndex) => {
    const members = grouped[bucketIndex];

    const total = members.length;
    const protectedMembers = members.filter((member) => member.protected);
    const freeMembers = members.filter((member) => !member.protected);

    // A protected item is never dropped, so it consumes part of the bucket's
    // quota rather than being added on top of it.
    const keepTarget = Math.max(Math.round(total * bucket.keep), protectedMembers.length);
    const freeKeep = Math.min(Math.max(0, keepTarget - protectedMembers.length), freeMembers.length);

    // Younger members of the same bucket are likelier to survive: weight decays
    // with position along the timeline. tau scales how strongly.
    const weights = freeMembers.map((member) => Math.exp(-member.position / tau));
    const chosen = new Set(weightedSampleIndices(weights, freeKeep, rng));

    freeMembers.forEach((member, index) => {
      (chosen.has(index) ? keep : drop).push(member.item);
    });
    for (const member of protectedMembers) keep.push(member.item);

    const ages = members.map((member) => member.item.ageDays);
    const kept = protectedMembers.length + freeKeep;
    summary.push({
      name: bucket.name,
      total,
      keep: kept,
      dropped: total - kept,
      protected: protectedMembers.length,
      capDays: bucket.capDays ?? null,
      minAgeDays: ages.length ? Math.min(...ages) : null,
      maxAgeDays: ages.length ? Math.max(...ages) : null,
    });
  });

  drop.sort((a, b) => b.ageDays - a.ageDays);
  return { keep, drop, buckets: summary, mode, seed };
}

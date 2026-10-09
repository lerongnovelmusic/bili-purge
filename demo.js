/**
 * Side-by-side comparison of the two timeline rulers on a realistic account.
 *
 * Run: node demo.js
 *
 * A long-lived Bilibili account has a heavily skewed follow history: a small
 * cluster of recent follows on top of a long tail of very old ones. That skew is
 * exactly where the two rulers disagree.
 */
import { plan } from './src/sampler.js';
import { DEFAULT_CONFIG } from './src/config.js';

/** A plausible shape: a thin recent cluster over a fat ancient tail. */
const AGES = [
  1, 4, 9, 16, 25, 38, 54, 76, 104, 140,          // 10 recent
  190, 250, 320, 400, 495, 600, 720, 860, 1010, 1180, // 10 middling
  1360, 1560, 1780, 2020, 2280, 2560, 2860, 3180, 3520, 3880, // 10 ancient
  4100, 4400, 4700, 5000, 5300, 5600, 6000,       // 7 very ancient
];

const items = AGES.map((ageDays, index) => ({
  id: `up${String(index + 1).padStart(2, '0')}`,
  label: `UP ${index + 1}`,
  ageDays,
}));

const SEED = 20260101;

function render(mode) {
  const result = plan(items, { ...DEFAULT_CONFIG, mode, seed: SEED });

  console.log(`\nmode = ${mode}`);
  console.log('  bucket    items   keep   drop   age range (days)');
  for (const bucket of result.buckets) {
    const range = bucket.total === 0
      ? '--'
      : `${bucket.minAgeDays} .. ${bucket.maxAgeDays}`;
    console.log(
      `  ${bucket.name.padEnd(9)} ${String(bucket.total).padStart(5)}`
      + ` ${String(bucket.keep).padStart(6)} ${String(bucket.dropped).padStart(6)}   ${range}`,
    );
  }

  const oldest = result.drop[0];
  const newest = result.drop[result.drop.length - 1];
  console.log(
    `  -> ${result.drop.length}/${items.length} dropped`
    + (result.drop.length ? `, spanning ${newest.ageDays}d (newest) .. ${oldest.ageDays}d (oldest)` : ''),
  );
  return result;
}

console.log(`population: ${items.length} follows, ages ${AGES[0]} .. ${AGES[AGES.length - 1]} days`);
console.log('buckets are shares of the timeline, never absolute day cut-offs');

const quantile = render('quantile');
const span = render('span');

console.log('\nwhere they disagree');
for (let index = 0; index < quantile.buckets.length; index += 1) {
  const a = quantile.buckets[index];
  const b = span.buckets[index];
  console.log(`  ${a.name.padEnd(9)} quantile ${String(a.total).padStart(3)} items`
    + `   |   span ${String(b.total).padStart(3)} items`);
}

const quantileDrops = new Set(quantile.drop.map((item) => item.id));
const onlySpan = span.drop.filter((item) => !quantileDrops.has(item.id));
console.log(`\nspan mode additionally discards ${onlySpan.length} item(s) `
  + 'that quantile mode would have protected:');
console.log(`  ${onlySpan.map((item) => `${item.id}(${item.ageDays}d)`).join(', ') || 'none'}`);

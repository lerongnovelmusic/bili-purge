/**
 * Rendering for review. Everything here is read-only output: no network, no
 * mutation, no secrets.
 */
import { plan } from './sampler.js';
import { daysBetween } from './config.js';

/** Followings rows -> sampler items. */
export function followingsToItems(rows, now = new Date()) {
  return rows.map((row) => ({
    id: String(row.mid),
    label: row.uname || `mid ${row.mid}`,
    ageDays: daysBetween(new Date(row.mtime * 1000), now),
    raw: row,
  }));
}

/** Favourite rows -> sampler items. */
export function favoritesToItems(rows, now = new Date()) {
  return rows.map((row) => ({
    id: String(row.id),
    label: row.title || `aid ${row.id}`,
    ageDays: daysBetween(new Date((row.favTime ?? row.fav_time) * 1000), now),
    raw: row,
  }));
}

function padRight(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

/** One-line-per-bucket summary plus the removal list. */
export function renderPlan(result, options = {}) {
  const { title = 'plan', listLimit = 20 } = options;
  const lines = [];

  lines.push('');
  lines.push(title);
  lines.push(`  mode=${result.mode}  seed=${result.seed}  (buckets are timeline shares, never day cut-offs)`);
  lines.push(`  ${padRight('bucket', 10)}${padLeft('items', 6)}${padLeft('keep', 6)}${padLeft('drop', 6)}${padLeft('cap', 7)}   age range (days)`);

  for (const bucket of result.buckets) {
    const range = bucket.total === 0
      ? '--'
      : `${Math.round(bucket.minAgeDays)} .. ${Math.round(bucket.maxAgeDays)}`;
    const cap = bucket.capDays === null || bucket.capDays === undefined ? '-' : String(bucket.capDays);
    lines.push(`  ${padRight(bucket.name, 10)}${padLeft(bucket.total, 6)}`
      + `${padLeft(bucket.keep, 6)}${padLeft(bucket.dropped, 6)}${padLeft(cap, 7)}   ${range}`);
  }

  const total = result.keep.length + result.drop.length;
  lines.push(`  -> keep ${result.keep.length}, remove ${result.drop.length} of ${total}`);

  // listLimit 0 means "show the summary only" -- the caller renders the list.
  if (result.drop.length > 0 && listLimit > 0) {
    const listed = result.drop.slice(0, listLimit);
    lines.push('');
    lines.push(`  would be removed (oldest first, ${listed.length} of ${result.drop.length}):`);
    for (const item of listed) {
      lines.push(`    ${padLeft(Math.round(item.ageDays), 6)}d  ${padRight(item.id, 12)} ${item.label}`);
    }
    if (result.drop.length > listed.length) {
      lines.push(`    ... and ${result.drop.length - listed.length} more`);
    }
  }

  return lines.join('\n');
}

/** Rebuild a plan straight from normalised snapshot rows. */
export function planFromRows(rows, kind, config, now = new Date()) {
  const items = kind === 'favorites' ? favoritesToItems(rows, now) : followingsToItems(rows, now);
  return { items, result: plan(items, config) };
}

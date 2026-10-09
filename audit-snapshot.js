#!/usr/bin/env node
/**
 * Audit a saved snapshot before anything is ever written.
 *
 * Answers the questions that matter before a destructive run:
 *   - what is the actual age distribution?
 *   - what age range does each bucket really cover?
 *   - would any 特别关注 / 互相关注 be caught in the blast radius?
 *   - what does an absolute cap on "fresh" do to the outcome?
 *
 *   node audit-snapshot.js                          newest followings snapshot
 *   node audit-snapshot.js --cap=365                re-run with a fresh cap
 *   node audit-snapshot.js --caps=90,365,none       choose the comparison set
 *   node audit-snapshot.js --cap=365 --dump=r.txt   write the list for review
 *
 * Read-only: this reads a JSON file, it never touches the network.
 */
import fs from 'node:fs';
import path from 'node:path';

import { UNFOLLOW_PRESET, followingsProtection } from './src/config.js';
import { followingsToItems } from './src/report.js';
import { plan } from './src/sampler.js';

const SNAPSHOT_DIR = 'snapshots';

function newestSnapshot(kind) {
  if (!fs.existsSync(SNAPSHOT_DIR)) throw new Error(`no ${SNAPSHOT_DIR}/ directory yet -- run --followings first`);
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter((name) => name.startsWith(kind) && name.endsWith('.json'))
    .map((name) => path.join(SNAPSHOT_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error(`no ${kind}*.json in ${SNAPSHOT_DIR}/`);
  return files[0];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

const round = (value) => (value === null || value === undefined ? null : Math.round(value));

/** Build the bucket ladder for a run, optionally capping the fresh bucket. */
function bucketsFor(preset, cap) {
  return preset.buckets.map((bucket, index) => (
    index === 0 && cap !== null && Number.isFinite(cap) ? { ...bucket, capDays: cap } : bucket
  ));
}

function parseArgs(argv) {
  const read = (name, fallback) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  const capRaw = read('cap', null);
  const capsRaw = read('caps', null);
  const parseCap = (value) => (value.trim() === 'none' ? Infinity : Number(value.trim()));

  return {
    file: argv.find((arg) => !arg.startsWith('--')) ?? null,
    cap: capRaw === null ? null : parseCap(capRaw),
    caps: capsRaw === null
      ? [90, 180, 365, 730, Infinity]
      : capsRaw.split(',').map(parseCap),
    dump: read('dump', null),
  };
}

function padRight(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const file = options.file ?? newestSnapshot('followings');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = snapshot.items ?? [];

  console.log(`snapshot: ${file}`);
  console.log(`  taken ${snapshot.fetchedAt}   fetched ${snapshot.fetched} of ${snapshot.reportedTotal ?? '?'}`);
  console.log(`  complete: ${snapshot.complete}`);

  if (rows.length === 0) {
    console.log('\nnothing to audit.');
    return;
  }

  const now = new Date(snapshot.fetchedAt);
  const items = followingsToItems(rows, now);
  const ages = items.map((item) => item.ageDays).sort((a, b) => a - b);

  // ---------------------------------------------------------- distribution
  console.log('\nage distribution (days)');
  const marks = [0.1, 0.25, 0.5, 0.75, 0.9];
  console.log(`  min ${round(ages[0])}   `
    + `${marks.map((p) => `p${p * 100}=${round(percentile(ages, p))}`).join('   ')}   max ${round(ages[ages.length - 1])}`);

  const within = (days) => items.filter((item) => item.ageDays <= days).length;
  console.log('  follows within  30d/90d/180d/365d/730d: '
    + `${within(30)}/${within(90)}/${within(180)}/${within(365)}/${within(730)}`);

  const special = items.filter((item) => item.raw?.special);
  const mutual = items.filter((item) => item.raw?.mutual);
  console.log(`  special (特别关注): ${special.length}   mutual (互相关注): ${mutual.length}`);

  // ------------------------------------------------------------- main plan
  const preset = UNFOLLOW_PRESET;
  const protection = followingsProtection({
    special: preset.protectSpecial,
    mutual: preset.protectMutual,
  });

  const buckets = bucketsFor(preset, options.cap);
  const capLabel = options.cap === null ? 'relative only' : (Number.isFinite(options.cap) ? `${options.cap}d` : 'none');
  const guarded = plan(items, { ...preset, buckets, isProtected: protection });
  const bare = plan(items, preset);

  console.log('');
  console.log(`plan (mode=${guarded.mode} seed=${guarded.seed} fresh cap=${capLabel})`);
  console.log('  bucket     items  protect  keep  drop   cap     age range (days)');
  for (const bucket of guarded.buckets) {
    const range = bucket.total === 0 ? '--' : `${round(bucket.minAgeDays)} .. ${round(bucket.maxAgeDays)}`;
    const cap = bucket.capDays === null ? '-' : String(bucket.capDays);
    console.log(`  ${padRight(bucket.name, 10)}${padLeft(bucket.total, 5)}`
      + `${padLeft(bucket.protected, 8)}${padLeft(bucket.keep, 6)}${padLeft(bucket.dropped, 6)}`
      + `${padLeft(cap, 7)}   ${range}`);
  }
  const removalPercent = ((guarded.drop.length / items.length) * 100).toFixed(1);
  console.log(`  -> keep ${guarded.keep.length}, remove ${guarded.drop.length} of ${items.length} (${removalPercent}%)`);

  // ---------------------------------------------------------- safety checks
  const guardedDrops = new Set(guarded.drop.map((item) => item.id));
  const bareDrops = new Set(bare.drop.map((item) => item.id));

  const leakedSpecial = special.filter((item) => guardedDrops.has(item.id));
  const leakedMutual = mutual.filter((item) => guardedDrops.has(item.id));

  // Only count protected items that protection actually saved. A naive
  // set-difference against the unprotected run is misleading: removing the
  // protected entries from the pool reshuffles which FREE members get picked,
  // so the symmetric difference is far larger than the number truly rescued.
  const protectedItems = items.filter((item) => protection(item));
  const rescued = protectedItems.filter((item) => bareDrops.has(item.id));

  console.log('\nsafety checks');
  const say = (ok, text) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
  say(leakedSpecial.length === 0, `no 特别关注 in the removal set (checked ${special.length})`);
  say(leakedMutual.length === 0, `no 互相关注 in the removal set (checked ${mutual.length})`);
  say(guarded.keep.length + guarded.drop.length === items.length, 'every item is accounted for exactly once');
  say(rescued.length <= protectedItems.length, 'the rescue count is bounded by the protected set');
  console.log(`  ${protectedItems.length} protected; ${rescued.length} of them would have gone without the guard`);

  // -------------------------------------------------------- cap comparison
  // The relative ruler protects the youngest N% BY RANK. On an account whose
  // history is mostly ancient, that can mean protecting follows that are years
  // old. A cap re-imposes an absolute meaning on "fresh".
  console.log('\neffect of an absolute cap on the "fresh" bucket');
  console.log('  cap      fresh items   fresh age range    kept   removed   removed%');
  for (const cap of options.caps) {
    const result = plan(items, { ...preset, buckets: bucketsFor(preset, cap), isProtected: protection });
    const fresh = result.buckets[0];
    const range = fresh.total === 0 ? '--' : `${round(fresh.minAgeDays)} .. ${round(fresh.maxAgeDays)}`;
    const label = Number.isFinite(cap) ? `${cap}d` : 'none';
    const percent = ((result.drop.length / items.length) * 100).toFixed(1);
    console.log(`  ${padRight(label, 9)}${padLeft(fresh.total, 9)}   ${padRight(range, 18)}`
      + `${padLeft(result.keep.length, 6)}${padLeft(result.drop.length, 10)}${padLeft(`${percent}%`, 10)}`);
  }
  console.log('\n  "none" is the pure relative ruler: the youngest 30% by rank is "fresh"');
  console.log('  no matter how old it actually is. A cap is how you say "fresh must also');
  console.log('  mean recent". Both are one config line.');

  // ---------------------------------------------------------------- dump
  if (options.dump) {
    const lines = [];
    lines.push(`# unfollow review`);
    lines.push(`# source        ${file}`);
    lines.push(`# generated     ${new Date().toISOString()}`);
    lines.push(`# mode          ${guarded.mode}   seed ${guarded.seed}   fresh cap ${capLabel}`);
    lines.push(`# population    ${items.length} follows`);
    lines.push(`# outcome       keep ${guarded.keep.length}, remove ${guarded.drop.length} (${removalPercent}%)`);
    lines.push(`# protected     ${protectedItems.length} (特别关注 ${special.length}, 互相关注 ${mutual.length})`);
    lines.push('#');
    lines.push('# Nothing has been changed. This is a preview.');
    lines.push('');
    lines.push(`## WOULD BE REMOVED (${guarded.drop.length}), oldest first`);
    lines.push(`${padLeft('age_days', 8)}  ${padLeft('mid', 16)}  name`);
    for (const item of guarded.drop) {
      lines.push(`${padLeft(round(item.ageDays), 8)}  ${padLeft(item.id, 16)}  ${item.label}`);
    }
    lines.push('');
    lines.push(`## PROTECTED AND KEPT (${protectedItems.length})`);
    lines.push(`${padLeft('age_days', 8)}  ${padLeft('mid', 16)}  name   [reason]`);
    for (const item of protectedItems) {
      const reasons = [];
      if (item.raw?.special) reasons.push('特别关注');
      if (item.raw?.mutual) reasons.push('互相关注');
      lines.push(`${padLeft(round(item.ageDays), 8)}  ${padLeft(item.id, 16)}  ${item.label}   [${reasons.join(' ')}]`);
    }

    fs.writeFileSync(options.dump, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\nwrote ${options.dump} (${guarded.drop.length} removals, ${protectedItems.length} protected)`);
  }
}

main();

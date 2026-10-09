#!/usr/bin/env node
/**
 * Batch-remove entries from one favourite folder.
 *
 *   node fetch-snapshot.js --folders                    find the media id
 *   node fetch-snapshot.js --folder 60971020            snapshot that folder
 *   node purge-favorites.js --cap=365                   preview (safe)
 *   node purge-favorites.js --cap=365 --limit=20 --execute --confirm=XXXXXXXX
 *
 * Same safety model as unfollow.js: dry run by default, a token that can only
 * confirm the plan that was printed, a per-run and per-day cap, an audit log,
 * and an abort on any risk-control refusal. Deletions are recoverable via
 * restore-favorites.js, which is why the caps here are wider than unfollowing's.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadCredentials, describeCredentials, cookieHeader, CredentialsError } from './src/auth.js';
import { createClient, BiliApiError, RISK_CONTROL_CODES } from './src/http.js';
import { removeFavoriteBatch } from './src/actions.js';
import { FAVORITE_PRESET } from './src/config.js';
import { buildFavoriteRun, favoriteDeadReason } from './src/run.js';
import { renderPlan } from './src/report.js';
import { runMain } from './src/cli.js';
import { localDateKey, usedOn } from './src/quota.js';

const LOG_DIR = 'logs';
const ACTION = 'favorites';

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const takesValue = new Set([
    'cap', 'limit', 'seed', 'mode', 'keep', 'snapshot', 'confirm',
    'log-dir', 'daily-cap', 'folder', 'batch-size',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (!takesValue.has(name)) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++index];
    if (name === 'keep') {
      values.keep = [...(values.keep ?? []), ...String(value).split(',').map((v) => v.trim()).filter(Boolean)];
    } else if (['cap', 'limit', 'seed', 'daily-cap', 'batch-size'].includes(name)) {
      values[name] = Number(value);
    } else {
      values[name] = String(value);
    }
  }
  return { values, flags };
}

/**
 * Read a snapshot, or null if it cannot be parsed.
 *
 * A snapshot can be truncated (the fetch was killed mid-write) or hand-edited
 * into invalid JSON. One bad file must not hide the good ones, so callers skip
 * null rather than letting the parse error escape.
 */
function readSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Favourite snapshots, newest first. */
export function favoriteSnapshots(dir = 'snapshots') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('fav-') && name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
}

export function pickSnapshot(folderFilter, dir = 'snapshots') {
  const files = favoriteSnapshots(dir);
  if (files.length === 0) {
    throw new Error('no favourite snapshots -- run: node fetch-snapshot.js --folders, then --folder <mediaId>');
  }
  if (folderFilter === undefined || folderFilter === null || folderFilter === '') return files[0];

  // Compare as strings. A snapshot stores mediaId as a string (it comes from the
  // command line), while the filter arrives as whatever the user typed, so a
  // strict number comparison would never match.
  const wanted = String(folderFilter).trim();
  const match = files.find((file) => {
    const data = readSnapshot(file);
    return data !== null && String(data.mediaId ?? '').trim() === wanted;
  });

  if (!match) {
    throw new Error(`no snapshot for folder ${folderFilter}. Snapshots on disk:\n  `
      + files.map((file) => {
        const data = readSnapshot(file);
        return data === null
          ? `${file}  (unreadable -- not valid JSON)`
          : `${file}  (${data.title}, ${data.fetched} entries)`;
      }).join('\n  '));
  }
  return match;
}

function padLeft(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const executing = flags.has('execute');

  const cap = values.cap === undefined ? 365 : (Number.isFinite(values.cap) ? values.cap : null);
  const limit = values.limit ?? null;
  const batchSize = Number.isFinite(values['batch-size']) ? values['batch-size'] : 20;

  const credentials = loadCredentials();
  console.log('credentials');
  for (const line of describeCredentials(credentials)) console.log(line);

  if (!credentials.ok) {
    for (const problem of credentials.problems) console.error(`  problem: ${problem}`);
    process.exitCode = 2;
    return;
  }
  if (executing && !credentials.writable) {
    console.error('\n--execute needs biliJct (the CSRF token).');
    process.exitCode = 2;
    return;
  }

  const snapshotFile = values.snapshot ?? pickSnapshot(values.folder);
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const mediaId = snapshot.mediaId;

  console.log(`\nsnapshot: ${snapshotFile}`);
  console.log(`  folder "${snapshot.title}" (media ${mediaId}), `
    + `${snapshot.fetched} entries, taken ${snapshot.fetchedAt}`);
  if (snapshot.invalidCount !== undefined) console.log(`  flagged as dead: ${snapshot.invalidCount}`);
  if (snapshot.partial) {
    console.log('  WARNING: this snapshot was fetched with --limit-pages, so it is PARTIAL.');
  }
  // Derived from the counts rather than trusting a `complete` field, so that
  // snapshots written before that field existed are still judged correctly.
  const expected = snapshot.reportedCount;
  if (typeof expected === 'number' && snapshot.fetched < expected) {
    console.log(`  WARNING: snapshot is INCOMPLETE -- ${snapshot.fetched} entries but the API reported ${expected}.`);
    console.log('  The listing stopped early, so the ruler is ranking a subset as if it were the whole folder.');
    console.log(`  Re-fetch with: node fetch-snapshot.js --folder ${snapshot.mediaId}`);
  }

  // ---------------------------------------------------------- daily quota
  const logDir = values['log-dir'] ?? LOG_DIR;
  const dailyCap = Number.isFinite(values['daily-cap']) ? values['daily-cap'] : FAVORITE_PRESET.maxPerDay;
  const today = localDateKey(new Date());
  const used = usedOn(logDir, today, { action: ACTION });
  const remaining = Math.max(0, dailyCap - used);
  const perRun = limit ?? FAVORITE_PRESET.maxPerRun;
  const effectiveLimit = Math.min(perRun, remaining);

  console.log(`daily quota: ${used}/${dailyCap} deleted today -- ${remaining} left`);

  if (remaining === 0) {
    console.log('\nDaily quota already reached. Nothing was attempted.');
    console.log('Come back tomorrow, or raise it deliberately with --daily-cap=N.');
    return;
  }
  if (effectiveLimit < perRun) {
    console.log(`  this run is trimmed to ${effectiveLimit} by the remaining daily quota`);
  }

  const run = buildFavoriteRun({
    rows: snapshot.items ?? [],
    cap,
    seed: values.seed ?? FAVORITE_PRESET.seed,
    mode: values.mode ?? FAVORITE_PRESET.mode,
    keep: values.keep ?? [],
    limit: effectiveLimit,
    now: new Date(snapshot.fetchedAt),
  });

  const capLabel = Number.isFinite(cap) ? `${cap}d` : 'none';
  const batches = chunk(run.actions, batchSize);
  console.log(`\nwhitelisted ids: ${(values.keep ?? []).length}`);
  console.log(`pacing: ${FAVORITE_PRESET.minGapMs / 1000}-${FAVORITE_PRESET.maxGapMs / 1000}s between requests, `
    + `max ${perRun}/run, max ${dailyCap}/day, ${batchSize}/request`);
  console.log(renderPlan(run.result, {
    title: `favourite purge plan (fresh cap ${capLabel}, this run deletes ${run.actions.length})`,
    listLimit: 0,
  }));

  if (run.actions.length === 0) {
    console.log('\nnothing to do.');
    return;
  }

  console.log(`\nthis run would delete ${run.actions.length} of ${run.result.drop.length} planned removals `
    + `in ${batches.length} request(s):`);
  for (const item of run.actions.slice(0, 40)) {
    // Show WHY an entry was flagged rather than a bare "[dead]". The reason is
    // recomputed here, so a stale snapshot flag cannot mislabel a live entry.
    const reason = favoriteDeadReason(item);
    const flag = reason === null ? '' : `  [${reason}]`;
    console.log(`  ${padLeft(Math.round(item.ageDays), 5)}d  ${padLeft(item.id, 12)}  ${item.label}${flag}`);
  }
  if (run.actions.length > 40) console.log(`  ... and ${run.actions.length - 40} more`);

  if (!executing) {
    console.log('\nDRY RUN -- nothing has been changed.');
    console.log('To execute exactly this list:');
    console.log(`  node purge-favorites.js --folder=${mediaId} --cap=${capLabel.replace('d', '')}`
      + (limit === null ? '' : ` --limit=${limit}`)
      + ((values.keep ?? []).length ? ` --keep=${values.keep.join(',')}` : '')
      + ` --execute --confirm=${run.token}`);
    return;
  }

  if (values.confirm !== run.token) {
    console.error('\nconfirm token mismatch.');
    console.error(`  expected: ${run.token}`);
    console.error(`  given:    ${values.confirm ?? '(none)'}`);
    console.error('Re-run the dry run and copy the token it prints.');
    process.exitCode = 3;
    return;
  }

  // ------------------------------------------------------------- executing
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `favorites-${stamp()}.jsonl`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'header',
    action: ACTION,
    token: run.token,
    mediaId,
    folderTitle: snapshot.title,
    cap: capLabel,
    mode: values.mode ?? FAVORITE_PRESET.mode,
    seed: values.seed ?? FAVORITE_PRESET.seed,
    planned: run.actions.length,
    snapshot: snapshotFile,
  })}\n`);

  const client = createClient({
    cookie: cookieHeader(credentials),
    minGapMs: FAVORITE_PRESET.minGapMs,
    maxGapMs: FAVORITE_PRESET.maxGapMs,
    log: (message) => console.log(message),
  });

  console.log(`\ndeleting ${run.actions.length} entr(ies) in ${batches.length} request(s); log: ${logFile}`);
  let ok = 0;
  let failed = 0;
  let aborted = false;

  for (const [index, batch] of batches.entries()) {
    const position = `[${index + 1}/${batches.length}]`;
    const label = batch.length === 1 ? batch[0].label : `${batch.length} entries`;
    try {
      await removeFavoriteBatch(client, { mediaId, resources: batch, csrf: credentials.biliJct });
      ok += batch.length;
      console.log(`  ${position} OK    ${label}`);
      for (const item of batch) {
        log.write(`${JSON.stringify({
          ts: new Date().toISOString(), action: ACTION, mediaId,
          id: item.id, type: Number(item.raw?.type ?? 0), bvid: item.raw?.bvid ?? '',
          title: item.label, ageDays: Math.round(item.ageDays), ok: true,
        })}\n`);
      }
    } catch (error) {
      failed += batch.length;
      const code = error instanceof BiliApiError ? error.code : 'unknown';
      const message = error instanceof BiliApiError ? error.apiMessage : String(error?.message ?? error);
      console.log(`  ${position} FAIL  ${label}  code=${code} ${message}`);

      // A failed batch may still have deleted some of its members -- the API
      // does not report per-resource results reliably. Such entries are logged
      // as failures so restore does not blindly re-add something still present.
      for (const item of batch) {
        log.write(`${JSON.stringify({
          ts: new Date().toISOString(), action: ACTION, mediaId,
          id: item.id, type: Number(item.raw?.type ?? 0), bvid: item.raw?.bvid ?? '',
          title: item.label, ageDays: Math.round(item.ageDays), ok: false, code, message,
        })}\n`);
      }

      if (RISK_CONTROL_CODES.has(code)) {
        console.log(`\nABORTING: the API refused with a risk-control code (${code}).`);
        console.log('Nothing else was attempted. Do not retry today.');
        aborted = true;
        break;
      }
    }
  }

  log.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'summary', ok, failed, aborted })}\n`);
  log.end();

  console.log(`\ndone: ${ok} deleted, ${failed} failed`);
  console.log(`log: ${logFile}`);
  console.log(`undo with: node restore-favorites.js --log=${logFile} --execute --confirm=<token>`);

  const stats = client.stats;
  console.log(`requests: ${stats.requestCount}, retries: ${stats.retryCount}`);
}

runMain(import.meta.url, main, {
  onCredentialsError: (error) => {
    if (!(error instanceof CredentialsError)) return false;
    console.error(`credentials problem:\n  ${error.message}`);
    process.exitCode = 2;
    return true;
  },
});

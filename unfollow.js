#!/usr/bin/env node
/**
 * The only script here that changes your account.
 *
 * It is a DRY RUN unless you pass --execute with the token that the dry run
 * printed. The token is derived from the exact action list, so it cannot be
 * copied from one plan and used for another.
 *
 *   node unfollow.js --cap=365                      preview (safe)
 *   node unfollow.js --cap=365 --limit=5 --execute --confirm=XXXXXXXX
 *
 * Safety rules baked in:
 *   - 特别关注 / 互相关注 / whitelisted mids are never touched
 *   - a per-run cap, and a slower random gap than any read operation
 *   - the oldest entries go first, so a trial batch starts with the safest ones
 *   - a risk-control refusal ABORTS the run instead of retrying harder
 *   - every attempt is appended to a JSONL log that refollow.js can replay
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadCredentials, describeCredentials, cookieHeader, CredentialsError } from './src/auth.js';
import { createClient, BiliApiError, RISK_CONTROL_CODES } from './src/http.js';
import { unfollow } from './src/actions.js';
import { UNFOLLOW_PRESET } from './src/config.js';
import { buildUnfollowRun } from './src/run.js';
import { renderPlan } from './src/report.js';
import { runMain } from './src/cli.js';
import { localDateKey, usedOn, usageByDay } from './src/quota.js';

const LOG_DIR = 'logs';

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const takesValue = new Set(['cap', 'limit', 'seed', 'mode', 'keep', 'snapshot', 'confirm', 'log-dir', 'daily-cap']);

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
    } else if (['cap', 'limit', 'seed', 'daily-cap'].includes(name)) {
      values[name] = Number(value);
    } else {
      values[name] = String(value);
    }
  }
  return { values, flags };
}

function newestFollowingsSnapshot() {
  if (!fs.existsSync('snapshots')) throw new Error('no snapshots/ directory -- run: node fetch-snapshot.js --followings');
  const files = fs.readdirSync('snapshots')
    .filter((name) => name.startsWith('followings') && name.endsWith('.json'))
    .map((name) => path.join('snapshots', name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error('no followings snapshot -- run: node fetch-snapshot.js --followings');
  return files[0];
}

function padLeft(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const executing = flags.has('execute');

  const cap = values.cap === undefined ? 365 : (Number.isFinite(values.cap) ? values.cap : null);
  const limit = values.limit ?? null;

  const credentials = loadCredentials();
  console.log('credentials');
  for (const line of describeCredentials(credentials)) console.log(line);

  if (!credentials.ok) {
    for (const problem of credentials.problems) console.error(`  problem: ${problem}`);
    process.exitCode = 2;
    return;
  }
  if (executing && !credentials.writable) {
    console.error('\n--execute needs biliJct (the CSRF token). Add it to the credentials file.');
    process.exitCode = 2;
    return;
  }

  const snapshotFile = values.snapshot ?? newestFollowingsSnapshot();
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));

  // ---------------------------------------------------------- daily quota
  // The count is re-derived from the logs rather than kept in a counter, so it
  // can never drift from what actually happened.
  const logDir = values['log-dir'] ?? LOG_DIR;
  const dailyCap = Number.isFinite(values['daily-cap']) ? values['daily-cap'] : UNFOLLOW_PRESET.maxPerDay;
  const today = localDateKey(new Date());
  const used = usedOn(logDir, today);
  const remaining = Math.max(0, dailyCap - used);
  const perRun = limit ?? UNFOLLOW_PRESET.maxPerRun;
  const effectiveLimit = Math.min(perRun, remaining);

  console.log(`\nsnapshot: ${snapshotFile}  (${snapshot.fetched} follows, taken ${snapshot.fetchedAt})`);
  console.log(`daily quota: ${used}/${dailyCap} used today -- ${remaining} left`);

  if (remaining === 0) {
    console.log('\nDaily quota already reached. Nothing was attempted.');
    console.log('This cap is the main thing keeping the account under the radar --');
    console.log('a burst of hundreds in one sitting is what looks non-human.');
    console.log('Come back tomorrow, or raise it deliberately with --daily-cap=N.');
    return;
  }

  if (effectiveLimit < perRun) {
    console.log(`  this run is trimmed to ${effectiveLimit} by the remaining daily quota`);
  }

  const run = buildUnfollowRun({
    rows: snapshot.items ?? [],
    cap,
    seed: values.seed ?? UNFOLLOW_PRESET.seed,
    mode: values.mode ?? UNFOLLOW_PRESET.mode,
    keep: values.keep ?? [],
    limit: effectiveLimit,
    now: new Date(snapshot.fetchedAt),
  });

  const capLabel = Number.isFinite(cap) ? `${cap}d` : 'none';
  console.log(`\nwhitelisted mids: ${(values.keep ?? []).length}`);
  console.log(`pacing: ${UNFOLLOW_PRESET.minGapMs / 1000}-${UNFOLLOW_PRESET.maxGapMs / 1000}s between requests, `
    + `max ${perRun}/run, max ${dailyCap}/day`);
  console.log(renderPlan(run.result, {
    title: `unfollow plan (fresh cap ${capLabel}, this run actions ${run.actions.length})`,
    listLimit: 0,
  }));

  if (run.actions.length === 0) {
    console.log('\nnothing to do.');
    return;
  }

  console.log(`\nthis run would action ${run.actions.length} of ${run.result.drop.length} planned removals `
    + '(oldest first):');
  for (const item of run.actions) {
    console.log(`  ${padLeft(Math.round(item.ageDays), 5)}d  ${padLeft(item.id, 16)}  ${item.label}`);
  }

  if (!executing) {
    console.log('\nDRY RUN -- nothing has been changed.');
    console.log('To execute exactly this list:');
    console.log(`  node unfollow.js --cap=${capLabel.replace('d', '')}`
      + (limit === null ? '' : ` --limit=${limit}`)
      + ((values.keep ?? []).length ? ` --keep=${values.keep.join(',')}` : '')
      + ` --execute --confirm=${run.token}`);
    return;
  }

  if (values.confirm !== run.token) {
    console.error(`\nconfirm token mismatch.`);
    console.error(`  expected: ${run.token}`);
    console.error(`  given:    ${values.confirm ?? '(none)'}`);
    console.error('Re-run the dry run and copy the token it prints.');
    process.exitCode = 3;
    return;
  }

  // ------------------------------------------------------------- executing
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `unfollow-${stamp()}.jsonl`);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'header',
    token: run.token,
    cap: capLabel,
    mode: run.mode ?? UNFOLLOW_PRESET.mode,
    seed: values.seed ?? UNFOLLOW_PRESET.seed,
    planned: run.actions.length,
    snapshot: snapshotFile,
  })}\n`);

  const client = createClient({
    cookie: cookieHeader(credentials),
    minGapMs: UNFOLLOW_PRESET.minGapMs,
    maxGapMs: UNFOLLOW_PRESET.maxGapMs,
    log: (message) => console.log(message),
  });

  console.log(`\nexecuting ${run.actions.length} unfollow(s); log: ${logFile}`);
  let ok = 0;
  let failed = 0;

  for (const [index, item] of run.actions.entries()) {
    const position = `[${index + 1}/${run.actions.length}]`;
    try {
      await unfollow(client, { fid: item.id, csrf: credentials.biliJct });
      ok += 1;
      console.log(`  ${position} OK    ${item.label} (${item.id})`);
      log.write(`${JSON.stringify({ ts: new Date().toISOString(), action: 'unfollow', mid: item.id, uname: item.label, ageDays: Math.round(item.ageDays), ok: true })}\n`);
    } catch (error) {
      failed += 1;
      const code = error instanceof BiliApiError ? error.code : 'unknown';
      const message = error instanceof BiliApiError ? error.apiMessage : String(error?.message ?? error);
      console.log(`  ${position} FAIL  ${item.label} (${item.id})  code=${code} ${message}`);
      log.write(`${JSON.stringify({ ts: new Date().toISOString(), action: 'unfollow', mid: item.id, uname: item.label, ageDays: Math.round(item.ageDays), ok: false, code, message })}\n`);

      if (RISK_CONTROL_CODES.has(code)) {
        console.log(`\nABORTING: the API refused with a risk-control code (${code}).`);
        console.log('Nothing else was attempted. Wait a while before trying again;');
        console.log('a smaller --limit is the right response, not a retry loop.');
        break;
      }
    }
  }

  log.write(`${JSON.stringify({ ts: new Date().toISOString(), kind: 'summary', ok, failed })}\n`);
  log.end();

  console.log(`\ndone: ${ok} succeeded, ${failed} failed`);
  console.log(`log: ${logFile}`);
  console.log(`undo with: node refollow.js --log=${logFile} --execute --confirm=<token>`);

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
